// Per-user location of the daemon's local socket. Resolved identically by
// the GUI's `PtyClient::connect_or_spawn()` and the daemon's
// `Server::bind()`, so both sides land on the same name without sharing a
// runtime constant.

use std::path::PathBuf;

/// Bundle id - must match `tauri.conf.json`'s `identifier`. Used to locate
/// the per-user app-data directory without an `AppHandle` (the daemon
/// boots before Tauri builds, so it has no `AppHandle`). Mirrored from
/// `cli_ext::BUNDLE_ID`; keep them in sync.
///
/// Debug builds use the `.dev` suffix so `pnpm tauri dev` reads from a
/// separate data dir than the installed release - no more dev runs
/// inheriting workspaces or PTY sessions from yesterday's prod use.
/// `tauri.dev.conf.json` overrides the matching Tauri identifier so
/// `app_data_dir()` lines up with what the daemon writes here.
#[cfg(debug_assertions)]
const BUNDLE_ID: &str = "id.ilhamrisky.tedi.dev";
#[cfg(not(debug_assertions))]
const BUNDLE_ID: &str = "id.ilhamrisky.tedi";

/// Per-day-ish log file the daemon writes to. The spawning GUI configures
/// the child process's stderr to point here so `log::info!` / `log::error!`
/// macros (routed through `server::init_logging`) end up persisted. Without
/// this the daemon is invisible after launch - a Stdio::null() stderr
/// silently throws every log line away.
///
/// Returns an OS-default-cache fallback if `dirs::data_dir` is unavailable
/// (very rare; mostly defensive). Creates the parent directory if missing.
pub fn daemon_log_path() -> PathBuf {
    let base = dirs::data_dir()
        .or_else(dirs::cache_dir)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base.join(BUNDLE_ID).join("logs");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("tedi-ptyd.log")
}

/// Unix domain socket path. Prefers `$XDG_RUNTIME_DIR/tedi-ptyd.sock`
/// (per-user, tmpfs-backed on systemd distros, auto-cleaned on logout).
/// Falls back to `$TMPDIR/tedi-ptyd-<USER>.sock` (or `/tmp` if `TMPDIR`
/// unset). `$USER` provides per-user isolation since `/tmp` is shared.
#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        let mut p = PathBuf::from(dir);
        p.push("tedi-ptyd.sock");
        return p;
    }
    let tmp = std::env::var_os("TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
    tmp.join(format!("tedi-ptyd-{user}.sock"))
}

/// Windows named-pipe name. The kernel namespace is shared across the
/// machine, so the user name is hashed into the suffix to give every
/// account its own daemon. FNV-1a is sufficient - this is a uniqueness
/// suffix, not a security boundary (the pipe ACL handles that).
#[cfg(windows)]
pub fn socket_name() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
    format!("tedi-ptyd-{:08x}", fnv1a(user.as_bytes()))
}

#[cfg(windows)]
fn fnv1a(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn socket_path_is_absolute() {
        let p = socket_path();
        assert!(p.is_absolute(), "socket path must be absolute: {p:?}");
        assert!(p.file_name().is_some());
    }

    #[cfg(windows)]
    #[test]
    fn socket_name_is_stable() {
        let a = socket_name();
        let b = socket_name();
        assert_eq!(a, b, "socket name must be deterministic for one user");
        assert!(a.starts_with("tedi-ptyd-"));
    }
}
