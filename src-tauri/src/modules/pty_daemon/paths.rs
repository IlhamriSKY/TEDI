// Per-user location of the daemon's local socket. Resolved identically by
// the GUI's `PtyClient::connect_or_spawn()` and the daemon's
// `Server::bind()`, so both sides land on the same name without sharing a
// runtime constant.

use std::path::PathBuf;

use crate::modules::ids::BUNDLE_ID;

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

/// Debug builds talk to their OWN daemon.
///
/// `BUNDLE_ID` above already carries a `.dev` suffix under `debug_assertions`
/// so a dev run reads and writes a separate data dir from an installed release.
/// The daemon socket was the one piece left out of that isolation, and it is the
/// piece that leaks the most: the daemon is a shared, persistent process holding
/// live PTYs, and the GUI's adoption poller pulls in any session it does not own
/// that was created after it started watching. Sharing one daemon therefore made
/// a terminal opened in `pnpm tauri dev` sprout a CLONED tab in the installed
/// app the developer was using at the time (the dev side is spared only because
/// its poller is off under `import.meta.env.DEV`).
///
/// Empty in release, so a shipped build keeps the exact name it has always used
/// and can still reattach to a daemon left running by the previous version.
const PROFILE_SUFFIX: &str = if cfg!(debug_assertions) { "-dev" } else { "" };

/// Unix domain socket path. Prefers `$XDG_RUNTIME_DIR/tedi-ptyd.sock`
/// (per-user, tmpfs-backed on systemd distros, auto-cleaned on logout).
/// Falls back to `$TMPDIR/tedi-ptyd-<USER>.sock` (or `/tmp` if `TMPDIR`
/// unset). `$USER` provides per-user isolation since `/tmp` is shared.
#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        let mut p = PathBuf::from(dir);
        p.push(format!("tedi-ptyd{PROFILE_SUFFIX}.sock"));
        return p;
    }
    let tmp = std::env::var_os("TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
    tmp.join(format!("tedi-ptyd-{user}{PROFILE_SUFFIX}.sock"))
}

/// Windows named-pipe name. The kernel namespace is shared across the
/// machine, so the user name is hashed into the suffix to give every
/// account its own daemon. FNV-1a is sufficient - this is a uniqueness
/// suffix, not a security boundary (the pipe ACL handles that).
#[cfg(windows)]
pub fn socket_name() -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
    format!("tedi-ptyd-{:08x}{PROFILE_SUFFIX}", fnv1a(user.as_bytes()))
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

    /// A dev run must not share the installed app's daemon: they hold live PTYs
    /// in common, and the GUI adoption poller turns that into cloned tabs.
    #[test]
    fn debug_builds_get_their_own_daemon() {
        if cfg!(debug_assertions) {
            assert_eq!(PROFILE_SUFFIX, "-dev", "a dev build needs its own socket");
        } else {
            assert_eq!(
                PROFILE_SUFFIX, "",
                "a release build must keep the shipped name"
            );
        }
    }
}
