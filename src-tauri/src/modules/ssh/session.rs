use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use russh::client::{self, Config, Handle, Handler, KeyboardInteractiveAuthResponse, Msg};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg};
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

#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SshEvent {
    /// Auth/connect handshake completed; frontend can show "connected".
    Connected { fingerprint: String },
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
            let _ = ch.send(SshEvent::Data { data: B64.encode(&bytes) });
        }
        if let Ok(mut s) = self.mirror_sinks.lock() {
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

    // First connect (no pinned fingerprint) gets an interactive confirmation:
    // park a one-shot the verifier awaits, resolved by `ssh_confirm_host_key`.
    // Pinned connects skip this and verify against `expected` directly.
    let needs_confirm = input.expected_fingerprint.is_none();
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
        expected: input.expected_fingerprint.clone(),
        report: report.clone(),
        on_event: on_event.clone(),
        prompt_id: prompt_id.clone(),
        host: input.host.clone(),
        decision,
    };

    let addr = (input.host.as_str(), input.port);
    let connect_fut = client::connect(config, addr, handler);
    // First connect may block on the confirmation dialog, so grant extra time;
    // pinned connects keep the tight 15s budget.
    let overall_timeout = if needs_confirm {
        CONNECT_TIMEOUT + HOSTKEY_CONFIRM_TIMEOUT
    } else {
        CONNECT_TIMEOUT
    };
    let connect_result = tokio::time::timeout(overall_timeout, connect_fut)
        .await
        .map_err(|_| format!("ssh: connect to {}:{} timed out", input.host, input.port))?;
    // Drop any unconsumed prompt (handshake failed before/around the check).
    if needs_confirm {
        if let Ok(mut m) = pending_host_keys().lock() {
            m.remove(&prompt_id);
        }
    }
    let mut handle = match connect_result {
        Ok(h) => h,
        Err(e) => {
            // russh rejected the handshake. Prefer the verifier's structured
            // reasons (user rejected a new key, or a pinned-key mismatch) over
            // a generic disconnect so the frontend can react specifically.
            let report_guard = report.lock().await;
            if let Some(seen) = report_guard.rejected.clone() {
                return Err(format!(
                    "ssh: host key not trusted: the new server key {seen} was not confirmed; \
                     connection aborted before sending credentials."
                ));
            }
            if let Some((expected, seen)) = report_guard.mismatch.clone() {
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
            // Plenty of PAM-backed servers refuse the `password` method and
            // only offer `keyboard-interactive` (FreeIPA, Duo-only, certain
            // sshd hardening profiles). Try KBI as a fallback, feeding the
            // saved password as the first prompt's answer. 2FA multi-prompt
            // setups will fail with a clear "too many prompts" error
            // instead of hanging.
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
        // Fan an event to every extra mirror sink. Dead channels are tolerated
        // (send is best-effort); they are pruned on the next attach if needed.
        let fan = |ev: &SshEvent| {
            if let Ok(sinks) = pump_sinks.lock() {
                for ch in sinks.iter() {
                    let _ = ch.send(ev.clone());
                }
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
                    let ev = SshEvent::Data { data: B64.encode(data) };
                    let _ = on_event_pump.send(ev.clone());
                    fan(&ev);
                }
                ChannelMsg::ExtendedData { ref data, ext: 1 } => {
                    let ev = SshEvent::Stderr { data: B64.encode(data) };
                    let _ = on_event_pump.send(ev.clone());
                    fan(&ev);
                }
                ChannelMsg::ExitStatus { exit_status } => {
                    let ev = SshEvent::Exit { code: exit_status as i32 };
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
