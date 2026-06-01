// IPC wire protocol between the GUI's `PtyClient` and the headless
// `--pty-daemon` process. Length-prefixed JSON; see `transport.rs` for
// framing. Keep this file dependency-light: it is the contract shared by
// both sides, so changes break protocol compatibility.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Monotonic client-side request id. Echoed in the matching `DaemonMsg`
/// variants so a client with multiple in-flight requests can correlate
/// responses. Push events (`Data`, `Exit`) have no `req_id`.
pub type ReqId = u64;

/// Protocol version. Bumped on every wire-format change. The daemon rejects
/// clients that announce a mismatched version in the handshake `Hello`.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: Uuid,
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    /// Unix epoch ms when the daemon spawned the shell. Persisted across
    /// detach/attach so the UI can show "running for 17 min".
    pub created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMsg {
    /// First message after socket connect. Negotiates protocol version.
    Hello { req_id: ReqId, version: u32 },
    /// Spawn a fresh PTY at the given size + cwd. Daemon returns a new UUID.
    Open {
        req_id: ReqId,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
    },
    /// Subscribe to push events for an existing session and replay scrollback.
    Attach {
        req_id: ReqId,
        session_id: Uuid,
        /// Resize on attach so the new client's viewport matches the PTY.
        cols: u16,
        rows: u16,
    },
    /// Unsubscribe from push events but keep the session alive on the daemon.
    /// Called when the GUI window closes - sessions persist for next launch.
    Detach { req_id: ReqId, session_id: Uuid },
    /// Forward keyboard input to the PTY.
    Write {
        req_id: ReqId,
        session_id: Uuid,
        data_b64: String,
    },
    /// Forward terminal viewport resize.
    Resize {
        req_id: ReqId,
        session_id: Uuid,
        cols: u16,
        rows: u16,
    },
    /// Permanently kill a session. Used by explicit "close tab" or "kill" UI.
    /// Differs from `Detach` which keeps the shell running.
    Close { req_id: ReqId, session_id: Uuid },
    /// Enumerate every session the daemon currently owns. Used by the GUI on
    /// startup to discover sessions saved before the last window close.
    List { req_id: ReqId },
    /// Kill all sessions. Wired to the "Reset all sessions" settings button.
    KillAll { req_id: ReqId },
    /// Ask the daemon to exit cleanly (used by uninstaller / settings).
    Shutdown { req_id: ReqId },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DaemonMsg {
    /// Reply to `Hello`. If versions don't match the daemon disconnects.
    Welcome {
        req_id: ReqId,
        version: u32,
        daemon_version: String,
    },
    /// Reply to `Open`. Carries the newly minted session id.
    OpenOk { req_id: ReqId, session_id: Uuid },
    /// Reply to `Attach`. `scrollback_b64` is the raw bytes (ANSI included)
    /// the daemon buffered since the session started, capped per
    /// `server::SCROLLBACK_CAP`. `alive=false` means the session has exited
    /// already and the client should display the buffer then stop reading.
    AttachOk {
        req_id: ReqId,
        session_id: Uuid,
        scrollback_b64: String,
        alive: bool,
    },
    /// Generic ack for Write / Resize / Close / Detach / KillAll / Shutdown.
    Ok { req_id: ReqId },
    /// Generic error response. Recoverable - client can decide whether to
    /// retry or fall back (e.g. on "unknown session" → spawn fresh).
    Err { req_id: ReqId, message: String },
    /// Reply to `List`.
    Sessions {
        req_id: ReqId,
        items: Vec<SessionInfo>,
    },
    // ── push events (no req_id) ─────────────────────────────────────────
    /// PTY produced output. `data_b64` is base64-encoded raw bytes.
    Data { session_id: Uuid, data_b64: String },
    /// Shell process exited. Subsequent `Write` to this id will error.
    Exit { session_id: Uuid, code: i32 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_msg_roundtrip_open() {
        let m = ClientMsg::Open {
            req_id: 42,
            cols: 80,
            rows: 24,
            cwd: Some("/home/user".into()),
        };
        let s = serde_json::to_string(&m).unwrap();
        let back: ClientMsg = serde_json::from_str(&s).unwrap();
        match back {
            ClientMsg::Open {
                req_id,
                cols,
                rows,
                cwd,
            } => {
                assert_eq!(req_id, 42);
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
                assert_eq!(cwd.as_deref(), Some("/home/user"));
            }
            _ => panic!("variant mismatch"),
        }
    }

    #[test]
    fn daemon_msg_roundtrip_data_event() {
        let id = Uuid::new_v4();
        let m = DaemonMsg::Data {
            session_id: id,
            data_b64: "aGVsbG8=".into(),
        };
        let s = serde_json::to_string(&m).unwrap();
        let back: DaemonMsg = serde_json::from_str(&s).unwrap();
        match back {
            DaemonMsg::Data {
                session_id,
                data_b64,
            } => {
                assert_eq!(session_id, id);
                assert_eq!(data_b64, "aGVsbG8=");
            }
            _ => panic!("variant mismatch"),
        }
    }

    #[test]
    fn all_client_variants_serialize() {
        let id = Uuid::nil();
        let cases = vec![
            ClientMsg::Hello {
                req_id: 1,
                version: 1,
            },
            ClientMsg::Open {
                req_id: 2,
                cols: 80,
                rows: 24,
                cwd: None,
            },
            ClientMsg::Attach {
                req_id: 3,
                session_id: id,
                cols: 80,
                rows: 24,
            },
            ClientMsg::Detach {
                req_id: 4,
                session_id: id,
            },
            ClientMsg::Write {
                req_id: 5,
                session_id: id,
                data_b64: String::new(),
            },
            ClientMsg::Resize {
                req_id: 6,
                session_id: id,
                cols: 100,
                rows: 30,
            },
            ClientMsg::Close {
                req_id: 7,
                session_id: id,
            },
            ClientMsg::List { req_id: 8 },
            ClientMsg::KillAll { req_id: 9 },
            ClientMsg::Shutdown { req_id: 10 },
        ];
        for c in cases {
            let s = serde_json::to_string(&c).unwrap();
            let _: ClientMsg = serde_json::from_str(&s).unwrap();
        }
    }
}
