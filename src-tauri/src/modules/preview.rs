// `tedi-frame://localhost/?u=<base64url>` proxy. Lets the in-app preview iframe
// load any public site by stripping X-Frame-Options / CSP frame-ancestors on
// the way through. Uses Tauri 2's stable async URI-scheme protocol so we don't
// open a localhost port and don't depend on the unstable `add_child` API.
//
// Frontend builds the URL with `convertFileSrc(`?u=${b64}`, "tedi-frame")` so
// Windows (WebView2) gets `http://tedi-frame.localhost/?u=…` and macOS/Linux
// get `tedi-frame://localhost/?u=…`.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::time::Duration;
use tauri::http::{Request, Response, StatusCode};
use tauri::{Builder, Runtime};

pub const SCHEME: &str = "tedi-frame";

const STRIPPED_HEADERS: &[&str] = &[
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",
    "x-content-security-policy",
    "x-webkit-csp",
    // Body is decompressed by reqwest and rewritten - lying about encoding
    // would make the webview try to gunzip plain text.
    "content-encoding",
    "content-length",
    "transfer-encoding",
    // Cross-origin policies that would re-introduce the same iframe block.
    "cross-origin-opener-policy",
    "cross-origin-embedder-policy",
    "cross-origin-resource-policy",
    // Don't let upstream pin HSTS / cookies on our scheme.
    "set-cookie",
    "strict-transport-security",
];

// Mimics desktop Chrome on Windows (same shape as the UA VSCode's Simple
// Browser / Electron sends). Some sites gate content/CSS on UA - presenting as
// a current desktop Chromium gets us the desktop layout instead of a stripped
// mobile/legacy fallback.
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) \
    AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_BODY_BYTES: usize = 25 * 1024 * 1024;

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
    let target = extract_target(&req)?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("client init: {e}"))?;

    let mut rb = client.get(&target);
    // Pass through headers that affect content negotiation without leaking
    // anything sensitive from our app origin.
    for name in ["range", "accept", "accept-language"] {
        if let Some(v) = req.headers().get(name) {
            rb = rb.header(name, v);
        }
    }

    let upstream = rb.send().await.map_err(|e| format!("upstream: {e}"))?;
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let body = upstream.bytes().await.map_err(|e| format!("body: {e}"))?;

    if body.len() > MAX_BODY_BYTES {
        return Err(format!(
            "response too large ({} bytes; cap {})",
            body.len(),
            MAX_BODY_BYTES
        ));
    }

    let content_type = headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    let out_bytes = if content_type.starts_with("text/html") {
        rewrite_html(&body, &target).into_bytes()
    } else {
        body.to_vec()
    };

    let mut builder = Response::builder().status(status.as_u16());
    for (name, value) in headers.iter() {
        let lower = name.as_str().to_ascii_lowercase();
        if STRIPPED_HEADERS.contains(&lower.as_str()) {
            continue;
        }
        builder = builder.header(name.as_str(), value.as_bytes());
    }
    // The webview iframe will be a different origin from any resource it
    // pulls in; broad CORS keeps fonts/XHR-on-static-files working.
    builder = builder.header("access-control-allow-origin", "*");

    builder
        .body(out_bytes)
        .map_err(|e| format!("response build: {e}"))
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

fn rewrite_html(body: &[u8], target_url: &str) -> String {
    let mut html = String::from_utf8_lossy(body).into_owned();
    let inject = build_head_injection(target_url);

    let lower = html.to_ascii_lowercase();
    if let Some(idx) = lower.find("<head") {
        if let Some(close) = lower[idx..].find('>') {
            let pos = idx + close + 1;
            html.insert_str(pos, &inject);
            return html;
        }
    }

    if let Some(idx) = lower.find("<html") {
        if let Some(close) = lower[idx..].find('>') {
            let pos = idx + close + 1;
            html.insert_str(pos, &format!("<head>{}</head>", inject));
            return html;
        }
    }

    format!(
        "<!doctype html><html><head>{}</head><body>{}</body></html>",
        inject, html
    )
}

fn build_head_injection(target_url: &str) -> String {
    // `<base>` makes subresources resolve to the real origin, so images/CSS/JS
    // load without needing per-asset proxying. Clicks are intercepted by the
    // script below and routed back through us so navigation stays inside the
    // iframe.
    format!(
        "<base href=\"{}\"><script>{}</script>",
        html_escape(target_url),
        CLICK_PROXY_SCRIPT
    )
}

fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

// Routes top-level link clicks and GET form submissions back through the proxy
// so the user can browse without each navigation hitting X-Frame-Options
// again. POST forms and JS-driven navigation (`location.href = ...`) are not
// intercepted - that's where we trade depth for safety/simplicity.
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
    window.location.href = p;
  }, true);
  document.addEventListener('submit', function(e){
    if (e.defaultPrevented) return;
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    // The proxy is GET-only; POST forms must fall through and will likely be
    // blocked by XFO on the destination - acceptable trade-off for now.
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
      // Form-supplied params override any baked into the action URL, matching
      // browser default form-submit behavior.
      url.search = '?' + params.toString();
      if (!/^https?:\/\//i.test(url.href)) return;
      var p = location.origin + '/?u=' + b64(url.href);
      e.preventDefault();
      window.location.href = p;
    } catch (err) { /* fall through to native submit */ }
  }, true);
})();
"#;
