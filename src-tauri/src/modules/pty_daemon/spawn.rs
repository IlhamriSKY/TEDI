// Detached daemon child-spawn helpers. Both platforms produce a child that
// is reparented away from the GUI process so closing the GUI window does
// NOT take the daemon down with it.
//
// Unix: `process_group(0)` makes the child its own process-group leader, so
// SIGHUP propagated to the GUI's pgroup at session-leader exit doesn't
// reach the daemon. We don't `setsid()` (no stable libc dep) — process
// group isolation is enough for our case: TEDI's daemon never holds a
// controlling terminal anyway.
//
// Windows: `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW`
// gives the child no console attachment, its own pgroup, and no window
// flash. Without `DETACHED_PROCESS` the daemon would inherit the GUI's
// console (none in release, but the GUI uses `windows_subsystem = "windows"`
// so this is required anyway).

use std::io;
use std::path::Path;
use std::process::{Command, Stdio};

use super::DAEMON_FLAG;

#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Spawn the daemon as a detached background process. The caller must
/// retry `transport::connect_to_daemon()` with backoff after this returns
/// successfully — the daemon needs a short window to bind its socket.
pub fn spawn_daemon_detached() -> io::Result<()> {
    let exe = std::env::current_exe()?;
    spawn_daemon_from(&exe)
}

fn spawn_daemon_from(exe: &Path) -> io::Result<()> {
    let mut cmd = Command::new(exe);
    cmd.arg(DAEMON_FLAG).stdin(Stdio::null()).stdout(Stdio::null());

    // Route the daemon's stderr to a log file so its `log::*` macros
    // (installed in `server::init_logging`) survive past launch. Open in
    // append mode; multiple daemon runs over time concatenate. If the file
    // cannot be opened we fall back to `Stdio::null()` rather than refusing
    // to spawn - losing logs is degraded, not broken.
    let log_path = super::paths::daemon_log_path();
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(file) => {
            cmd.stderr(Stdio::from(file));
        }
        Err(e) => {
            log::warn!(
                "could not open daemon log {} ({e}); daemon will log to /dev/null",
                log_path.display()
            );
            cmd.stderr(Stdio::null());
        }
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // `process_group(0)` -> the child becomes leader of a new pgroup,
        // isolated from the GUI's pgroup signals.
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }

    let child = cmd.spawn()?;
    // We intentionally don't keep the `Child` handle: dropping it does not
    // kill the process (Rust's Drop doesn't wait/kill by default), and the
    // pgroup detachment above has already cut the lifecycle tie.
    log::info!("spawned tedi-ptyd pid={}", child.id());
    Ok(())
}
