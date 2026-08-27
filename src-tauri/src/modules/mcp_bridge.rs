//! The local-socket bridge an outside AI CLI reaches TEDI through.
//!
//! WHY THIS EXISTS. Until now the only way into a running TEDI was the WebView2
//! DevTools Protocol: `scripts/mcp/server.mjs` opened a WebSocket to a debug
//! port and evaluated JavaScript against `window.__tedi`. That worked, and it
//! cost five separate things:
//!
//!   * **Windows only.** `--remote-debugging-port` is appended in
//!     `preview::apply_webview2_browser_args_env`, which is `#[cfg(windows)]`.
//!     The `__TEDI_AUTOMATION__` flag was not, so on macOS and Linux the button
//!     worked, the indicator lit, and no port ever opened.
//!   * **One client.** A CDP page target accepts exactly one debugger. A second
//!     CLI did not queue - it wedged the first.
//!   * **No authentication.** CDP has none. Any process on the machine that
//!     could reach the port got `Runtime.evaluate`, and through it
//!     `__TAURI_INTERNALS__.invoke` - including `secrets_get_all`.
//!   * **A restart to turn on.** WebView2 fixes its browser arguments before the
//!     first webview exists, so the port could only ever change at launch.
//!   * **A third protocol implementation**, because nothing in-process could
//!     answer, so the whole surface had to be re-expressed as injected JS.
//!
//! A local socket fixes all five. It is a named pipe on Windows and a unix
//! socket elsewhere - the same primitive the PTY daemon already uses, with the
//! same per-user isolation - so there is no port, no firewall prompt, and the OS
//! enforces who may connect before a single byte is read.
//!
//! WHAT IT DOES NOT REPLACE. Real keyboard and mouse input, and window capture,
//! still need CDP: `Input.dispatchKeyEvent` produces a TRUSTED event and a
//! synthetic DOM event is not the same thing. Those five tools (`keys`,
//! `type_text`, `click`, `drag`, `screenshot`) and the `eval_js` escape hatch are
//! the `misc` pack, which is switchable and off-able on its own. Everything else
//! - state, reads, shell, settings, extensions, ssh, browser, the built-in agent
//! - comes through here.
//!
//! HOW A CALL FLOWS. The handlers live in the webview, because that is where the
//! capabilities are (`src/modules/automation/bridge.ts`). Rust owns the socket
//! and the correlation:
//!
//!   client --(json line)--> [socket] --(tedi://bridge-call)--> webview
//!   client <--(json line)-- [socket] <--(mcp_bridge_reply)---- webview
//!
//! One `oneshot` per in-flight call, keyed by id in `PENDING`. A reply for an
//! unknown id is dropped rather than trusted, and a call the webview never
//! answers times out instead of parking the connection forever.

use std::collections::HashMap;
use std::io::Write as _;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::modules::ids::{app_data_dir, BUNDLE_ID};

/// Event the webview listens on. One per call.
const CALL_EVENT: &str = "tedi://bridge-call";

/// How long a single capability call may take before the socket answers with an
/// error. Generous, because `sh` legitimately waits on a command - but finite,
/// because a wedged webview must not hold a client's request open forever, which
/// is exactly what the CDP path did (it had no timeout at all).
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

/// A request from a connected client.
#[derive(Deserialize)]
struct BridgeRequest {
    id: u64,
    /// Capability name, as registered in `modules/automation/bridge.ts`.
    name: String,
    #[serde(default)]
    args: Vec<serde_json::Value>,
}

/// What the webview sends back through `mcp_bridge_reply`.
#[derive(Deserialize, Serialize, Clone)]
pub struct BridgeReply {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// In-flight calls, keyed by the id the webview echoes back.
static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<BridgeReply>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, oneshot::Sender<BridgeReply>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The shared secret a client must present. Generated once per app run: a
/// restart invalidates every old handle, and nothing is ever persisted across
/// runs that could be replayed.
static TOKEN: OnceLock<String> = OnceLock::new();

fn token() -> &'static str {
    TOKEN.get_or_init(|| Uuid::new_v4().simple().to_string())
}

/// Where `server.mjs` looks to find the socket and the token.
///
/// Beside `tedi-settings.json`, which the server already reads for the pack
/// switches, so it needs no new way to locate anything.
fn handshake_path() -> Option<PathBuf> {
    app_data_dir().map(|d| d.join(BUNDLE_ID).join("mcp-bridge.json"))
}

/// Socket address, per user and per profile, matching the PTY daemon's scheme.
#[cfg(unix)]
fn socket_path() -> PathBuf {
    let suffix = if cfg!(debug_assertions) { "-dev" } else { "" };
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join(format!("tedi-mcp{suffix}.sock"));
    }
    let tmp = std::env::var_os("TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
    tmp.join(format!("tedi-mcp-{user}{suffix}.sock"))
}

#[cfg(windows)]
fn socket_name() -> String {
    let suffix = if cfg!(debug_assertions) { "-dev" } else { "" };
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
    let mut h: u32 = 0x811c_9dc5;
    for &b in user.as_bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("tedi-mcp-{h:08x}{suffix}")
}

/// Address string written into the handshake file for the client to use.
fn socket_address() -> String {
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\{}", socket_name())
    }
    #[cfg(unix)]
    {
        socket_path().to_string_lossy().into_owned()
    }
}

fn bind() -> std::io::Result<interprocess::local_socket::tokio::Listener> {
    use interprocess::local_socket::ListenerOptions;
    #[cfg(unix)]
    {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        let path = socket_path();
        // A leftover file from a crashed run would make `bind` fail with
        // AddrInUse forever. Removing it is safe: if a live TEDI still owns it,
        // this process is a second instance and single-instance forwarding has
        // already handed off.
        let _ = std::fs::remove_file(&path);
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let name = path.as_path().to_fs_name::<GenericFilePath>()?;
        let listener = ListenerOptions::new().name(name).create_tokio()?;
        // Owner-only. On unix the filesystem IS the access control, so this line
        // is what makes the token a second factor rather than the only one.
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        Ok(listener)
    }
    #[cfg(windows)]
    {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        let name_str = socket_name();
        let name = name_str.as_str().to_ns_name::<GenericNamespaced>()?;
        ListenerOptions::new().name(name).create_tokio()
    }
}

/// Publish the socket address + token so a client can find them.
///
/// Written 0600 on unix. On Windows the file inherits the user profile's ACL,
/// which is the same protection `tedi-settings.json` beside it already relies on.
fn write_handshake() {
    let Some(path) = handshake_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let body = serde_json::json!({ "socket": socket_address(), "token": token() });
    let Ok(mut f) = std::fs::File::create(&path) else {
        return;
    };
    let _ = f.write_all(body.to_string().as_bytes());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
}

/// Remove the handshake file. Called on exit so a stale token cannot outlive the
/// run that issued it and mislead the next client into a connect that hangs.
pub fn cleanup() {
    if let Some(p) = handshake_path() {
        let _ = std::fs::remove_file(p);
    }
    #[cfg(unix)]
    {
        let _ = std::fs::remove_file(socket_path());
    }
}

/// Start listening. Idempotent; failures are logged, never fatal - an app that
/// cannot open the bridge must still run.
pub fn start(app: AppHandle) {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let listener = match bind() {
            Ok(l) => l,
            Err(e) => {
                log::warn!("mcp bridge: cannot bind ({e}); external MCP clients cannot connect");
                return;
            }
        };
        write_handshake();
        log::info!("mcp bridge listening on {}", socket_address());
        use interprocess::local_socket::traits::tokio::Listener as _;
        loop {
            match listener.accept().await {
                Ok(stream) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = serve(app, stream).await {
                            log::debug!("mcp bridge client ended: {e}");
                        }
                    });
                }
                Err(e) => {
                    log::warn!("mcp bridge accept failed: {e}");
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
            }
        }
    });
}

/// One client connection: authenticate, then serve newline-delimited JSON.
async fn serve(
    app: AppHandle,
    stream: interprocess::local_socket::tokio::Stream,
) -> std::io::Result<()> {
    use interprocess::local_socket::traits::tokio::Stream as _;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let (rx, mut tx) = stream.split();
    let mut lines = BufReader::new(rx).lines();

    // First frame is the handshake. Anything else - including a well-formed
    // request - is refused, so a client that never read the token cannot get a
    // single capability call in before being disconnected.
    let Some(first) = lines.next_line().await? else {
        return Ok(());
    };
    let presented = serde_json::from_str::<serde_json::Value>(&first)
        .ok()
        .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(str::to_owned))
        .unwrap_or_default();
    // Constant-time-ish: compare full length, not a short-circuit prefix. The
    // token is a v4 UUID over a local socket, so this is belt-and-braces.
    let ok = presented.len() == token().len()
        && presented
            .bytes()
            .zip(token().bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0;
    if !ok {
        let _ = tx
            .write_all(b"{\"ok\":false,\"error\":\"bad token\"}\n")
            .await;
        return Ok(());
    }
    tx.write_all(b"{\"ok\":true}\n").await?;

    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let req: BridgeRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let msg = serde_json::json!({ "id": 0, "ok": false, "error": format!("bad request: {e}") });
                tx.write_all(format!("{msg}\n").as_bytes()).await?;
                continue;
            }
        };
        let reply = call_webview(&app, &req.name, req.args).await;
        let out = serde_json::json!({
            "id": req.id,
            "ok": reply.ok,
            "result": reply.result,
            "error": reply.error,
        });
        tx.write_all(format!("{out}\n").as_bytes()).await?;
    }
    Ok(())
}

/// Ask the webview to run one capability and wait for its answer.
async fn call_webview(app: &AppHandle, name: &str, args: Vec<serde_json::Value>) -> BridgeReply {
    let Some(window) = app.get_webview_window("main") else {
        return BridgeReply {
            ok: false,
            result: None,
            error: Some("TEDI's main window is not open".into()),
        };
    };
    let call_id = Uuid::new_v4().simple().to_string();
    let (send, recv) = oneshot::channel();
    pending().lock().unwrap().insert(call_id.clone(), send);

    let payload = serde_json::json!({ "callId": call_id, "name": name, "args": args });
    if window.emit(CALL_EVENT, payload).is_err() {
        pending().lock().unwrap().remove(&call_id);
        return BridgeReply {
            ok: false,
            result: None,
            error: Some("could not reach TEDI's window".into()),
        };
    }

    match tokio::time::timeout(CALL_TIMEOUT, recv).await {
        Ok(Ok(reply)) => reply,
        // Dropped sender: the entry was taken by a reply that then failed to
        // send, which cannot normally happen. Treat as a failure, not a hang.
        Ok(Err(_)) => BridgeReply {
            ok: false,
            result: None,
            error: Some(format!("\"{name}\" was cancelled before it answered")),
        },
        Err(_) => {
            pending().lock().unwrap().remove(&call_id);
            BridgeReply {
                ok: false,
                result: None,
                error: Some(format!(
                    "\"{name}\" did not answer within {}s",
                    CALL_TIMEOUT.as_secs()
                )),
            }
        }
    }
}

/// The webview's answer to one `tedi://bridge-call`.
#[tauri::command]
pub fn mcp_bridge_reply(call_id: String, reply: BridgeReply) {
    // Take, don't peek: a duplicate reply for the same id finds nothing and is
    // dropped, rather than racing the first one.
    let sender = pending().lock().unwrap().remove(&call_id);
    if let Some(s) = sender {
        let _ = s.send(reply);
    }
}

/// Where a client should look. Exposed so the Install-MCP flow can show it and
/// `mcp-install-verify` can assert the shape without booting the app.
#[tauri::command]
pub fn mcp_bridge_info() -> serde_json::Value {
    serde_json::json!({
        "socket": socket_address(),
        "handshakeFile": handshake_path().map(|p| p.to_string_lossy().into_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_is_stable_within_a_run() {
        assert_eq!(socket_address(), socket_address());
        assert!(!socket_address().is_empty());
    }

    #[test]
    fn the_token_is_stable_and_not_trivial() {
        assert_eq!(token(), token());
        assert_eq!(token().len(), 32, "a v4 uuid, simple form");
    }

    /// A dev run must not share a socket with an installed release, for the same
    /// reason the PTY daemon does not: they would answer each other's clients.
    #[test]
    fn debug_builds_get_their_own_socket() {
        let addr = socket_address();
        if cfg!(debug_assertions) {
            assert!(
                addr.contains("-dev"),
                "dev build needs its own socket: {addr}"
            );
        } else {
            assert!(
                !addr.contains("-dev"),
                "release build must not carry the dev suffix"
            );
        }
    }

    #[test]
    fn the_handshake_file_sits_beside_the_settings_file() {
        if let Some(p) = handshake_path() {
            assert!(p.ends_with("mcp-bridge.json"));
            assert!(p.to_string_lossy().contains(BUNDLE_ID));
        }
    }
}
