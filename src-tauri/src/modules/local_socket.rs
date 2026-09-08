//! The per-user local socket two servers listen on: the PTY daemon and the MCP
//! bridge.
//!
//! Both need the same four things - a name that is unique per user AND per
//! profile, a unix path or a Windows pipe name depending on the platform, an
//! address string a client can be handed, and a bind that survives a crashed
//! predecessor. Each had its own copy, down to a hand-inlined FNV-1a beside a
//! named one, so the two could drift apart while looking identical. They differ
//! in exactly one thing, the `stem`, and that is now the only argument.

#[cfg(unix)]
use std::path::PathBuf;

use interprocess::local_socket::tokio::Listener;
use interprocess::local_socket::ListenerOptions;

/// Debug builds get their own sockets, for the same reason they get their own
/// data dir: a dev run must not reach the installed app. The PTY daemon is the
/// sharpest case, being a persistent process holding live PTYs, so one shared
/// socket made a terminal opened in `pnpm tauri dev` sprout a cloned tab in the
/// release the developer was using at the time. Empty in release, so a shipped
/// build keeps the name it has always had and can reattach to a daemon left
/// running by the previous version.
pub const PROFILE_SUFFIX: &str = if cfg!(debug_assertions) { "-dev" } else { "" };

/// Unix socket path for `stem`.
///
/// Prefers `$XDG_RUNTIME_DIR` (per-user, tmpfs-backed on systemd distros, and
/// auto-cleaned on logout), else `$TMPDIR` or `/tmp` with `$USER` in the name,
/// since `/tmp` is shared.
#[cfg(unix)]
pub fn path(stem: &str) -> PathBuf {
    if let Some(dir) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir).join(format!("{stem}{PROFILE_SUFFIX}.sock"));
    }
    let tmp = std::env::var_os("TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    let user = std::env::var("USER").unwrap_or_else(|_| "default".into());
    tmp.join(format!("{stem}-{user}{PROFILE_SUFFIX}.sock"))
}

/// Windows named-pipe name for `stem`. The pipe namespace is machine-wide, so
/// the account name is hashed in to give every user their own. FNV-1a is enough
/// for a uniqueness suffix; the pipe ACL is the security boundary, not the name.
#[cfg(windows)]
pub fn name(stem: &str) -> String {
    let user = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
    let mut h: u32 = 0x811c_9dc5;
    for &b in user.as_bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{stem}-{h:08x}{PROFILE_SUFFIX}")
}

/// The address a client connects to, as a string to hand across a handshake.
pub fn address(stem: &str) -> String {
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\{}", name(stem))
    }
    #[cfg(unix)]
    {
        path(stem).to_string_lossy().into_owned()
    }
}

/// Bind and start listening.
///
/// On unix a leftover file from a crashed run would fail with `AddrInUse`
/// forever, so it is removed first; a caller that must NOT take over from a
/// live peer (the daemon, which would otherwise steal its own sessions) probes
/// for one before calling this. The socket is then chmod 0600, which on unix is
/// the actual access control - for the MCP bridge that is what makes its token a
/// second factor rather than the only one.
pub fn bind(stem: &str) -> std::io::Result<Listener> {
    #[cfg(unix)]
    {
        use interprocess::local_socket::{GenericFilePath, ToFsName};
        use std::os::unix::fs::PermissionsExt;
        let p = path(stem);
        let _ = std::fs::remove_file(&p);
        if let Some(parent) = p.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let listener = ListenerOptions::new()
            .name(p.as_path().to_fs_name::<GenericFilePath>()?)
            .create_tokio()?;
        let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
        Ok(listener)
    }
    #[cfg(windows)]
    {
        use interprocess::local_socket::{GenericNamespaced, ToNsName};
        let n = name(stem);
        ListenerOptions::new()
            .name(n.as_str().to_ns_name::<GenericNamespaced>()?)
            .create_tokio()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A dev run must not share the installed app's socket. Asserted on the
    /// ADDRESS rather than on `PROFILE_SUFFIX`, so it still holds if the naming
    /// scheme moves again.
    #[test]
    fn debug_builds_get_their_own_address() {
        let addr = address("tedi-ptyd");
        assert_eq!(
            addr.contains("-dev"),
            cfg!(debug_assertions),
            "a dev build needs its own socket, a release build the shipped name: {addr}"
        );
    }

    #[test]
    fn one_stem_always_resolves_the_same_way() {
        assert_eq!(address("tedi-mcp"), address("tedi-mcp"));
        assert_ne!(address("tedi-mcp"), address("tedi-ptyd"));
    }
}
