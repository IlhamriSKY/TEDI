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

/// The daemon's socket. Naming and binding live in `local_socket`, shared with
/// the MCP bridge; only this stem differs.
pub const STEM: &str = "tedi-ptyd";

#[cfg(unix)]
pub fn socket_path() -> PathBuf {
    crate::modules::local_socket::path(STEM)
}

#[cfg(windows)]
pub fn socket_name() -> String {
    crate::modules::local_socket::name(STEM)
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

    // Profile isolation itself is covered once, in `local_socket`, since both
    // servers now get it from the same place.
}
