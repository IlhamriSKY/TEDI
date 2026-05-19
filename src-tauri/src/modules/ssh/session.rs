use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use russh::client::{self, Config, Handle, Handler, KeyboardInteractiveAuthResponse, Msg};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::ipc::Channel as IpcChannel;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::sftp::open_sftp_on_handle;
use super::SshOpenInput;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const KEEPALIVE: Duration = Duration::from_secs(30);

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SshEvent {
    /// Auth/connect handshake completed - frontend can show "connected".
    Connected { fingerprint: String },
    /// Base64-encoded stdout chunk from the remote shell.
    Data { data: String },
    /// Base64-encoded stderr chunk - rare for an interactive shell but
    /// possible with explicit `2>&1` suppression server-side.
    Stderr { data: String },
    /// Remote process exited with this status. Mirrors PtyEvent::Exit so the
    /// frontend can reuse its existing handler shape.
    Exit { code: i32 },
}

/// Server-key check. When the caller passed `expected_fingerprint`, the
/// presented key must match it exactly - any mismatch is recorded for
/// the caller to surface as a "host key changed" error and aborts the
/// handshake. When no expected fingerprint is supplied (first connect /
/// dialog test on a new host), we fall back to trust-on-first-use:
/// accept the key, record its fingerprint so the caller can persist it,
/// and rely on later connects to compare against the saved value.
///
/// `pub(super)` only so the parameterised `Handle<HostKeyVerifier>`
/// field on `SshSession` can in turn be exposed to the sibling `sftp`
/// module.
pub(super) struct HostKeyVerifier {
    expected: Option<String>,
    report: Arc<Mutex<HostKeyReport>>,
}

#[derive(Default)]
pub(super) struct HostKeyReport {
    /// Fingerprint of the key the server actually presented, regardless
    /// of whether it matched the expected one.
    seen: Option<String>,
    /// (expected, seen) pair when the server's key didn't match the
    /// pinned fingerprint. Surfaced verbatim in the error message so
    /// the user can compare both values before deciding to trust.
    mismatch: Option<(String, String)>,
}

impl Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        let mut report = self.report.lock().await;
        report.seen = Some(fp.clone());
        if let Some(expected) = &self.expected {
            if expected != &fp {
                log::warn!("ssh: host key mismatch expected={expected} got={fp}");
                report.mismatch = Some((expected.clone(), fp));
                // Rejecting here makes russh fail the handshake; the
                // caller inspects `report.mismatch` to turn that into a
                // specific error string rather than a generic disconnect.
                return Ok(false);
            }
            log::info!("ssh: host key pinned ok fingerprint={fp}");
        } else {
            log::warn!("ssh: accepting server key (TOFU) fingerprint={fp}");
        }
        Ok(true)
    }
}

pub struct SshSession {
    /// Write half of the SSH channel - methods take `&self`, so writes
    /// from concurrent commands proceed without locking against the read
    /// pump. (Earlier versions shared the whole Channel<Msg> behind a
    /// Mutex, which deadlocked: the pump holds the lock across
    /// `wait().await` while idle, blocking every keystroke.)
    write_half: ChannelWriteHalf<Msg>,
    /// Background task draining channel messages to the IPC channel.
    pump: Mutex<Option<JoinHandle<()>>>,
    /// Underlying client handle - kept alive so the TCP connection stays
    /// up. Dropping this drops the entire SSH session. `pub(super)` so the
    /// sibling `sftp` module can open new subsystem channels on it.
    pub(super) handle: Mutex<Option<Handle<HostKeyVerifier>>>,
    /// Lazily-opened SFTP subsystem. Cached so repeated file-tree ops
    /// don't pay the channel-open + handshake roundtrip every time.
    sftp: Mutex<Option<Arc<SftpSession>>>,
}

impl SshSession {
    pub async fn write(&self, data: &[u8]) -> Result<(), String> {
        self.write_half.data(data).await.map_err(|e| e.to_string())
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.write_half
            .window_change(cols.into(), rows.into(), 0, 0)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn close(self: Arc<Self>) {
        let _ = self.write_half.eof().await;
        let _ = self.write_half.close().await;
        // Drop the SFTP session first so its background reader can shut
        // down before we tear the underlying connection out from under it.
        if let Some(sftp) = self.sftp.lock().await.take() {
            let _ = sftp.close().await;
        }
        if let Some(h) = self.handle.lock().await.take() {
            let _ = h
                .disconnect(Disconnect::ByApplication, "tedi: client closed", "")
                .await;
        }
        if let Some(j) = self.pump.lock().await.take() {
            j.abort();
        }
    }

    /// Return the cached SFTP session, opening a fresh subsystem channel
    /// on the underlying SSH handle if this is the first request. Cheap
    /// after the first call; opens cost one channel round-trip + SFTP
    /// version handshake.
    pub async fn ensure_sftp(&self) -> Result<Arc<SftpSession>, String> {
        let mut guard = self.sftp.lock().await;
        if let Some(existing) = guard.as_ref() {
            return Ok(existing.clone());
        }
        let sftp = open_sftp_on_handle(self).await?;
        *guard = Some(sftp.clone());
        Ok(sftp)
    }
}

impl Drop for SshSession {
    fn drop(&mut self) {
        // Last-resort cleanup if the frontend hung up without calling
        // ssh_close - aborts the pump so its tokio task can unwind.
        if let Ok(mut g) = self.pump.try_lock() {
            if let Some(j) = g.take() {
                j.abort();
            }
        }
    }
}

pub async fn connect(
    input: SshOpenInput,
    on_event: IpcChannel<SshEvent>,
) -> Result<Arc<SshSession>, String> {
    if input.password.is_none() && input.private_key.is_none() {
        return Err("ssh: either password or private_key must be provided".into());
    }

    let config = Arc::new(Config {
        inactivity_timeout: None,
        keepalive_interval: Some(KEEPALIVE),
        ..Default::default()
    });

    let report: Arc<Mutex<HostKeyReport>> = Arc::new(Mutex::new(HostKeyReport::default()));
    let handler = HostKeyVerifier {
        expected: input.expected_fingerprint.clone(),
        report: report.clone(),
    };

    let addr = (input.host.as_str(), input.port);
    let connect_fut = client::connect(config, addr, handler);
    let connect_result = tokio::time::timeout(CONNECT_TIMEOUT, connect_fut)
        .await
        .map_err(|_| format!("ssh: connect to {}:{} timed out", input.host, input.port))?;
    let mut handle = match connect_result {
        Ok(h) => h,
        Err(e) => {
            // russh rejected the handshake. If our verifier flagged a host
            // key mismatch on the way, that's the actual cause - surface
            // it as a structured message the frontend recognises.
            if let Some((expected, seen)) = report.lock().await.mismatch.clone() {
                return Err(format!(
                    "ssh: host key mismatch: expected={expected} server={seen}. \
                     The server presented a different key than the one recorded on the last \
                     successful connect. If the server key was rotated legitimately, edit the \
                     saved connection and clear the recorded fingerprint before reconnecting; \
                     otherwise this could be a man-in-the-middle attack."
                ));
            }
            return Err(format!("ssh: connect failed: {e}"));
        }
    };

    let authed_ok = if let Some(pk_text) = input.private_key.as_deref() {
        let pass = input.private_key_passphrase.as_deref();
        let key = russh::keys::decode_secret_key(pk_text, pass)
            .map_err(|e| format!("ssh: parse private key failed: {e}"))?;
        let pk = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha256));
        handle
            .authenticate_publickey(&input.user, pk)
            .await
            .map_err(|e| format!("ssh: pubkey auth error: {e}"))?
            .success()
    } else {
        let password = input.password.as_deref().unwrap_or_default();
        let first = handle
            .authenticate_password(&input.user, password)
            .await
            .map_err(|e| format!("ssh: password auth error: {e}"))?;
        if first.success() {
            true
        } else {
            // Plenty of PAM-backed servers refuse the `password` method
            // entirely and only offer `keyboard-interactive` (FreeIPA,
            // Duo-only, certain sshd hardening profiles). Try KBI as a
            // fallback, feeding the saved password as the first prompt's
            // answer; for 2FA-multi-prompt setups we'll surface a clear
            // "keyboard-interactive: more prompts than we can answer
            // non-interactively" error instead of hanging.
            try_keyboard_interactive(&mut handle, &input.user, password).await?
        }
    };

    if !authed_ok {
        return Err("ssh: authentication rejected".into());
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("ssh: open channel failed: {e}"))?;

    channel
        .request_pty(
            true,
            "xterm-256color",
            input.cols.into(),
            input.rows.into(),
            0,
            0,
            &[],
        )
        .await
        .map_err(|e| format!("ssh: request pty failed: {e}"))?;

    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("ssh: request shell failed: {e}"))?;

    let fingerprint = report.lock().await.seen.clone().unwrap_or_default();
    let _ = on_event.send(SshEvent::Connected { fingerprint });

    // Split now so the pump task owns the read half exclusively and
    // SshSession owns the write half. No shared lock, no deadlock.
    let (mut read_half, write_half) = channel.split();
    let on_event_pump = on_event.clone();

    let pump = tokio::spawn(async move {
        while let Some(msg) = read_half.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => {
                    let _ = on_event_pump.send(SshEvent::Data {
                        data: B64.encode(data),
                    });
                }
                ChannelMsg::ExtendedData { ref data, ext: 1 } => {
                    let _ = on_event_pump.send(SshEvent::Stderr {
                        data: B64.encode(data),
                    });
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    let _ = on_event_pump.send(SshEvent::Exit {
                        code: exit_status as i32,
                    });
                }
                ChannelMsg::Eof | ChannelMsg::Close => {
                    let _ = on_event_pump.send(SshEvent::Exit { code: 0 });
                    return;
                }
                _ => {}
            }
        }
        // wait() returned None: peer closed without sending exit-status.
        let _ = on_event_pump.send(SshEvent::Exit { code: 0 });
    });

    Ok(Arc::new(SshSession {
        write_half,
        pump: Mutex::new(Some(pump)),
        handle: Mutex::new(Some(handle)),
        sftp: Mutex::new(None),
    }))
}

/// Run an `ssh-userauth` keyboard-interactive exchange to completion using
/// the saved password as the response to the first prompt of the first
/// `InfoRequest`. Returns Ok(true) on `Success`, Ok(false) on the server's
/// final `Failure`, and Err(..) for any transport-level error.
///
/// We answer additional prompts (or subsequent rounds) with empty strings:
/// for plain PAM password setups this is all the server asks for; for
/// 2FA-style setups requiring an OTP we have no way to prompt the user
/// non-interactively from this entry point, so the server will fail us and
/// the caller surfaces a generic "authentication rejected" error. A
/// dedicated 2FA prompt UI would slot in here by replacing the `responses`
/// vector with values sourced from a frontend round-trip.
///
/// `MAX_KBI_ROUNDS` caps the loop so a hostile server can't keep us in an
/// endless prompt cycle.
async fn try_keyboard_interactive(
    handle: &mut Handle<HostKeyVerifier>,
    user: &str,
    password: &str,
) -> Result<bool, String> {
    const MAX_KBI_ROUNDS: usize = 8;
    let mut state = handle
        .authenticate_keyboard_interactive_start(user.to_string(), None)
        .await
        .map_err(|e| format!("ssh: keyboard-interactive start failed: {e}"))?;
    let mut first_round = true;
    for _ in 0..MAX_KBI_ROUNDS {
        match state {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let responses: Vec<String> = prompts
                    .iter()
                    .enumerate()
                    .map(|(i, _)| {
                        if first_round && i == 0 {
                            password.to_string()
                        } else {
                            String::new()
                        }
                    })
                    .collect();
                first_round = false;
                state = handle
                    .authenticate_keyboard_interactive_respond(responses)
                    .await
                    .map_err(|e| format!("ssh: keyboard-interactive respond failed: {e}"))?;
            }
        }
    }
    Err("ssh: keyboard-interactive: too many prompt rounds".into())
}
