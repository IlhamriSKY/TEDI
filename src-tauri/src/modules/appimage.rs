//! AppImage environment hygiene for child processes.
//
// The AppImage runtime points `LD_LIBRARY_PATH` at the bundle's own lib
// directory, and every process TEDI spawns inherits it. A system program then
// resolves its dependencies against OUR libraries instead of the distribution's,
// which fails as an undefined symbol rather than as anything naming the cause:
// PHP loading `curl.so` against a bundled `libcurl.so.4` is the reported case,
// and `git` over https is the same trap.
//
// So: when running as an AppImage, strip the variable from anything we launch
// that is not us. Deliberately NOT applied where the child IS TEDI (the PTY
// daemon, the updater), which needs the bundled libraries to load at all.
//
// The `APPIMAGE` variable is set by the AppImage runtime itself, so its presence
// is the signal; outside one there is nothing to strip and this is a no-op.

#[cfg(target_os = "linux")]
pub fn sanitize_env(cmd: &mut std::process::Command) {
    if std::env::var_os("APPIMAGE").is_some() {
        cmd.env_remove("LD_LIBRARY_PATH");
    }
}

#[cfg(not(target_os = "linux"))]
pub fn sanitize_env(_cmd: &mut std::process::Command) {}
