//! Interactive SSH client sessions.
//!
//! Mirrors the local PTY module's command shape (`ssh_open`/`ssh_write`/
//! `ssh_resize`/`ssh_close`) so the frontend can swap a local PTY for a
//! remote shell with minimal plumbing. Auth supports password or private
//! key. Host-key handling is trust-on-first-use with an accept-any policy;
//! TEDI does not yet persist a known_hosts file. The server key fingerprint
//! is logged on connect until a known_hosts UI lands.

mod session;
pub mod sftp;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};

use serde::Deserialize;
use tauri::ipc::Channel;
use tokio::runtime::Runtime;

pub use session::SshEvent;
use session::SshSession;

/// Shared tokio runtime for every SSH session. russh is async-first; driving
/// it from per-session executors would duplicate thread pools. A single
/// multi-thread runtime keeps overhead flat.
fn ssh_runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("tedi-ssh")
            .build()
            .expect("init ssh tokio runtime")
    })
}

pub struct SshState {
    /// `pub(crate)` so the sibling `sftp` module can look up an existing
    /// session by id to issue file-system commands.
    pub(crate) sessions: tokio::sync::RwLock<HashMap<u32, Arc<SshSession>>>,
    next_id: AtomicU32,
}

impl Default for SshState {
    fn default() -> Self {
        Self {
            sessions: tokio::sync::RwLock::new(HashMap::new()),
            next_id: AtomicU32::new(1),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOpenInput {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Plain password. Either this or `private_key` must be set.
    pub password: Option<String>,
    /// PEM-encoded private key text (OpenSSH or PKCS8). Optional passphrase
    /// in `private_key_passphrase`.
    pub private_key: Option<String>,
    pub private_key_passphrase: Option<String>,
    /// SHA256 fingerprint ("SHA256:...") of the server key recorded by a
    /// previous successful connect. When set, the handshake fails fast if
    /// the server presents a different key, blocking silent MITM on saved
    /// connections. `None` on first connect (TOFU) and on dialog-time
    /// test connections for brand-new hosts.
    pub expected_fingerprint: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[tauri::command]
pub async fn ssh_open(
    state: tauri::State<'_, SshState>,
    input: SshOpenInput,
    on_event: Channel<SshEvent>,
) -> Result<u32, String> {
    let rt = ssh_runtime();
    let session = rt
        .spawn(session::connect(input, on_event))
        .await
        .map_err(|e| format!("ssh task join failed: {e}"))?
        .map_err(|e| {
            log::error!("ssh_open failed: {e}");
            e
        })?;
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    state.sessions.write().await.insert(id, session);
    log::info!("ssh opened id={id}");
    Ok(id)
}

#[tauri::command]
pub async fn ssh_write(
    state: tauri::State<'_, SshState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("ssh_write: unknown id={id}");
            "no session".to_string()
        })?;
    session.write(data.as_bytes()).await
}

#[tauri::command]
pub async fn ssh_resize(
    state: tauri::State<'_, SshState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("ssh_resize: unknown id={id}");
            "no session".to_string()
        })?;
    session.resize(cols, rows).await
}

#[tauri::command]
pub async fn ssh_close(state: tauri::State<'_, SshState>, id: u32) -> Result<(), String> {
    let session = state.sessions.write().await.remove(&id);
    if let Some(s) = session {
        s.close().await;
        log::info!("ssh closed id={id}");
    } else {
        log::debug!("ssh_close: unknown id={id}");
    }
    Ok(())
}
