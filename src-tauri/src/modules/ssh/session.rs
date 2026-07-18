use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use russh::client::{self, Config, Handle, Handler, KeyboardInteractiveAuthResponse, Msg};
use russh::keys::{Algorithm, EcdsaCurve, HashAlg, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, ChannelWriteHalf, Disconnect};
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::ipc::Channel as IpcChannel;
use tokio::sync::{oneshot, Mutex};
use tokio::task::JoinHandle;

use super::sftp::open_sftp_on_handle;
use super::SshOpenInput;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const KEEPALIVE: Duration = Duration::from_secs(30);

/// Host-key / public-key signature algorithms we accept, in preference order.
/// This is russh's vetted default set MINUS bare `ssh-rsa` (RSA with SHA-1
/// signatures): SHA-1 is collision-broken and OpenSSH has disabled `ssh-rsa`
/// by default since 8.8. Every server from OpenSSH 7.2 (2016) onward offers
/// ed25519 / ecdsa / rsa-sha2-*, so dropping it costs no realistic
/// compatibility while removing the one weak item left in russh 0.60's default
/// host-key list. KEX, ciphers, MACs and compression stay at russh's defaults
/// (modern KEX including OpenSSH strict-kex / Terrapin mitigation, AEAD + CTR
/// ciphers, SHA-2-only MACs). Pinning the set here also freezes the posture
/// across russh version bumps.
const HOST_KEY_ALGOS: &[Algorithm] = &[
    Algorithm::Ed25519,
    Algorithm::Ecdsa {
        curve: EcdsaCurve::NistP256,
    },
    Algorithm::Ecdsa {
        curve: EcdsaCurve::NistP384,
    },
    Algorithm::Ecdsa {
        curve: EcdsaCurve::NistP521,
    },
    Algorithm::Rsa {
        hash: Some(HashAlg::Sha512),
    },
    Algorithm::Rsa {
        hash: Some(HashAlg::Sha256),
    },
];

#[derive(Serialize, Clone)]
// `rename_all` only camelCases the variant TAGS (e.g. `hostKeyPrompt`); it does
// NOT touch the fields inside struct variants - that needs `rename_all_fields`.
// Without it, `HostKeyPrompt::prompt_id` went over the IPC channel as snake_case
// `prompt_id`, so the frontend's `event.promptId` was `undefined`. The
// first-connect host-key dialog still rendered (it reads single-word
// `fingerprint`/`host`), but "Trust & connect" then called
// `ssh_confirm_host_key(undefined)` - which fails silently - so the paused
// handshake never got the user's answer and hung for the full 120 s confirm
// timeout before failing. It also rewrites the `JumpConnected::connection_id`
// field added below to `connectionId`, which the frontend's `event.connectionId`
// (bridge.ts) relies on to pin each jump hop - so the attribute is load-bearing,
// not just for `prompt_id`. The remaining variant fields are single words
// (`fingerprint`, `data`, `code`, `host`), so camelCasing is a no-op for them.
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SshEvent {
    /// Auth/connect handshake completed; frontend can show "connected".
    Connected { fingerprint: String },
    /// A jump host in a ProxyJump chain authenticated. Carries the saved
    /// connection id it came from so the frontend pins the hop's fingerprint on
    /// the right connection (the target's fingerprint still arrives via
    /// `Connected`). Emitted once per hop, in connect order, before `Connected`.
    JumpConnected {
        connection_id: String,
        fingerprint: String,
    },
    /// First-connect host-key confirmation request, emitted from
    /// `check_server_key` when no fingerprint is pinned - BEFORE any credential
    /// is sent. The handshake blocks until the frontend answers via
    /// `ssh_confirm_host_key(prompt_id, accept)`; reject aborts the connect.
    HostKeyPrompt {
        prompt_id: String,
        fingerprint: String,
        host: String,
    },
    /// Base64-encoded stdout chunk from the remote shell.
    Data { data: String },
    /// Base64-encoded stderr chunk. Rare for an interactive shell but
    /// possible with server-side `2>&1` suppression.
    Stderr { data: String },
    /// Remote process exited with this status. Mirrors PtyEvent::Exit so the
    /// frontend can reuse its handler shape.
    Exit { code: i32 },
}

/// How long `check_server_key` waits for the user's first-connect decision
/// before treating silence as a rejection, so a forgotten dialog can't hold
/// the handshake (and the TCP connection) open indefinitely.
const HOSTKEY_CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

static HOSTKEY_PROMPT_SEQ: AtomicU64 = AtomicU64::new(1);

/// Pending first-connect host-key confirmations, keyed by an opaque prompt id.
/// `check_server_key` parks a one-shot `Sender` here and awaits its `Receiver`;
/// the `ssh_confirm_host_key` command resolves it. A process-global map keeps
/// the command decoupled from the in-flight handshake task.
fn pending_host_keys() -> &'static std::sync::Mutex<HashMap<String, oneshot::Sender<bool>>> {
    static P: std::sync::OnceLock<std::sync::Mutex<HashMap<String, oneshot::Sender<bool>>>> =
        std::sync::OnceLock::new();
    P.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// Resolve a pending host-key prompt. Returns the parked sender (the command
/// fires it with the user's decision); `None` if it already timed out/resolved.
pub(super) fn take_pending_host_key(prompt_id: &str) -> Option<oneshot::Sender<bool>> {
    pending_host_keys().lock().ok()?.remove(prompt_id)
}

/// Server-key check. With `expected_fingerprint`, the presented key must
/// match exactly; any mismatch is recorded for the caller to surface as a
/// "host key changed" error and aborts the handshake. Without one (first
/// connect or dialog test on a new host), falls back to trust-on-first-use:
/// accept the key, record its fingerprint for the caller to persist, and
/// rely on later connects to compare against the saved value.
///
/// `pub(super)` so the parameterised `Handle<HostKeyVerifier>` field on
/// `SshSession` can be exposed to the sibling `sftp` module.
pub(super) struct HostKeyVerifier {
    expected: Option<String>,
    report: Arc<Mutex<HostKeyReport>>,
    /// Event sink for the first-connect `HostKeyPrompt` (no-expected only).
    on_event: IpcChannel<SshEvent>,
    /// Correlates the emitted prompt with the `ssh_confirm_host_key` answer.
    prompt_id: String,
    /// Host label shown in the confirmation dialog.
    host: String,
    /// One-shot receiver for the user's decision; taken once on first connect.
    decision: Option<oneshot::Receiver<bool>>,
}

#[derive(Default)]
pub(super) struct HostKeyReport {
    /// Fingerprint of the key the server actually presented, regardless
    /// of whether it matched the expected one.
    seen: Option<String>,
    /// (expected, seen) pair when the server's key did not match the
    /// pinned fingerprint. Surfaced verbatim in the error so the user
    /// can compare both values before deciding to trust.
    mismatch: Option<(String, String)>,
    /// Set to the seen fingerprint when the user (or a confirm timeout)
    /// rejected a brand-new host key, so the caller surfaces a clear
    /// "not trusted" message instead of a generic connect failure.
    rejected: Option<String>,
}

impl Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        {
            let mut report = self.report.lock().await;
            report.seen = Some(fp.clone());
            if let Some(expected) = &self.expected {
                if expected != &fp {
                    log::warn!("ssh: host key mismatch expected={expected} got={fp}");
                    report.mismatch = Some((expected.clone(), fp.clone()));
                    // Returning false makes russh fail the handshake. The caller
                    // inspects `report.mismatch` to turn that into a specific
                    // error string rather than a generic disconnect.
                    return Ok(false);
                }
                log::info!("ssh: host key pinned ok fingerprint={fp}");
                return Ok(true);
            }
        }

        // First connect (no pinned fingerprint): pause the handshake BEFORE any
        // credential is sent and require the user to verify the fingerprint
        // out-of-band. Silent trust-on-first-use would let a first-connect MITM
        // capture the password / private key during the auth that follows.
        let Some(rx) = self.decision.take() else {
            log::warn!("ssh: no host-key confirmation channel; refusing new host key");
            self.report.lock().await.rejected = Some(fp);
            return Ok(false);
        };
        let _ = self.on_event.send(SshEvent::HostKeyPrompt {
            prompt_id: self.prompt_id.clone(),
            fingerprint: fp.clone(),
            host: self.host.clone(),
        });
        let accepted = match tokio::time::timeout(HOSTKEY_CONFIRM_TIMEOUT, rx).await {
            Ok(Ok(v)) => v,
            // Sender dropped (command never fired) or the wait timed out.
            _ => {
                let _ = take_pending_host_key(&self.prompt_id);
                false
            }
        };
        if accepted {
            log::info!("ssh: user confirmed new host key fingerprint={fp}");
        } else {
            log::warn!("ssh: user rejected/aborted new host key fingerprint={fp}");
            self.report.lock().await.rejected = Some(fp);
        }
        Ok(accepted)
    }
}

pub struct SshSession {
    /// Write half of the SSH channel. Methods take `&self`, so writes from
    /// concurrent commands proceed without locking against the read pump.
    /// Earlier versions shared the whole Channel<Msg> behind a Mutex, which
    /// deadlocked: the pump held the lock across `wait().await` while idle,
    /// blocking every keystroke.
    write_half: ChannelWriteHalf<Msg>,
    /// Background task draining channel messages to the IPC channel.
    pump: Mutex<Option<JoinHandle<()>>>,
    /// Underlying client handle. Kept alive so the TCP connection stays up;
    /// dropping it drops the SSH session. `pub(super)` so the sibling `sftp`
    /// module can open new subsystem channels on it.
    pub(super) handle: Mutex<Option<Handle<HostKeyVerifier>>>,
    /// Jump-host handles for a ProxyJump chain, in connect order (entry first).
    /// Retained for the session's whole life: each tunnel rides on the hop
    /// before it, so dropping a jump handle collapses every hop above it
    /// (including the target). Empty for a direct connection. Disconnected,
    /// innermost-first, on `close`.
    jump_handles: Mutex<Vec<Handle<HostKeyVerifier>>>,
    /// Lazily-opened SFTP subsystem. Cached so repeated file-tree ops do
    /// not pay the channel-open + handshake roundtrip each time.
    sftp: Mutex<Option<Arc<SftpSession>>>,
    /// One-shot signal that fires when the pump task exits. The sender lives
    /// inside the pump's tokio task; `send()` runs at normal exit (Eof/Close,
    /// peer hang-up, wait() returning None) and the Sender simply drops on
    /// `pump.abort()` from explicit close; both paths unblock the receiver.
    /// Taken once by `ssh_open` to drive the post-exit janitor that evicts
    /// the session id from `SshState.sessions`. `std::sync::Mutex` so the
    /// take is sync-cheap.
    exit_signal: std::sync::Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
    /// Remote endpoint, surfaced by `ssh_list_sessions`.
    host: String,
    user: String,
    /// Live terminal dims; updated by `resize`. Read for list metadata.
    dims: std::sync::Mutex<(u16, u16)>,
    created_at_ms: u64,
    /// Extra mirror sinks (the remote-access bridge) the pump fans Data / Exit
    /// to alongside the GUI's own channel. Populated by `add_mirror_sink`.
    mirror_sinks: Arc<std::sync::Mutex<Vec<IpcChannel<SshEvent>>>>,
    /// Recent raw output, replayed to a freshly-attached mirror sink so it has
    /// context (SSH has no daemon-side scrollback). Capped.
    mirror_ring: Arc<std::sync::Mutex<VecDeque<u8>>>,
    alive: Arc<AtomicBool>,
}

impl SshSession {
    pub async fn write(&self, data: &[u8]) -> Result<(), String> {
        self.write_half.data(data).await.map_err(|e| e.to_string())
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        if let Ok(mut d) = self.dims.lock() {
            *d = (cols, rows);
        }
        self.write_half
            .window_change(cols.into(), rows.into(), 0, 0)
            .await
            .map_err(|e| e.to_string())
    }

    /// Register an extra event sink (the remote-access bridge) and replay the
    /// recent output ring so it has context. Returns whether the session is
    /// still alive. Mirrors the PTY daemon's multi-subscriber attach.
    pub fn add_mirror_sink(&self, ch: IpcChannel<SshEvent>) -> bool {
        let bytes: Vec<u8> = self
            .mirror_ring
            .lock()
            .map(|r| r.iter().copied().collect())
            .unwrap_or_default();
        if !bytes.is_empty() {
            let _ = ch.send(SshEvent::Data {
                data: B64.encode(&bytes),
            });
        }
        if let Ok(mut s) = self.mirror_sinks.lock() {
            // Bound the live sink count (a buggy or hostile extension could call
            // ssh_attach in a loop); evict the oldest so a reconnect storm can't
            // grow it without bound. The pump's fan also prunes dead sinks.
            const MAX_MIRROR_SINKS: usize = 8;
            while s.len() >= MAX_MIRROR_SINKS {
                s.remove(0);
            }
            s.push(ch);
        }
        self.alive.load(Ordering::Acquire)
    }

    /// Snapshot for `ssh_list_sessions`: (host, user, cols, rows, alive, created_at_ms).
    pub fn mirror_info(&self) -> (String, String, u16, u16, bool, u64) {
        let (cols, rows) = self.dims.lock().map(|d| *d).unwrap_or((80, 24));
        (
            self.host.clone(),
            self.user.clone(),
            cols,
            rows,
            self.alive.load(Ordering::Acquire),
            self.created_at_ms,
        )
    }

    pub async fn close(self: Arc<Self>) {
        let _ = self.write_half.eof().await;
        let _ = self.write_half.close().await;
        // Drop the SFTP session first so its background reader shuts down
        // before the underlying connection goes away.
        if let Some(sftp) = self.sftp.lock().await.take() {
            let _ = sftp.close().await;
        }
        if let Some(h) = self.handle.lock().await.take() {
            let _ = h
                .disconnect(Disconnect::ByApplication, "tedi: client closed", "")
                .await;
        }
        // Tear the jump chain down from innermost to outermost, after the
        // target handle that rode on top of it is already gone.
        for h in self.jump_handles.lock().await.drain(..).rev() {
            let _ = h
                .disconnect(Disconnect::ByApplication, "tedi: client closed", "")
                .await;
        }
        if let Some(j) = self.pump.lock().await.take() {
            j.abort();
        }
    }

    /// Take the one-shot exit-signal receiver out of the session. Called once
    /// by `ssh_open` to wire up the janitor task; subsequent callers get
    /// `None`. Returning `Option` so the field can be safely re-tried without
    /// panicking when a future refactor introduces a second consumer.
    pub fn take_exit_signal(&self) -> Option<tokio::sync::oneshot::Receiver<()>> {
        self.exit_signal.lock().ok().and_then(|mut g| g.take())
    }

    /// Return the cached SFTP session, opening a fresh subsystem channel on
    /// the SSH handle on first request. Cheap after the first call; the
    /// initial open costs one channel round-trip plus SFTP handshake.
    pub async fn ensure_sftp(&self) -> Result<Arc<SftpSession>, String> {
        let mut guard = self.sftp.lock().await;
        if let Some(existing) = guard.as_ref() {
            return Ok(existing.clone());
        }
        let sftp = open_sftp_on_handle(self).await?;
        *guard = Some(sftp.clone());
        Ok(sftp)
    }

    /// Run one non-interactive command on the remote and capture its stdout.
    /// Opens a one-shot channel on the retained handle, the same way
    /// `open_sftp_on_handle` does, so it is independent of the shell channel
    /// driving the terminal. stderr is dropped: every caller so far wants the
    /// command's value, and a failed command is reported as empty output.
    pub async fn exec_capture(&self, cmd: &str) -> Result<String, String> {
        let handle_guard = self.handle.lock().await;
        let handle = handle_guard
            .as_ref()
            .ok_or_else(|| "ssh session is closed".to_string())?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("ssh: open exec channel failed: {e}"))?;
        channel
            .exec(true, cmd)
            .await
            .map_err(|e| format!("ssh: exec failed: {e}"))?;

        // Bounded so a pathological remote can neither exhaust memory nor hang
        // the caller. Both limits are far above a `git status` on a large repo.
        // ponytail: fixed 4 MiB / 15s ceiling; make it a parameter only if a
        // second caller needs a different budget.
        const CAP: usize = 4 * 1024 * 1024;
        let deadline = tokio::time::sleep(std::time::Duration::from_secs(15));
        tokio::pin!(deadline);
        let mut out: Vec<u8> = Vec::new();
        loop {
            tokio::select! {
                _ = &mut deadline => break,
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        let room = CAP.saturating_sub(out.len());
                        if room > 0 {
                            out.extend_from_slice(&data[..data.len().min(room)]);
                        }
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
            }
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

impl Drop for SshSession {
    fn drop(&mut self) {
        // Last-resort cleanup when the frontend hung up without calling
        // ssh_close. Abort the pump so its tokio task can unwind.
        if let Ok(mut g) = self.pump.try_lock() {
            if let Some(j) = g.take() {
                j.abort();
            }
        }
    }
}

/// Shared russh client config: russh's vetted modern defaults with bare
/// `ssh-rsa` (SHA-1) dropped from the host-key set (see HOST_KEY_ALGOS). Built
/// fresh per hop because `client::connect[_stream]` consumes the `Arc<Config>`.
fn build_config() -> Arc<Config> {
    Arc::new(Config {
        inactivity_timeout: None,
        keepalive_interval: Some(KEEPALIVE),
        preferred: russh::Preferred {
            key: std::borrow::Cow::Borrowed(HOST_KEY_ALGOS),
            ..russh::Preferred::DEFAULT
        },
        ..Default::default()
    })
}

/// Build a host-key verifier for one hop. When no fingerprint is pinned, parks
/// a first-connect confirmation one-shot keyed by the returned prompt id
/// (resolved by `ssh_confirm_host_key`). Returns the handler plus the shared
/// report and prompt metadata the caller needs to apply the confirm-timeout
/// budget and to turn a handshake failure into a specific error.
fn build_verifier(
    expected_fingerprint: Option<String>,
    on_event: IpcChannel<SshEvent>,
    host: String,
) -> (HostKeyVerifier, Arc<Mutex<HostKeyReport>>, String, bool) {
    let report: Arc<Mutex<HostKeyReport>> = Arc::new(Mutex::new(HostKeyReport::default()));
    let needs_confirm = expected_fingerprint.is_none();
    let prompt_id = format!("hk-{}", HOSTKEY_PROMPT_SEQ.fetch_add(1, Ordering::Relaxed));
    let decision = if needs_confirm {
        let (tx, rx) = oneshot::channel::<bool>();
        if let Ok(mut m) = pending_host_keys().lock() {
            m.insert(prompt_id.clone(), tx);
        }
        Some(rx)
    } else {
        None
    };
    let handler = HostKeyVerifier {
        expected: expected_fingerprint,
        report: report.clone(),
        on_event,
        prompt_id: prompt_id.clone(),
        host,
        decision,
    };
    (handler, report, prompt_id, needs_confirm)
}

/// Turn a russh handshake failure into a specific, user-actionable message
/// using the verifier's structured report (user rejected a new key, or a
/// pinned-key mismatch), falling back to the generic disconnect text.
async fn handshake_error(report: &Arc<Mutex<HostKeyReport>>, e: russh::Error) -> String {
    let report_guard = report.lock().await;
    if let Some(seen) = report_guard.rejected.clone() {
        return format!(
            "ssh: host key not trusted: the new server key {seen} was not confirmed; \
             connection aborted before sending credentials."
        );
    }
    if let Some((expected, seen)) = report_guard.mismatch.clone() {
        return format!(
            "ssh: host key mismatch: expected={expected} server={seen}. \
             The server presented a different key than the one recorded on the last \
             successful connect. If the server key was rotated legitimately, edit the \
             saved connection and clear the recorded fingerprint before reconnecting; \
             otherwise this could be a man-in-the-middle attack."
        );
    }
    format!("ssh: connect failed: {e}")
}

/// Drive a russh connect future under the right timeout budget (first connects
/// may block on the confirmation dialog, so they get the extra confirm window),
/// clean up any unconsumed prompt, and map a failure through `handshake_error`.
/// Works for both `client::connect` (TCP) and `client::connect_stream` (tunnel).
async fn finish_connect<F>(
    connect_fut: F,
    needs_confirm: bool,
    report: &Arc<Mutex<HostKeyReport>>,
    prompt_id: &str,
    host: &str,
    port: u16,
) -> Result<Handle<HostKeyVerifier>, String>
where
    F: std::future::Future<Output = Result<Handle<HostKeyVerifier>, russh::Error>>,
{
    let overall_timeout = if needs_confirm {
        CONNECT_TIMEOUT + HOSTKEY_CONFIRM_TIMEOUT
    } else {
        CONNECT_TIMEOUT
    };
    let result = tokio::time::timeout(overall_timeout, connect_fut)
        .await
        .map_err(|_| format!("ssh: connect to {host}:{port} timed out"))?;
    // Drop any unconsumed prompt (handshake failed before/around the check).
    if needs_confirm {
        if let Ok(mut m) = pending_host_keys().lock() {
            m.remove(prompt_id);
        }
    }
    match result {
        Ok(h) => Ok(h),
        Err(e) => Err(handshake_error(report, e).await),
    }
}

/// Open a `direct-tcpip` tunnel from `prev` to `host:port` under the connect
/// timeout, so a jump host that is up but cannot reach the next hop fails in a
/// bounded, message-bearing way instead of hanging on the jump's own (often
/// ~75s) TCP connect timeout - restoring the direct path's deliberate cap for
/// tunneled hops. Also drops a parked first-connect prompt on failure, since
/// the tunnel can fail before `finish_connect` (the usual cleanup point) runs,
/// which would otherwise leak the one-shot in `pending_host_keys()`.
async fn open_tunnel(
    prev: &Handle<HostKeyVerifier>,
    host: &str,
    port: u16,
    needs_confirm: bool,
    prompt_id: &str,
) -> Result<russh::Channel<Msg>, String> {
    let opened = tokio::time::timeout(
        CONNECT_TIMEOUT,
        prev.channel_open_direct_tcpip(host.to_string(), u32::from(port), "127.0.0.1", 0),
    )
    .await;
    let drop_prompt = || {
        if needs_confirm {
            if let Ok(mut m) = pending_host_keys().lock() {
                m.remove(prompt_id);
            }
        }
    };
    match opened {
        Err(_) => {
            drop_prompt();
            Err(format!("ssh: open tunnel to {host}:{port} timed out"))
        }
        Ok(Err(e)) => {
            drop_prompt();
            Err(format!("ssh: open tunnel to {host}:{port} failed: {e}"))
        }
        Ok(Ok(channel)) => Ok(channel),
    }
}

/// Authenticate a hop with its private key (preferred when present) or password
/// (with a keyboard-interactive fallback for PAM-only servers). Shared by every
/// jump hop and the final target so the auth posture stays identical down the
/// whole chain. `host` only labels error messages, so a failing jump names
/// itself instead of reading as if it were the target.
async fn authenticate_hop(
    handle: &mut Handle<HostKeyVerifier>,
    host: &str,
    user: &str,
    password: Option<&str>,
    private_key: Option<&str>,
    passphrase: Option<&str>,
) -> Result<bool, String> {
    if let Some(pk_text) = private_key {
        let key = russh::keys::decode_secret_key(pk_text, passphrase)
            .map_err(|e| format!("ssh: [{host}] parse private key failed: {e}"))?;
        let pk = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha256));
        Ok(handle
            .authenticate_publickey(user, pk)
            .await
            .map_err(|e| format!("ssh: [{host}] pubkey auth error: {e}"))?
            .success())
    } else {
        let password = password.unwrap_or_default();
        let first = handle
            .authenticate_password(user, password)
            .await
            .map_err(|e| format!("ssh: [{host}] password auth error: {e}"))?;
        if first.success() {
            Ok(true)
        } else {
            // Plenty of PAM-backed servers refuse the `password` method and
            // only offer `keyboard-interactive` (FreeIPA, Duo-only, certain
            // sshd hardening profiles). Try KBI as a fallback, feeding the
            // saved password as the first prompt's answer. 2FA multi-prompt
            // setups will fail with a clear "too many prompts" error instead
            // of hanging.
            try_keyboard_interactive(handle, user, password).await
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

    // --- Jump chain (ProxyJump / Termius-style "host chaining") -------------
    // `input.jumps` is in connect order: jumps[0] is the publicly-reachable
    // entry we TCP-connect to; each later hop is reached by opening a
    // `direct-tcpip` channel on the previous hop and running a fresh SSH
    // handshake over that tunnel stream. The target is reached the same way
    // over the last jump (or directly when there are no jumps). Every jump
    // handle is retained on the session: dropping one collapses every tunnel
    // riding on it (including the target), so they must outlive the session.
    let mut jump_handles: Vec<Handle<HostKeyVerifier>> = Vec::new();
    for hop in &input.jumps {
        if hop.password.is_none() && hop.private_key.is_none() {
            return Err(format!(
                "ssh: jump host {} has no password or private key configured",
                hop.host
            ));
        }
        let (handler, report, prompt_id, needs_confirm) = build_verifier(
            hop.expected_fingerprint.clone(),
            on_event.clone(),
            hop.host.clone(),
        );
        let mut handle = if let Some(prev) = jump_handles.last() {
            let channel = open_tunnel(prev, &hop.host, hop.port, needs_confirm, &prompt_id).await?;
            finish_connect(
                client::connect_stream(build_config(), channel.into_stream(), handler),
                needs_confirm,
                &report,
                &prompt_id,
                &hop.host,
                hop.port,
            )
            .await?
        } else {
            finish_connect(
                client::connect(build_config(), (hop.host.as_str(), hop.port), handler),
                needs_confirm,
                &report,
                &prompt_id,
                &hop.host,
                hop.port,
            )
            .await?
        };
        let ok = authenticate_hop(
            &mut handle,
            &hop.host,
            &hop.user,
            hop.password.as_deref(),
            hop.private_key.as_deref(),
            hop.private_key_passphrase.as_deref(),
        )
        .await?;
        if !ok {
            return Err(format!(
                "ssh: authentication rejected for jump host {}",
                hop.host
            ));
        }
        // Pin the jump's host key against its own saved connection.
        let fp = report.lock().await.seen.clone().unwrap_or_default();
        let _ = on_event.send(SshEvent::JumpConnected {
            connection_id: hop.connection_id.clone(),
            fingerprint: fp,
        });
        jump_handles.push(handle);
    }

    // --- Target -------------------------------------------------------------
    // Either a direct TCP connect (no jumps) or a tunnel over the last jump.
    let (handler, report, prompt_id, needs_confirm) = build_verifier(
        input.expected_fingerprint.clone(),
        on_event.clone(),
        input.host.clone(),
    );
    let mut handle = if let Some(prev) = jump_handles.last() {
        let channel = open_tunnel(prev, &input.host, input.port, needs_confirm, &prompt_id).await?;
        finish_connect(
            client::connect_stream(build_config(), channel.into_stream(), handler),
            needs_confirm,
            &report,
            &prompt_id,
            &input.host,
            input.port,
        )
        .await?
    } else {
        finish_connect(
            client::connect(build_config(), (input.host.as_str(), input.port), handler),
            needs_confirm,
            &report,
            &prompt_id,
            &input.host,
            input.port,
        )
        .await?
    };

    let authed_ok = authenticate_hop(
        &mut handle,
        &input.host,
        &input.user,
        input.password.as_deref(),
        input.private_key.as_deref(),
        input.private_key_passphrase.as_deref(),
    )
    .await?;

    if !authed_ok {
        return Err("ssh: authentication rejected".into());
    }

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("ssh: open channel failed: {e}"))?;

    // Interactive PTY + shell are best-effort. Locked-down file-transfer
    // accounts (SFTP chroot, `PermitTTY no`, `ForceCommand internal-sftp`,
    // a `/usr/sbin/nologin` login shell) deny the PTY and/or the shell - which
    // used to fail the WHOLE connect via `?`, so a plain "FTP"-style host could
    // never be added at all. But the authenticated `Handle` is all the SFTP
    // file browser needs: it opens its OWN `sftp` subsystem channel (see
    // `sftp::open_sftp_on_handle`), independent of this shell channel. So a
    // denied shell must DEGRADE, not abort. A normal server still takes the
    // unchanged interactive path below; a shell-less server connects SFTP-only.
    let mut interactive = true;
    if let Err(e) = channel
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
    {
        log::warn!("ssh: request pty denied ({e}); continuing as SFTP-only (no interactive shell)");
        interactive = false;
    }
    if interactive {
        if let Err(e) = channel.request_shell(true).await {
            log::warn!("ssh: request shell denied ({e}); continuing as SFTP-only");
            interactive = false;
        }
    }

    if !interactive {
        // No usable terminal, but SFTP works over the live `Handle`. Build a
        // minimal session with NO read pump and NO exit janitor: a shell-less
        // channel that closes or sits idle must not fire the frontend's
        // reconnect loop or evict the session the file browser depends on. It
        // lives until an explicit `ssh_close`. Emit Connected (flips the leaf to
        // "connected" and surfaces the remote file tree) plus a one-line notice
        // in the inert terminal so the user knows why it accepts no input.
        let fingerprint = report.lock().await.seen.clone().unwrap_or_default();
        let _ = on_event.send(SshEvent::Connected { fingerprint });
        const SFTP_ONLY_NOTICE: &[u8] = b"\r\n\x1b[33m[tedi] This server allows file transfer (SFTP) only - no interactive shell. The terminal is disabled; use the remote file browser.\x1b[0m\r\n";
        let _ = on_event.send(SshEvent::Data {
            data: B64.encode(SFTP_ONLY_NOTICE),
        });
        // Keep the channel's write half to satisfy the struct; the read half is
        // intentionally dropped (we never pump a shell-less channel).
        let (_read_half, write_half) = channel.split();
        let created_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        return Ok(Arc::new(SshSession {
            write_half,
            pump: Mutex::new(None),
            handle: Mutex::new(Some(handle)),
            jump_handles: Mutex::new(jump_handles),
            sftp: Mutex::new(None),
            exit_signal: std::sync::Mutex::new(None),
            host: input.host.clone(),
            user: input.user.clone(),
            dims: std::sync::Mutex::new((input.cols, input.rows)),
            created_at_ms,
            mirror_sinks: Arc::new(std::sync::Mutex::new(Vec::new())),
            mirror_ring: Arc::new(std::sync::Mutex::new(VecDeque::new())),
            alive: Arc::new(AtomicBool::new(true)),
        }));
    }

    // Bootstrap: turn on OSC 7 cwd reporting on the remote shell. Stock
    // bash/zsh on most distros do not emit OSC 7 by default, leaving the
    // SFTP file tree stuck at the SFTP-canonicalised home regardless of
    // `cd`. Inject a tiny `precmd` / PROMPT_COMMAND hook so every prompt
    // prints the path the local OSC 7 handler parses. Errors from non-
    // bash/zsh shells (fish, dash, csh) are silenced; worst case the tree
    // stays on home. Leading space keeps it out of bash history when
    // HISTCONTROL=ignorespace. Trailing `clear` wipes the snippet's echo
    // and the motd, which is acceptable for a clean prompt.
    const OSC7_BOOTSTRAP: &[u8] = b" { if [ -n \"$ZSH_VERSION\" ]; then __tedi_o7(){ printf '\\e]7;file://%s%s\\e\\\\' \"${HOST:-$HOSTNAME}\" \"$PWD\"; }; typeset -ag precmd_functions; precmd_functions+=(__tedi_o7); elif [ -n \"$BASH_VERSION\" ]; then __tedi_o7(){ printf '\\e]7;file://%s%s\\e\\\\' \"$HOSTNAME\" \"$PWD\"; }; case \":${PROMPT_COMMAND:-}:\" in *\":__tedi_o7:\"*) ;; *) PROMPT_COMMAND=\"__tedi_o7${PROMPT_COMMAND:+;$PROMPT_COMMAND}\";; esac; fi; __tedi_o7 2>/dev/null; } 2>/dev/null; { clear 2>/dev/null || printf '\\033c'; }\r";
    let _ = channel.data(OSC7_BOOTSTRAP).await;

    let fingerprint = report.lock().await.seen.clone().unwrap_or_default();
    let _ = on_event.send(SshEvent::Connected { fingerprint });

    // Split so the pump task owns the read half exclusively and the
    // SshSession owns the write half. No shared lock, no deadlock.
    let (mut read_half, write_half) = channel.split();
    let on_event_pump = on_event.clone();

    // Pump owns the sender side; whether it sends() or just drops, the
    // receiver returned to ssh_open unblocks. That gives us a single wakeup
    // for both "remote disconnected" (Eof/Close branch) and "explicit close"
    // (pump.abort() drops the sender mid-future).
    let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<()>();

    // Mirror infrastructure shared with the pump: extra sinks (remote-access
    // bridge), a small replay ring, and an alive flag.
    const MIRROR_RING_CAP: usize = 128 * 1024;
    let mirror_sinks: Arc<std::sync::Mutex<Vec<IpcChannel<SshEvent>>>> =
        Arc::new(std::sync::Mutex::new(Vec::new()));
    let mirror_ring: Arc<std::sync::Mutex<VecDeque<u8>>> =
        Arc::new(std::sync::Mutex::new(VecDeque::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let pump_sinks = mirror_sinks.clone();
    let pump_ring = mirror_ring.clone();
    let pump_alive = alive.clone();

    let pump = tokio::spawn(async move {
        let _exit_tx = exit_tx;
        // Fan an event to every extra mirror sink, pruning any whose channel has
        // closed (the browser / bridge went away). Without this, dead sinks
        // accumulate across reconnects and the pump wastes a clone + send on
        // every output byte.
        let fan = |ev: &SshEvent| {
            if let Ok(mut sinks) = pump_sinks.lock() {
                sinks.retain(|ch| ch.send(ev.clone()).is_ok());
            }
        };
        while let Some(msg) = read_half.wait().await {
            match msg {
                ChannelMsg::Data { ref data } => {
                    if let Ok(mut r) = pump_ring.lock() {
                        r.extend(data.iter().copied());
                        while r.len() > MIRROR_RING_CAP {
                            r.pop_front();
                        }
                    }
                    let ev = SshEvent::Data {
                        data: B64.encode(data),
                    };
                    let _ = on_event_pump.send(ev.clone());
                    fan(&ev);
                }
                ChannelMsg::ExtendedData { ref data, ext: 1 } => {
                    let ev = SshEvent::Stderr {
                        data: B64.encode(data),
                    };
                    let _ = on_event_pump.send(ev.clone());
                    fan(&ev);
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    let ev = SshEvent::Exit {
                        code: exit_status as i32,
                    };
                    let _ = on_event_pump.send(ev.clone());
                    fan(&ev);
                }
                ChannelMsg::Eof | ChannelMsg::Close => {
                    pump_alive.store(false, Ordering::Release);
                    let ev = SshEvent::Exit { code: 0 };
                    let _ = on_event_pump.send(ev.clone());
                    fan(&ev);
                    return;
                }
                _ => {}
            }
        }
        // wait() returned None; peer closed without sending exit-status.
        pump_alive.store(false, Ordering::Release);
        let ev = SshEvent::Exit { code: 0 };
        let _ = on_event_pump.send(ev.clone());
        fan(&ev);
    });

    let created_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Ok(Arc::new(SshSession {
        write_half,
        pump: Mutex::new(Some(pump)),
        handle: Mutex::new(Some(handle)),
        jump_handles: Mutex::new(jump_handles),
        sftp: Mutex::new(None),
        exit_signal: std::sync::Mutex::new(Some(exit_rx)),
        host: input.host.clone(),
        user: input.user.clone(),
        dims: std::sync::Mutex::new((input.cols, input.rows)),
        created_at_ms,
        mirror_sinks,
        mirror_ring,
        alive,
    }))
}

/// Run an `ssh-userauth` keyboard-interactive exchange using the saved
/// password as the response to the first prompt of the first `InfoRequest`.
/// Returns `Ok(true)` on `Success`, `Ok(false)` on the server's final
/// `Failure`, and `Err(..)` for transport-level errors.
///
/// Additional prompts and subsequent rounds get empty strings. Plain PAM
/// password setups are happy with that; 2FA-style setups requiring an OTP
/// fail and surface as "authentication rejected". A dedicated 2FA prompt
/// UI would slot in by replacing `responses` with values from a frontend
/// round-trip.
///
/// `MAX_KBI_ROUNDS` caps the loop so a hostile server cannot keep us in an
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

#[cfg(test)]
mod chain_tests {
    use super::*;
    use crate::modules::ssh::SshJumpHop;
    use tauri::ipc::Channel as IpcChannel;

    /// Live end-to-end check that the REAL `session::connect` reaches a target
    /// through a ProxyJump chain. Network + a real key + real creds, so it is
    /// `#[ignore]`d (run with `cargo test --release chain -- --ignored`). All
    /// inputs come from env vars - nothing about anyone's infra is hard-coded:
    ///
    ///   TEDI_IT_KEY_PATH     PEM private key file (used for every hop)
    ///   TEDI_IT_TARGET_HOST  final host, TEDI_IT_TARGET_USER, TEDI_IT_TARGET_FP
    ///   TEDI_IT_JUMP_HOST    jump host (optional), TEDI_IT_JUMP_USER, TEDI_IT_JUMP_FP
    ///
    /// The `*_FP` SHA256 fingerprints pin each hop so the handshake never blocks
    /// on the interactive host-key dialog (there is no GUI in a test). Missing
    /// required vars => the test prints a skip notice and passes.
    #[test]
    #[ignore]
    fn connects_through_jump_chain() {
        let (Ok(key_path), Ok(target_host)) = (
            std::env::var("TEDI_IT_KEY_PATH"),
            std::env::var("TEDI_IT_TARGET_HOST"),
        ) else {
            eprintln!("[chain_tests] skipped: set TEDI_IT_KEY_PATH + TEDI_IT_TARGET_HOST");
            return;
        };
        let key = std::fs::read_to_string(&key_path).expect("read key file");
        let env_opt = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());

        let mut jumps = Vec::new();
        if let Some(jump_host) = env_opt("TEDI_IT_JUMP_HOST") {
            jumps.push(SshJumpHop {
                connection_id: "it-jump".into(),
                host: jump_host,
                port: 22,
                user: env_opt("TEDI_IT_JUMP_USER").unwrap_or_else(|| "ubuntu".into()),
                password: None,
                private_key: Some(key.clone()),
                private_key_passphrase: None,
                expected_fingerprint: env_opt("TEDI_IT_JUMP_FP"),
            });
        }

        let input = SshOpenInput {
            host: target_host.clone(),
            port: 22,
            user: env_opt("TEDI_IT_TARGET_USER").unwrap_or_else(|| "ubuntu".into()),
            password: None,
            private_key: Some(key),
            private_key_passphrase: None,
            expected_fingerprint: env_opt("TEDI_IT_TARGET_FP"),
            jumps,
            cols: 80,
            rows: 24,
        };

        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let channel = IpcChannel::new(|_msg| Ok(()));
            let session = connect(input, channel).await.expect("chain connect failed");
            let (host, _user, _cols, _rows, alive, _ts) = session.mirror_info();
            assert_eq!(host, target_host, "session bound to target host");
            assert!(
                alive,
                "session should be live after connecting through chain"
            );
            session.close().await;
            eprintln!("[chain_tests] OK: connected to {target_host} through chain");
        });
    }
}
