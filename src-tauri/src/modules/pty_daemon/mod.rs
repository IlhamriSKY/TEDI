// Sidecar PTY daemon — owns the lifecycle of every interactive shell so
// they survive the GUI window closing. Same binary as the GUI; the
// daemon mode is selected by the `--pty-daemon` flag short-circuited
// before Tauri boots (mirrors `cli_update` / `cli_ext`).
//
// Process model:
//   `TEDIApp` (GUI)  <—local socket—>  `TEDIApp --pty-daemon`
//
// Lifecycle goals (see plan `rosy-dreaming-wombat.md`):
//   • GUI close       → daemon survives, sessions persist
//   • GUI reopen      → reconnect + Attach(session_id) to resume
//   • PC restart      → daemon dies with kernel, sessions lost (intended)
//   • Daemon crash    → sessions lost, GUI falls back to fresh spawn
//
// File map (built up across phases):
//   protocol.rs   — wire messages (ClientMsg / DaemonMsg)              [Phase 1]
//   transport.rs  — length-prefixed JSON framing over local sockets    [Phase 1]
//   paths.rs      — per-user socket path / pipe name                   [Phase 1]
//   server.rs     — daemon-side accept loop, session store, scrollback [Phase 2]
//   client.rs     — GUI-side connect_or_spawn + event proxy            [Phase 3]
//   spawn.rs      — detached child spawn (POSIX setsid / Win DETACHED) [Phase 3]

pub mod client;
pub mod paths;
pub mod protocol;
pub mod server;
pub mod spawn;
pub mod transport;

/// Argv flag selecting daemon mode. Mirrors the conventions of
/// `cli::handle_version_help_and_exit` / `cli_update`.
pub const DAEMON_FLAG: &str = "--pty-daemon";

/// Detect the daemon flag without consuming argv. Cheap; called once per
/// `lib::run()` invocation alongside the other CLI short-circuits.
pub fn args_request_daemon() -> bool {
    std::env::args().skip(1).any(|a| a == DAEMON_FLAG)
}

/// Pre-Tauri CLI short-circuit: if invoked with `--pty-daemon`, run the
/// daemon server forever and `process::exit`. Returns immediately when the
/// flag is absent. Matches the calling convention of
/// `cli::handle_version_help_and_exit` so it slots into `lib::run()`'s
/// dispatch chain.
pub fn handle_pty_daemon_command_and_exit() {
    if !args_request_daemon() {
        return;
    }
    server::run_forever();
}
