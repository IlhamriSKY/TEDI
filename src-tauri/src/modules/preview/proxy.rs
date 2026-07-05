//! `tedi-frame://localhost/?u=<base64url>` proxy. Lets the in-app preview
//! iframe load any public site by stripping X-Frame-Options / CSP
//! frame-ancestors. Uses Tauri 2's async URI-scheme protocol so no localhost
//! port is opened.
//!
//! Frontend builds the URL via `convertFileSrc(`?u=${b64}`, "tedi-frame")`.
//! Windows (WebView2) sees `http://tedi-frame.localhost/?u=...`; macOS and
//! Linux see `tedi-frame://localhost/?u=...`.
//!
//! Subresource rewrite: stripping CSP/XFO on the HTML response alone only
//! lets the document render. Assets (images, CSS, scripts, fonts) go to the
//! upstream origin and many ship `Cross-Origin-Resource-Policy: same-site`,
//! which the browser enforces against the iframe origin. `lol_html`
//! rewrites every asset reference through us so we can strip those headers too.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use lol_html::{element, html_content::ContentType, HtmlRewriter, Settings};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::http::{Request, Response, StatusCode};
use tauri::{Builder, Runtime};
use url::Url;

use super::util::{html_escape, js_string_literal};

pub const SCHEME: &str = "tedi-frame";

const STRIPPED_HEADERS: &[&str] = &[
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",
    "x-content-security-policy",
    "x-webkit-csp",
    // Body is decompressed by reqwest and rewritten; advertising an encoding
    // would make the webview try to gunzip plain text.
    "content-encoding",
    "content-length",
    "transfer-encoding",
    // Cross-origin policies that would re-introduce the iframe block.
    "cross-origin-opener-policy",
    "cross-origin-embedder-policy",
    "cross-origin-resource-policy",
    // Block upstream from pinning HSTS / cookies on our scheme.
    "set-cookie",
    "strict-transport-security",
];

// Mimic desktop Chrome on Windows (same shape VSCode's Simple Browser /
// Electron sends). Some sites gate content/CSS on UA; a current desktop
// Chromium gets the desktop layout instead of a stripped mobile fallback.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_BODY_BYTES: usize = 25 * 1024 * 1024;

// Shared proxy client. Rebuilding per request defeated reqwest's connection
// pool and re-paid TLS handshake cost on every subresource (a single HTML
// page can fan out to 50+ assets).
static PROXY_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub(super) fn proxy_client() -> &'static reqwest::Client {
    PROXY_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            // Re-check every redirect hop for link-local and metadata hosts so a
            // 3xx cannot bounce the proxy into the blocked range (ten-hop cap).
            .redirect(crate::modules::net::ssrf_redirect_policy())
            .user_agent(USER_AGENT)
            .build()
            .expect("preview proxy client init")
    })
}

pub fn register<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.register_asynchronous_uri_scheme_protocol(SCHEME, |_ctx, req, responder| {
        tauri::async_runtime::spawn(async move {
            let response = match handle(req).await {
                Ok(r) => r,
                Err(e) => error_response(StatusCode::BAD_GATEWAY, &e),
            };
            responder.respond(response);
        });
    })
}

async fn handle(req: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, String> {
    let proxy_origin = derive_proxy_origin(&req);
    let target = extract_target(&req)?;
    // Block SSRF to cloud-metadata / link-local addresses through the proxy.
    crate::modules::net::reject_metadata_ssrf(&target).await?;

    let mut rb = proxy_client().get(&target);
    // Pass through headers that affect content negotiation without leaking
    // anything from our app origin.
    for name in ["range", "accept", "accept-language"] {
        if let Some(v) = req.headers().get(name) {
            rb = rb.header(name, v);
        }
    }

    let mut upstream = rb.send().await.map_err(|e| format!("upstream: {e}"))?;
    let status = upstream.status();
    let headers = upstream.headers().clone();

    // Stream the body so a malicious upstream cannot OOM us before the cap
    // check fires. `bytes()` would buffer the entire response first.
    let mut body: Vec<u8> = Vec::with_capacity(
        headers
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<usize>().ok())
            .map(|n| n.min(MAX_BODY_BYTES))
            .unwrap_or(0),
    );
    while let Some(chunk) = upstream.chunk().await.map_err(|e| format!("body: {e}"))? {
        if body.len().saturating_add(chunk.len()) > MAX_BODY_BYTES {
            return Err(format!(
                "response too large (>{} bytes; cap {})",
                body.len() + chunk.len(),
                MAX_BODY_BYTES
            ));
        }
        body.extend_from_slice(&chunk);
    }

    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    let out_bytes = if content_type.starts_with("text/html") {
        rewrite_html(&body, &target, &proxy_origin)
    } else {
        body
    };

    let mut builder = Response::builder().status(status.as_u16());
    for (name, value) in headers.iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if STRIPPED_HEADERS.contains(&lower.as_str()) {
            continue;
        }
        builder = builder.header(name.as_str(), value.as_bytes());
    }
    // The webview iframe has a different origin from any resource it pulls
    // in; broad CORS keeps fonts and XHR-on-static-files working.
    builder = builder.header("access-control-allow-origin", "*");

    builder
        .body(out_bytes)
        .map_err(|e| format!("response build: {e}"))
}

/// Reconstruct the origin of the incoming request so the HTML rewriter can
/// emit `tedi-frame://localhost/?u=...` (or `http://tedi-frame.localhost/?u=...`
/// on Windows) without hard-coding the platform's scheme.
fn derive_proxy_origin(req: &Request<Vec<u8>>) -> String {
    let uri = req.uri();
    let scheme = uri.scheme_str().unwrap_or(SCHEME);
    let authority = uri.authority().map(|a| a.as_str()).unwrap_or("localhost");
    format!("{}://{}", scheme, authority)
}

fn extract_target(req: &Request<Vec<u8>>) -> Result<String, String> {
    let uri = req.uri();
    let query = uri.query().ok_or_else(|| "missing ?u= query".to_string())?;
    let b64 = query
        .split('&')
        .find_map(|p| p.strip_prefix("u="))
        .ok_or_else(|| "missing u= param".to_string())?;
    let bytes = URL_SAFE_NO_PAD
        .decode(b64.as_bytes())
        .map_err(|e| format!("base64: {e}"))?;
    let url = String::from_utf8(bytes).map_err(|e| format!("utf8: {e}"))?;
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) URLs are allowed".into());
    }
    Ok(url)
}

fn error_response(status: StatusCode, msg: &str) -> Response<Vec<u8>> {
    let body = format!(
        "<!doctype html><meta charset=utf-8><body style=\"font-family:ui-sans-serif,system-ui,sans-serif;padding:24px;color:#b91c1c;background:#fff\">\
            <h3 style=\"margin:0 0 8px\">Preview proxy error</h3>\
            <pre style=\"white-space:pre-wrap;font:12px/1.5 ui-monospace,monospace;background:#fef2f2;padding:12px;border-radius:6px\">{}</pre>\
        </body>",
        html_escape(msg)
    );
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .body(body.into_bytes())
        .expect("static response builds")
}

/// Encode `url` as the proxy URL the iframe should hit. Returns `None` if
/// `raw` does not resolve to an http(s) URL against `base` (e.g. `mailto:`,
/// `javascript:`, fragment-only links, `data:` blobs; those pass through
/// unchanged).
fn proxify(raw: &str, base: &Url, origin: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let abs = base.join(trimmed).ok()?;
    if !matches!(abs.scheme(), "http" | "https") {
        return None;
    }
    let b64 = URL_SAFE_NO_PAD.encode(abs.as_str().as_bytes());
    Some(format!("{}/?u={}", origin, b64))
}

/// Rewrite a `srcset` attribute (`"url 1x, url 2x"` or `"url 320w, url 640w"`)
/// by piping each candidate URL through `proxify` while preserving its
/// descriptor.
fn proxify_srcset(raw: &str, base: &Url, origin: &str) -> String {
    raw.split(',')
        .filter_map(|part| {
            let part = part.trim();
            if part.is_empty() {
                return None;
            }
            let mut iter = part.splitn(2, char::is_whitespace);
            let url = iter.next().unwrap_or("");
            let descriptor = iter.next().unwrap_or("").trim();
            let rewritten = match proxify(url, base, origin) {
                Some(p) => p,
                None => url.to_string(),
            };
            if descriptor.is_empty() {
                Some(rewritten)
            } else {
                Some(format!("{} {}", rewritten, descriptor))
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// `<link rel>` values whose `href` points to a network-loaded subresource.
/// Other rels (`alternate`, `canonical`, `dns-prefetch`, ...) are descriptive
/// metadata the browser does not fetch as a same-site asset.
const PROXIED_LINK_RELS: &[&str] = &[
    "stylesheet",
    "icon",
    "shortcut",
    "apple-touch-icon",
    "apple-touch-icon-precomposed",
    "manifest",
    "preload",
    "modulepreload",
    "prefetch",
    "mask-icon",
];

fn link_needs_proxy(rel: &str) -> bool {
    rel.split_whitespace()
        .any(|r| PROXIED_LINK_RELS.contains(&r.to_ascii_lowercase().as_str()))
}

fn rewrite_html(body: &[u8], target_url: &str, proxy_origin: &str) -> Vec<u8> {
    let target = match Url::parse(target_url) {
        Ok(u) => u,
        Err(_) => return body.to_vec(),
    };

    let head_injection = build_head_injection(target_url);
    let mut output: Vec<u8> = Vec::with_capacity(body.len());

    // Each handler needs its own clone of the base URL and origin because
    // lol_html stores them as `FnMut` and the closures outlive this scope.
    let t_head = target.clone();
    let o_head = proxy_origin.to_string();
    let t_src = target.clone();
    let o_src = proxy_origin.to_string();
    let t_link = target.clone();
    let o_link = proxy_origin.to_string();
    let t_srcset = target.clone();
    let o_srcset = proxy_origin.to_string();
    let t_poster = target.clone();
    let o_poster = proxy_origin.to_string();
    let head_inject_clone = head_injection.clone();

    let element_content_handlers = vec![
        // Inject base and click-proxy at the end of <head> so inline scripts
        // before us see the real document head.
        element!("head", move |el| {
            el.append(&head_inject_clone, ContentType::Html);
            // Suppress unused-capture warning when head doesn't appear.
            let _ = (&t_head, &o_head);
            Ok(())
        }),
        // Strip CSP delivered via `<meta http-equiv>`. The header form is
        // already stripped, but some sites also ship a redundant meta.
        element!("meta", |el| {
            if let Some(v) = el.get_attribute("http-equiv") {
                let lower = v.to_ascii_lowercase();
                if matches!(
                    lower.as_str(),
                    "content-security-policy"
                        | "content-security-policy-report-only"
                        | "x-content-security-policy"
                ) {
                    el.remove();
                }
            }
            Ok(())
        }),
        // Single-URL `src` attributes on all subresource-fetching elements.
        element!(
            "img[src], iframe[src], audio[src], video[src], source[src], track[src], script[src], embed[src]",
            move |el| {
                if let Some(src) = el.get_attribute("src") {
                    if let Some(new) = proxify(&src, &t_src, &o_src) {
                        let _ = el.set_attribute("src", &new);
                    }
                }
                Ok(())
            }
        ),
        // `<link>` is overloaded; only proxy rels that trigger a network
        // fetch (stylesheet, icon, preload, ...). `<a href>` stays direct so
        // clicks go through the injected click handler, not the proxy.
        element!("link[href]", move |el| {
            let rel = el
                .get_attribute("rel")
                .unwrap_or_default()
                .to_ascii_lowercase();
            if link_needs_proxy(&rel) {
                if let Some(href) = el.get_attribute("href") {
                    if let Some(new) = proxify(&href, &t_link, &o_link) {
                        let _ = el.set_attribute("href", &new);
                    }
                }
            }
            Ok(())
        }),
        element!("img[srcset], source[srcset]", move |el| {
            if let Some(s) = el.get_attribute("srcset") {
                let new = proxify_srcset(&s, &t_srcset, &o_srcset);
                let _ = el.set_attribute("srcset", &new);
            }
            Ok(())
        }),
        element!("video[poster]", move |el| {
            if let Some(s) = el.get_attribute("poster") {
                if let Some(new) = proxify(&s, &t_poster, &o_poster) {
                    let _ = el.set_attribute("poster", &new);
                }
            }
            Ok(())
        }),
    ];

    let mut rewriter = HtmlRewriter::new(
        Settings {
            element_content_handlers,
            ..Settings::default()
        },
        |c: &[u8]| output.extend_from_slice(c),
    );

    if rewriter.write(body).is_err() {
        return body.to_vec();
    }
    if rewriter.end().is_err() {
        return body.to_vec();
    }

    // Fallback for documents with no `<head>` element (rare but legal HTML5).
    // Wrap in a synthetic head so the click-proxy and base injection apply.
    if !contains_head(&output) {
        let mut wrapped =
            format!("<!doctype html><html><head>{}</head><body>", head_injection).into_bytes();
        wrapped.extend_from_slice(&output);
        wrapped.extend_from_slice(b"</body></html>");
        return wrapped;
    }

    output
}

fn contains_head(bytes: &[u8]) -> bool {
    // Cheap ASCII scan; only need to know whether `<head` exists anywhere.
    let needle = b"<head";
    bytes
        .windows(needle.len())
        .any(|w| w.eq_ignore_ascii_case(needle))
}

fn build_head_injection(target_url: &str) -> String {
    // `<base>` covers what the rewriter does not catch (CSS `url()` inside
    // inline `<style>`, dynamically created elements). Those go directly to
    // the upstream origin and may hit CORP; the rewriter handles the common
    // cases (`<img>`, `<link>`, `<script>`, `<source>`).
    //
    // The trailing reporter postMessages the real page URL up to the host so
    // the preview address bar + back/forward history can track navigation the
    // same way a browser does. It runs once per loaded document (every link
    // click reloads the iframe through the proxy, so each page reports itself).
    format!(
        "<base href=\"{base}\"><script>{script}</script>\
         <script>(function(){{try{{window.parent.postMessage({{__tediPreview:true,type:'navigated',url:{url}}},'*');}}catch(e){{}}}})();</script>",
        base = html_escape(target_url),
        script = CLICK_PROXY_SCRIPT,
        url = js_string_literal(target_url),
    )
}

// Route top-level link clicks and GET form submissions back through the
// proxy so the user can browse without each navigation hitting
// X-Frame-Options again. POST forms and JS-driven navigation
// (`location.href = ...`) are not intercepted.
const CLICK_PROXY_SCRIPT: &str = r#"
(function(){
  function b64(s){
    return btoa(unescape(encodeURIComponent(s)))
      .replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_');
  }
  function proxify(href){
    try {
      var abs = new URL(href, document.baseURI).href;
      if (!/^https?:\/\//i.test(abs)) return null;
      return location.origin + '/?u=' + b64(abs);
    } catch (e) { return null; }
  }
  function notify(type){
    try { window.parent.postMessage({__tediPreview:true,type:type}, '*'); } catch (e) {}
  }
  document.addEventListener('click', function(e){
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href) return;
    if (href.charAt(0) === '#') return;
    if (/^(javascript|mailto|tel|data|blob):/i.test(href)) return;
    var tgt = a.getAttribute('target');
    if (tgt && tgt !== '_self' && tgt !== '') return;
    var p = proxify(href);
    if (!p) return;
    e.preventDefault();
    notify('navigating');
    window.location.href = p;
  }, true);
  document.addEventListener('submit', function(e){
    if (e.defaultPrevented) return;
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    // Proxy is GET-only; POST forms fall through and will likely be blocked
    // by XFO on the destination.
    var method = (form.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'get') return;
    var tgt = form.getAttribute('target');
    if (tgt && tgt !== '_self' && tgt !== '') return;
    try {
      var action = form.getAttribute('action') || document.baseURI;
      var url = new URL(action, document.baseURI);
      var data = new FormData(form);
      var params = new URLSearchParams();
      data.forEach(function(v, k){
        if (typeof v === 'string') params.append(k, v);
      });
      // Form-supplied params override any baked into the action URL,
      // matching default browser form-submit behavior.
      url.search = '?' + params.toString();
      if (!/^https?:\/\//i.test(url.href)) return;
      var p = location.origin + '/?u=' + b64(url.href);
      e.preventDefault();
      notify('navigating');
      window.location.href = p;
    } catch (err) { /* fall through to native submit */ }
  }, true);
})();
"#;
