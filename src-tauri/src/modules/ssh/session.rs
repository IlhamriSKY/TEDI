use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use russh::client::{self, Config, Handle, Handler, Msg};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use serde::Serialize;
use tauri::ipc::Channel as IpcChannel;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

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

/// Trust-on-first-use stub. We accept any server key but log its fingerprint
/// and surface it to the frontend so the user has a visible audit trail
/// until a real known_hosts UI lands.
struct AcceptAny {
    fingerprint_slot: Arc<Mutex<Option<String>>>,
}

impl Handler for AcceptAny {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        log::warn!("ssh: accepting server key (TOFU) fingerprint={fp}");
        *self.fingerprint_slot.lock().await = Some(fp);
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
    /// up. Dropping this drops the entire SSH session.
    handle: Mutex<Option<Handle<AcceptAny>>>,
}

impl SshSession {
    pub async fn write(&self, data: &[u8]) -> Result<(), String> {
        self.write_half
            .data(data)
            .await
            .map_err(|e| e.to_string())
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
        if let Some(h) = self.handle.lock().await.take() {
            let _ = h
                .disconnect(Disconnect::ByApplication, "tedi: client closed", "")
                .await;
        }
        if let Some(j) = self.pump.lock().await.take() {
            j.abort();
        }
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

    let fingerprint_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let handler = AcceptAny {
        fingerprint_slot: fingerprint_slot.clone(),
    };

    let addr = (input.host.as_str(), input.port);
    let connect_fut = client::connect(config, addr, handler);
    let mut handle = tokio::time::timeout(CONNECT_TIMEOUT, connect_fut)
        .await
        .map_err(|_| format!("ssh: connect to {}:{} timed out", input.host, input.port))?
        .map_err(|e| format!("ssh: connect failed: {e}"))?;

    let authed = if let Some(pk_text) = input.private_key.as_deref() {
        let pass = input.private_key_passphrase.as_deref();
        let key = russh::keys::decode_secret_key(pk_text, pass)
            .map_err(|e| format!("ssh: parse private key failed: {e}"))?;
        let pk = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha256));
        handle
            .authenticate_publickey(&input.user, pk)
            .await
            .map_err(|e| format!("ssh: pubkey auth error: {e}"))?
    } else {
        let password = input.password.as_deref().unwrap_or_default();
        handle
            .authenticate_password(&input.user, password)
            .await
            .map_err(|e| format!("ssh: password auth error: {e}"))?
    };

    if !authed.success() {
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

    let fingerprint = fingerprint_slot.lock().await.clone().unwrap_or_default();
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
    }))
}
