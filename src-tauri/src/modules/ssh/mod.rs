//! Interactive SSH client sessions.
//!
//! Mirrors the local PTY module's command shape (`ssh_open`/`ssh_write`/
//! `ssh_resize`/`ssh_close`) so the frontend can swap a local PTY for a
//! remote shell with minimal plumbing. Auth supports password or private
//! key. Host-key handling: SHA-256 fingerprint pinning. The first connect to
//! a new host is trust-on-first-use (the seen fingerprint is reported to the
//! frontend, which persists it as `lastFingerprint` in the connection store).
//! Every later connect passes that fingerprint as `expected_fingerprint`; a
//! mismatch aborts the handshake with a "host key mismatch / possible MITM"
//! error (see `session::HostKeyVerifier`). To re-trust a legitimately rotated
//! key the user clears the saved fingerprint on the connection.

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
    /// session by id to issue file-system commands. `Arc`-wrapped so the
    /// janitor task spawned per session can hold a handle for eviction
    /// after the pump task exits on remote disconnect.
    pub(crate) sessions: Arc<tokio::sync::RwLock<HashMap<u32, Arc<SshSession>>>>,
    next_id: AtomicU32,
}

impl Default for SshState {
    fn default() -> Self {
        Self {
            sessions: Arc::new(tokio::sync::RwLock::new(HashMap::new())),
            next_id: AtomicU32::new(1),
        }
    }
}

/// One hop in a ProxyJump chain. Resolved on the frontend (the chain is walked
/// from saved connections and each hop's secrets are read from the keychain),
/// then passed in connect order so the backend just dials them in sequence.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshJumpHop {
    /// Saved-connection id this hop came from, so the backend can echo it back
    /// in `JumpConnected` and the frontend pins the fingerprint on the right row.
    pub connection_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub private_key_passphrase: Option<String>,
    pub expected_fingerprint: Option<String>,
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
    /// ProxyJump chain in connect order (publicly-reachable entry host first;
    /// the hop closest to the target last). Empty/absent = direct connection.
    #[serde(default)]
    pub jumps: Vec<SshJumpHop>,
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
    // Take the exit receiver before handing the Arc to the map so the
    // janitor can wait for the pump task to finish without racing another
    // caller for the slot. Receiver fires on normal exit (Eof/Close, peer
    // hangup) and on pump abort (because the oneshot Sender is then dropped),
    // so explicit close paths also wake the janitor; it just no-ops on the
    // already-removed id.
    let exit_signal = session.take_exit_signal();
    let sessions_handle = state.sessions.clone();
    state.sessions.write().await.insert(id, session);
    if let Some(rx) = exit_signal {
        rt.spawn(async move {
            let _ = rx.await;
            sessions_handle.write().await.remove(&id);
            log::info!("ssh session id={id} evicted after pump exit");
        });
    }
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

/// Answer a first-connect `HostKeyPrompt`. `accept = true` lets the paused
/// handshake proceed (and the connection pins the fingerprint on success);
/// `accept = false` aborts the connect before any credential is sent. Called
/// by the frontend confirmation dialog. No-op (Err) if the prompt already
/// timed out or was answered.
#[tauri::command]
pub fn ssh_confirm_host_key(prompt_id: String, accept: bool) -> Result<(), String> {
    match session::take_pending_host_key(&prompt_id) {
        Some(tx) => {
            // Receiver may already be gone if the connect timed out; ignore.
            let _ = tx.send(accept);
            Ok(())
        }
        None => Err("ssh: unknown or already-answered host-key prompt".into()),
    }
}

/// Metadata for one live SSH session, returned by `ssh_list_sessions`. Lets the
/// remote-access bridge enumerate SSH tabs the GUI has open (they live here, not
/// in the PTY daemon) before attaching to mirror them.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshSessionInfo {
    pub id: u32,
    pub host: String,
    pub user: String,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    pub created_at_ms: u64,
}

#[tauri::command]
pub async fn ssh_list_sessions(
    state: tauri::State<'_, SshState>,
) -> Result<Vec<SshSessionInfo>, String> {
    let map = state.sessions.read().await;
    let mut out = Vec::with_capacity(map.len());
    for (id, s) in map.iter() {
        let (host, user, cols, rows, alive, created_at_ms) = s.mirror_info();
        out.push(SshSessionInfo {
            id: *id,
            host,
            user,
            cols,
            rows,
            alive,
            created_at_ms,
        });
    }
    Ok(out)
}

/// Attach an additional event sink to an existing SSH session so a second
/// consumer (the remote-access bridge) mirrors its output + writes input via
/// `ssh_write`. Replays the recent ring on attach. Returns `alive`.
#[tauri::command]
pub async fn ssh_attach(
    state: tauri::State<'_, SshState>,
    id: u32,
    on_event: Channel<SshEvent>,
) -> Result<bool, String> {
    let session = state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| {
            log::warn!("ssh_attach: unknown id={id}");
            "no session".to_string()
        })?;
    Ok(session.add_mirror_sink(on_event))
}

/// Single-quote a value for a POSIX shell so a remote-supplied path can never
/// break out of its argument. `cwd` reaches us from the remote shell's OSC 7
/// escape, i.e. it is attacker-controlled if the host is compromised.
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Last non-empty line of a remote command's stdout.
///
/// sshd runs an exec request through the user's login shell, and bash sources
/// `~/.bashrc` on that path, so anything an rc file echoes (a greeting, nvm /
/// conda / direnv chatter) is prepended to the output we asked for. Every value
/// we read back is single-line, so the last line is the answer.
fn last_line(s: &str) -> &str {
    s.lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
}

/// `git status` for the repo containing `cwd` on the remote, so Source Control
/// follows the machine you are working on instead of the local workspace. The
/// caller picks `cwd` (the folder the Remote tree is browsing, else the SSH
/// terminal's OSC 7 cwd); empty means the remote login directory.
///
/// Read-only by design: it reuses the existing porcelain parsers but skips the
/// numstat / line-count enrichment, which reads the LOCAL disk. `added`,
/// `removed` and `binary` therefore stay at their defaults for remote entries.
#[tauri::command]
pub async fn ssh_git_status(
    state: tauri::State<'_, SshState>,
    id: u32,
    cwd: String,
) -> Result<crate::modules::git::commands::GitStatus, String> {
    use crate::modules::git::commands::{parse_branch_header, parse_porcelain_v1, GitStatus};

    let session = state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "no session".to_string())?;

    let not_a_repo = || GitStatus {
        is_repo: false,
        root: None,
        branch: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        changes: Vec::new(),
    };

    let cd = if cwd.is_empty() {
        String::new()
    } else {
        format!("-C {} ", shell_quote(&cwd))
    };
    // No `2>/dev/null`: stderr arrives on its own channel, so it cannot mix into
    // stdout, and dropping it is what made every failure look like "no repo".
    let root = match session
        .exec_capture(&format!("git {cd}rev-parse --show-toplevel"))
        .await
    {
        Ok(s) => s,
        // The one expected failure. Anything else (git not on sshd's PATH,
        // dubious ownership, a cwd that no longer exists, exec denied) is a real
        // error the user needs to read, not a silent empty panel.
        //
        // Matching on git's English text is safe here: we send no env, so an
        // sshd exec channel runs in the C locale and git does not translate.
        Err(e) if e.contains("not a git repository") => return Ok(not_a_repo()),
        Err(e) => return Err(e),
    };
    let root = last_line(&root);
    if root.is_empty() {
        return Ok(not_a_repo());
    }

    let raw = session
        .exec_capture(&format!(
            "git -C {} status --porcelain=v1 --branch -z --untracked-files=all",
            shell_quote(root)
        ))
        .await?;
    // `--branch` always emits a header, so this is only reachable when the
    // remote git was killed by a signal: russh reports that as ExitSignal, not
    // ExitStatus, so `exit` stays 0 and we get a successful-looking empty read.
    if raw.is_empty() {
        return Ok(not_a_repo());
    }
    // The `--branch` header is the first -z record; the rest are file entries.
    let (header, entries) = raw.split_once('\0').unwrap_or((raw.as_str(), ""));
    // Same rc-noise guard as the root above, so a chatty ~/.bashrc can't be
    // parsed as the branch name.
    let header = last_line(header);
    let (branch, upstream, ahead, behind) = parse_branch_header(header);
    Ok(GitStatus {
        is_repo: true,
        root: Some(root.to_string()),
        branch,
        upstream,
        ahead,
        behind,
        // `root.join(rel)` on a Windows host yields a mixed separator, which
        // the parser's `to_forward` normalizes back to a POSIX path.
        changes: parse_porcelain_v1(std::path::Path::new(root), entries),
    })
}

/// Run one whitelisted git subcommand in `cwd` on the remote and return its
/// stdout; a non-zero exit is an `Err` carrying the remote's stderr.
///
/// The counterpart to `git_run`, taking the identical argument vector, so the
/// Source Control panel drives a remote repository through the same code path
/// as a local one instead of a parallel remote-only implementation. Every
/// argument is single-quoted before it reaches the remote shell, and the
/// subcommand is held to the same list as the local runner.
#[tauri::command]
pub async fn ssh_git(
    state: tauri::State<'_, SshState>,
    id: u32,
    cwd: String,
    args: Vec<String>,
) -> Result<String, String> {
    crate::modules::git::commands::check_args(&args)?;
    let session = state
        .sessions
        .read()
        .await
        .get(&id)
        .cloned()
        .ok_or_else(|| "no session".to_string())?;

    let mut cmd = String::from("git");
    if !cwd.is_empty() {
        cmd.push_str(" -C ");
        cmd.push_str(&shell_quote(&cwd));
    }
    for a in &args {
        cmd.push(' ');
        cmd.push_str(&shell_quote(a));
    }
    session.exec_capture(&cmd).await
}

#[cfg(test)]
mod tests {
    use super::{last_line, shell_quote};

    /// The rc-noise guard: a chatty remote `~/.bashrc` prepends its own output
    /// to every `ssh host cmd` capture, so the value we want is the last line.
    #[test]
    fn last_line_survives_rc_chatter() {
        assert_eq!(last_line("/home/u/app"), "/home/u/app");
        assert_eq!(
            last_line("Welcome!\nnvm loaded\n/home/u/app\n"),
            "/home/u/app"
        );
        assert_eq!(last_line("/home/u/app\n\n"), "/home/u/app");
        assert_eq!(last_line("  /home/u/app  "), "/home/u/app");
        assert_eq!(last_line(""), "");
        assert_eq!(last_line("\n \n"), "");
        // A branch header behind a greeting still parses as the header.
        assert_eq!(
            last_line("motd\n## main...origin/main"),
            "## main...origin/main"
        );
    }

    /// `cwd` reaches us from the remote shell's OSC 7, i.e. it is untrusted.
    #[test]
    fn shell_quote_blocks_injection() {
        assert_eq!(shell_quote("/home/u/app"), "'/home/u/app'");
        assert_eq!(
            shell_quote("/tmp/x'; rm -rf ~ ;'"),
            r"'/tmp/x'\''; rm -rf ~ ;'\'''"
        );
    }
}
