use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use tauri::ipc::Channel;

// Shared HTTP client. Rebuilding per `http_ping` defeats reqwest's connection
// pool; the preview pill polls on a short interval, so each call would pay
// the TLS handshake cost.
static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(ssrf_redirect_policy())
            .build()
            .expect("http_ping client init")
    })
}

/// Re-applies the metadata and link-local block on every redirect hop.
/// `reject_metadata_ssrf` only vets the initial URL, but reqwest follows 3xx
/// responses by default, so a public URL could otherwise redirect into the
/// blocked address space and slip past the guard. The redirect callback is
/// synchronous (no DNS), so it rejects blocked IP literals and the known
/// metadata hostnames; a redirect to a hostname that later resolves into the
/// range is still followed, which is strictly narrower than the previous
/// behavior. Retains reqwest's default limit of ten hops.
pub(crate) fn ssrf_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if redirect_host_blocked(attempt.url()) {
            attempt.error("blocked: redirect to link-local / cloud-metadata address")
        } else if attempt.previous().len() >= 10 {
            attempt.error("too many redirects")
        } else {
            attempt.follow()
        }
    })
}

/// True for the IPv4/IPv6 link-local ranges (169.254.0.0/16 and fe80::/10,
/// including IPv4-mapped IPv6). This is the SSRF-sensitive range that fronts the
/// cloud instance metadata service. Defined once so the redirect guard and the
/// initial-URL guard cannot drift.
fn ip_is_link_local(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_link_local(),
        std::net::IpAddr::V6(v6) => {
            (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6.to_ipv4().map(|m| m.is_link_local()).unwrap_or(false)
        }
    }
}

/// True for the cloud-metadata hostnames that resolve into the link-local range.
/// Expects an already-lowercased host.
fn is_metadata_hostname(host: &str) -> bool {
    host == "metadata.google.internal" || host == "metadata"
}

fn redirect_host_blocked(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(v4)) => ip_is_link_local(std::net::IpAddr::V4(v4)),
        Some(url::Host::Ipv6(v6)) => ip_is_link_local(std::net::IpAddr::V6(v6)),
        Some(url::Host::Domain(d)) => is_metadata_hostname(&d.to_ascii_lowercase()),
        None => false,
    }
}

/// Rejects requests aimed at the cloud instance metadata service or the
/// IPv4/IPv6 link-local ranges, the classic SSRF target used to steal cloud
/// credentials. The URL host is resolved first so a hostname pointing into that
/// space is caught as well. Loopback (localhost dev servers) and private LAN
/// ranges stay allowed, so the preview and local-AI features keep working. The
/// AI tools and extensions can reach this over raw IPC, so the guard lives in
/// the backend rather than the webview.
pub(crate) async fn reject_metadata_ssrf(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "invalid url".to_string())?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("blocked: unsupported url scheme '{scheme}'"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "url has no host".to_string())?
        .to_string();
    let host_l = host.to_ascii_lowercase();
    // These hostnames resolve into the metadata range; refuse them by name too.
    if is_metadata_hostname(&host_l) {
        return Err("blocked: cloud metadata endpoint".to_string());
    }
    let port = parsed.port_or_known_default().unwrap_or(443);
    // DNS resolution blocks; run it off the async runtime, then inspect every
    // candidate address. IP literals resolve to themselves (no DNS lookup).
    let ips = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        (host.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.map(|a| a.ip()).collect::<Vec<std::net::IpAddr>>())
    })
    .await
    .map_err(|e| format!("dns task failed: {e}"))?
    .map_err(|e| format!("dns resolve failed: {e}"))?;
    for ip in ips {
        if ip_is_link_local(ip) {
            return Err("blocked: link-local / cloud-metadata address".to_string());
        }
    }
    Ok(())
}

/// Only covers a host that silently drops packets; loopback answers or refuses
/// immediately.
const PORT_PROBE_TIMEOUT: Duration = Duration::from_millis(600);

/// Whether something is listening on `url`'s host and port. A TCP connect only:
/// no request, no TLS handshake.
///
/// Not `http_ping`: reqwest is built with rustls and its bundled roots, so a
/// Laragon/Herd vhost's self-signed cert fails the handshake and a live server
/// reads as dead - while the browser pane, on the OS store, loads it fine.
///
/// Loopback only. Every resolved address must be loopback, which keeps this
/// from being a port scanner over IPC and confirms what the hosts file claims.
#[tauri::command]
pub async fn port_is_open(url: String) -> Result<bool, String> {
    let parsed = url::Url::parse(&url).map_err(|_| "invalid url".to_string())?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!("blocked: unsupported url scheme '{scheme}'"));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "url has no host".to_string())?
        .to_string();
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "url has no port".to_string())?;
    // DNS resolution blocks; run it off the async runtime. IP literals resolve
    // to themselves without a lookup.
    let addrs = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        (host.as_str(), port)
            .to_socket_addrs()
            .map(|it| it.collect::<Vec<std::net::SocketAddr>>())
    })
    .await
    .map_err(|e| format!("dns task failed: {e}"))?
    .map_err(|e| format!("dns resolve failed: {e}"))?;
    if addrs.is_empty() {
        return Err("dns returned no address".to_string());
    }
    // Every candidate: a name resolving to both loopback and a routable address
    // must not be probed at all.
    if let Some(bad) = addrs.iter().find(|a| !a.ip().is_loopback()) {
        return Err(format!("blocked: {} is not a loopback address", bad.ip()));
    }
    for addr in addrs {
        // `localhost` resolves to both ::1 and 127.0.0.1 while a server may bind
        // only one, so a refusal on the first is not an answer.
        if let Ok(Ok(_)) =
            tokio::time::timeout(PORT_PROBE_TIMEOUT, tokio::net::TcpStream::connect(addr)).await
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[tauri::command]
pub async fn http_ping(url: String, auth: Option<String>) -> Result<u16, String> {
    reject_metadata_ssrf(&url).await?;
    let mut req = client().get(&url);
    if let Some(token) = auth.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        req = req.bearer_auth(token);
    }
    req.send()
        .await
        .map(|r| r.status().as_u16())
        .map_err(|e| e.to_string())
}

// --- Streaming HTTP proxy ---------------------------------------------------
// The WebView's native `fetch` enforces CORS, so a cross-origin call to a
// self-hosted OpenAI-compatible gateway (e.g. 9Router reached over a Tailscale
// tunnel) that does not return an `Access-Control-Allow-Origin` header for the
// app origin is blocked by the WebView before JS can read it - surfacing as a
// bare "Failed to fetch" with no HTTP status. reqwest runs in the native HTTP
// stack, not the WebView, so it is not subject to browser CORS. `http_stream`
// proxies one request and streams the response body back over an IPC `Channel`
// so the frontend can rebuild a streaming `Response` (SSE chat keeps its
// token-by-token rendering). `http_abort` cancels an in-flight stream by id.

// Separate client for streaming: NO overall timeout (an SSE chat response can
// run for minutes), only a connect timeout so an unreachable host still fails
// fast instead of hanging.
static STREAM_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn stream_client() -> &'static reqwest::Client {
    STREAM_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .redirect(ssrf_redirect_policy())
            .build()
            .expect("http_stream client init")
    })
}

// In-flight streams keyed by a frontend-supplied id so `http_abort` can wake
// the matching request's cancellation waiter.
static CANCELS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Notify>>>> = OnceLock::new();

fn cancels() -> &'static Mutex<HashMap<String, Arc<tokio::sync::Notify>>> {
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StreamEvent {
    // First event: response status + (filtered) headers.
    Meta {
        status: u16,
        headers: Vec<(String, String)>,
    },
    // A slice of the response body, base64-encoded (a JSON channel message
    // cannot carry raw bytes inline).
    Chunk {
        data: String,
    },
    // Terminal error. May arrive before `Meta` when the request never connected.
    Error {
        message: String,
    },
    // The body has been fully streamed.
    End,
}

#[tauri::command]
pub async fn http_stream(
    id: String,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let notify = Arc::new(tokio::sync::Notify::new());
    cancels().lock().unwrap().insert(id.clone(), notify.clone());

    let result = run_stream(&method, &url, headers, body, &on_event, &notify).await;

    cancels().lock().unwrap().remove(&id);

    if let Err(message) = result {
        // Surface the failure through the channel; ignore a send error (the
        // frontend may have already torn the channel down on abort).
        let _ = on_event.send(StreamEvent::Error { message });
    }
    // Always Ok: errors are reported via the `Error` event so the JS side has a
    // single place to handle them.
    Ok(())
}

async fn run_stream(
    method: &str,
    url: &str,
    headers: Vec<(String, String)>,
    body: Option<String>,
    on_event: &Channel<StreamEvent>,
    notify: &tokio::sync::Notify,
) -> Result<(), String> {
    reject_metadata_ssrf(url).await?;
    let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| e.to_string())?;
    let mut req = stream_client().request(method, url);
    for (name, value) in headers {
        req = req.header(name, value);
    }
    if let Some(body) = body {
        req = req.body(body);
    }

    // Cancel-aware send: abort even before the response headers arrive.
    let mut resp = tokio::select! {
        _ = notify.notified() => return Ok(()),
        r = req.send() => r.map_err(|e| e.to_string())?,
    };

    let status = resp.status().as_u16();
    let mut out_headers: Vec<(String, String)> = Vec::new();
    for (name, value) in resp.headers() {
        // Drop hop-by-hop / framing headers: the body is re-streamed, so the
        // original Content-Length / encoding no longer applies and would make
        // the rebuilt Response inconsistent.
        let lname = name.as_str().to_ascii_lowercase();
        if matches!(
            lname.as_str(),
            "content-length" | "content-encoding" | "transfer-encoding" | "connection"
        ) {
            continue;
        }
        if let Ok(v) = value.to_str() {
            out_headers.push((name.as_str().to_string(), v.to_string()));
        }
    }
    on_event
        .send(StreamEvent::Meta {
            status,
            headers: out_headers,
        })
        .map_err(|e| e.to_string())?;

    // Idle timeout: kill a gateway that connects then stalls mid-body. It resets
    // on every received chunk, so a legitimately slow but live SSE stream (long
    // gaps between tokens) is unaffected; only a truly dead connection trips it.
    const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
    loop {
        tokio::select! {
            _ = notify.notified() => break,
            chunk = tokio::time::timeout(IDLE_TIMEOUT, resp.chunk()) => match chunk {
                Err(_elapsed) => return Err("upstream stalled (idle timeout)".to_string()),
                Ok(Ok(Some(bytes))) => {
                    if bytes.is_empty() {
                        continue;
                    }
                    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    if on_event.send(StreamEvent::Chunk { data }).is_err() {
                        // Frontend stopped listening; stop pulling upstream.
                        break;
                    }
                }
                Ok(Ok(None)) => break,
                Ok(Err(e)) => return Err(e.to_string()),
            },
        }
    }

    let _ = on_event.send(StreamEvent::End);
    Ok(())
}

#[tauri::command]
pub fn http_abort(id: String) {
    if let Some(notify) = cancels().lock().unwrap().get(&id) {
        notify.notify_one();
    }
}
