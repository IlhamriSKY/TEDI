//! `tedi-cli` — console-subsystem entry point for the `tedi ext`, `tedi
//! --update`, `tedi --version`, and `tedi --help` subcommands. Shipped next
//! to `TEDI.exe` so PowerShell / cmd.exe inherit stdin/stdout to a real
//! interactive process — `TEDI.exe` is GUI subsystem (`windows_subsystem =
//! "windows"`), which leaves stdin detached and breaks the `ratatui`-based
//! TUI's input loop.
//!
//! Flow on Windows:
//!   PowerShell `tedi ext`
//!     -> PATHEXT resolves `TEDI.exe`
//!     -> `lib::run()` detects CLI args and re-execs `tedi-cli.exe` (sibling)
//!     -> this binary takes over stdin/stdout, runs the TUI, exits
//!     -> PowerShell receives the exit code via TEDI.exe's wait
//!
//! On macOS / Linux this binary is built but unused — those OSes do not
//! have a subsystem split, so `tedi` (the main binary) handles CLI subcommands
//! itself with no console-attach contortions. The Tauri bundler only ships
//! `tedi-cli` to the Windows installer via `tauri.windows.conf.json`.
//!
//! The bin reuses every CLI handler from `tedi_lib`: there is exactly one
//! copy of the install pipeline, extension state machinery, and signature
//! verification. This binary is a thin re-entry point — keep it that way.

fn main() {
    // Run the same short-circuit handlers `lib::run` would have run, in the
    // same order. Each `*_and_exit` function calls `process::exit` when it
    // matches; if none match, fall through to print a usage hint and exit
    // non-zero so accidental direct invocations don't look like silent
    // successes.
    tedi_lib::modules::cli::handle_version_help_and_exit();
    tedi_lib::modules::cli_ext::handle_extension_command_and_exit();
    tedi_lib::modules::cli_update::handle_update_command_and_exit();

    eprintln!(
        "tedi-cli: no CLI subcommand recognised. \
         This binary is meant to be invoked through `tedi` / `TEDI.exe` \
         with one of: ext, --extension, --update, --version, --help."
    );
    std::process::exit(2);
}
