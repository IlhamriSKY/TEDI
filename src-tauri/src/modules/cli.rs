//! CLI argument handling for `tedi .` / `tedi <path>`.
//!
//! Captures the first positional arg once at startup (before any
//! `set_current_dir`), resolves it against the launch cwd, and classifies it
//! as folder or file. The frontend reads it via `cli_initial_target` on boot
//! and again via the `tedi:open-cli-target` event when single-instance
//! forwards a fresh invocation.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CliTarget {
    Folder { path: String },
    File { path: String, parent: String },
}

static INITIAL_TARGET: Mutex<Option<CliTarget>> = Mutex::new(None);

/// Set when `tedi --update` / `-u` appears in argv at startup. Drained once
/// by the frontend on boot; second invocations forwarding `--update` arrive
/// via the `tedi:trigger-update` event.
static INITIAL_UPDATE_REQUEST: Mutex<bool> = Mutex::new(false);

/// Returns true for flag-shaped args (`--foo`, `-bar`). Used to skip flags
/// when looking for the positional path arg.
fn is_flag(s: &str) -> bool {
    s.starts_with('-')
}

fn is_version_flag(s: &str) -> bool {
    matches!(s, "--version" | "-V" | "-v")
}

fn is_help_flag(s: &str) -> bool {
    matches!(s, "--help" | "-h")
}

pub fn is_update_flag(s: &str) -> bool {
    matches!(s, "--update" | "-u")
}

fn help_text() -> String {
    // Hand-laid out: `concat!` keeps every line literal so the 21-space
    // indent under "Folder to open" survives (backslash-continuation would
    // eat the leading whitespace).
    concat!(
        "TEDI ",
        env!("CARGO_PKG_VERSION"),
        " - Terminal Environment & Development Infrastructure\n",
        "\n",
        "USAGE:\n",
        "    tedi [PATH]\n",
        "    tedi [FLAG]\n",
        "    tedi ext <SUBCOMMAND> [ARGS]    (manage extensions, headless)\n",
        "\n",
        "If TEDI is already running, the request is forwarded to that window\n",
        "(a second window is not opened).\n",
        "\n",
        "FLAGS:\n",
        "    -h, --help           Print this help and exit\n",
        "    -v, -V, --version    Print version and exit\n",
        "    -u, --update         Check for updates and install in place (headless)\n",
        "\n",
        "ARGS:\n",
        "    PATH             Folder to open, or file to edit. Use `.` for the\n",
        "                     current directory. Relative paths resolve against\n",
        "                     the shell's cwd.\n",
        "\n",
        "EXTENSION SUBCOMMANDS (run `tedi ext help` for full reference):\n",
        "    tedi ext                       Open the TUI dashboard\n",
        "    tedi ext install <path|owner/repo|registry-id>\n",
        "    tedi ext list                  Browse registry (TUI on TTY, table on pipe)\n",
        "    tedi ext list --installed      Locally installed (alias: `tedi ext installed`)\n",
        "    tedi ext update [<ID>]         Check upstream for updates\n",
        "    tedi ext uninstall <ID>\n",
        "    tedi ext enable <ID>\n",
        "    tedi ext disable <ID>\n",
        "    --plain (-p)                   Force plain text output (no TUI)",
    )
    .to_string()
}

/// Re-attach this process to the parent terminal's console on Windows so the
/// GUI-subsystem build (`windows_subsystem = "windows"`, stdout detached) can
/// write to the shell that spawned it. No-op on macOS/Linux; stdio is
/// inherited there.
///
/// The install dir ships both `tedi.exe` (GUI subsystem) and `tedi.cmd`.
/// Windows PATHEXT resolves `.EXE` before `.CMD`, so `tedi --version` lands
/// on the EXE and the shim never runs. Without `AttachConsole` the EXE's
/// `println!` writes to a detached handle and the user sees nothing.
#[cfg(target_os = "windows")]
pub(crate) fn attach_parent_console() {
    use std::io::Write;
    use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    // SAFETY: AttachConsole is safe from any thread and returns 0 with no
    // side effects when there is no parent console (e.g. launched from
    // Explorer). A failed attach leaves stdout detached and the println
    // below becomes a silent no-op, which is correct for that case.
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
    // cmd.exe does not wait for GUI-subsystem children, so the next shell
    // prompt is usually already drawn by the time we print. Leading newline
    // separates our output from the prompt.
    let _ = writeln!(std::io::stdout());
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn attach_parent_console() {}

/// Print `--version` / `--help` and exit before GUI setup runs. Matches the
/// flag anywhere in argv, so `tedi <path> --version` still prints version.
///
/// On Windows the GUI binary has stdout detached; [`attach_parent_console`]
/// re-binds it to the launching shell. No-op on macOS/Linux.
pub fn handle_version_help_and_exit() {
    use std::io::Write;
    let args: Vec<String> = std::env::args().collect();
    let want_version = args.iter().skip(1).any(|a| is_version_flag(a));
    let want_help = args.iter().skip(1).any(|a| is_help_flag(a));
    if !want_version && !want_help {
        return;
    }
    attach_parent_console();
    if want_version {
        println!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
    } else {
        println!("{}", help_text());
    }
    // Flush before exit. On Windows the freshly attached console handle can
    // drop the tail of the message during teardown otherwise.
    let _ = std::io::stdout().flush();
    std::process::exit(0);
}

/// Returns the first non-flag arg after argv\[0\], or `None`.
fn first_positional<I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter().skip(1).find(|a| !is_flag(a))
}

/// Resolve `raw` against `base`. Relative paths join `base`, absolute paths
/// pass through. Avoids `canonicalize` because on Windows it returns UNC
/// paths (`\\?\C:\...`) that `portable-pty` and the frontend handle
/// inconsistently. Folds `.` / `..` so `tedi .` does not produce a path
/// ending in a literal `.` (which would surface as a tab title).
fn resolve(base: &Path, raw: &str) -> PathBuf {
    let p = Path::new(raw);
    let combined = if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    };
    normalize_components(&combined)
}

/// Lexically collapse `.` and `..` without touching the filesystem.
/// `PathBuf::pop` is a no-op at the root, so an over-popped `..` is dropped.
fn normalize_components(p: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Normalize to forward-slash form to match the frontend's canonical path
/// representation (see TEDI.md, UI conventions).
fn to_forward_slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Classify a resolved path as file or folder. Returns `None` when the path
/// is missing or is neither a regular file nor directory.
pub fn classify(resolved: &Path) -> Option<CliTarget> {
    let meta = std::fs::metadata(resolved).ok()?;
    if meta.is_dir() {
        Some(CliTarget::Folder {
            path: to_forward_slash(resolved),
        })
    } else if meta.is_file() {
        let parent = resolved.parent()?;
        Some(CliTarget::File {
            path: to_forward_slash(resolved),
            parent: to_forward_slash(parent),
        })
    } else {
        None
    }
}

/// Parse `argv` against `cwd` into a `CliTarget`. Used at startup and by
/// single-instance forwarding.
pub fn parse(args: Vec<String>, cwd: &Path) -> Option<CliTarget> {
    let raw = first_positional(args)?;
    let resolved = resolve(cwd, &raw);
    classify(&resolved)
}

/// Returns true when argv contains `--update` / `-u` anywhere after argv[0].
/// Used at startup and by single-instance forwarding so a second `tedi --update`
/// triggers the in-app updater on the running window.
pub fn update_requested_in<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter().skip(1).any(|a| is_update_flag(a.as_ref()))
}

/// Capture the startup target. Call before any `set_current_dir` could shift
/// the cwd. Idempotent; only the first call wins.
pub fn capture_startup() {
    let cwd = match std::env::current_dir() {
        Ok(p) => p,
        Err(_) => return,
    };
    let args: Vec<String> = std::env::args().collect();
    let target = parse(args.clone(), &cwd);
    if let Ok(mut slot) = INITIAL_TARGET.lock() {
        if slot.is_none() {
            *slot = target;
        }
    }
    if update_requested_in(args.iter().map(|s| s.as_str())) {
        if let Ok(mut slot) = INITIAL_UPDATE_REQUEST.lock() {
            *slot = true;
        }
    }
}

/// Drain the captured target. Clears the slot so a window reload does not
/// re-trigger the initial open.
fn take_initial_target() -> Option<CliTarget> {
    INITIAL_TARGET.lock().ok().and_then(|mut slot| slot.take())
}

#[tauri::command]
pub fn cli_initial_target() -> Option<CliTarget> {
    take_initial_target()
}

/// Drain the captured update request. Returns true at most once per launch
/// so a webview reload does not re-trigger the dialog.
#[tauri::command]
pub fn cli_take_initial_update_request() -> bool {
    INITIAL_UPDATE_REQUEST
        .lock()
        .map(|mut slot| std::mem::replace(&mut *slot, false))
        .unwrap_or(false)
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ShimInstall {
    /// Shim was (re)written and is ready. `on_path` reflects whether
    /// `~/.local/bin` is on the user's `$PATH`. Unix only; Windows returns
    /// `NotApplicable`.
    #[allow(dead_code)]
    Installed {
        path: String,
        target: String,
        on_path: bool,
    },
    /// Platform handles `tedi` via its native installer (Windows -> NSIS).
    /// Frontend surfaces this as an info note, not an error.
    #[allow(dead_code)]
    NotApplicable { message: String },
}

/// Resolve the binary the shim should point at. On AppImage runs the usable
/// target is `$APPIMAGE` (the file the user keeps around), not the temp
/// `current_exe()` inside the squashfs mount which vanishes between runs.
#[cfg(unix)]
fn resolve_shim_target() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("APPIMAGE") {
        return Ok(PathBuf::from(p));
    }
    std::env::current_exe().map_err(|e| format!("could not resolve current exe: {e}"))
}

#[cfg(unix)]
fn shell_escape_single(s: &str) -> String {
    // POSIX-safe single-quote escape: foo -> 'foo', it'd -> 'it'\''d'
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Marker planted in every TEDI-written shim. `refresh_shim_if_present` uses
/// it to distinguish our shim from a user-authored `~/.local/bin/tedi`.
#[cfg(unix)]
const SHIM_MARKER: &str = "# tedi-cli-shim v1";

#[cfg(unix)]
fn render_shim(target: &std::path::Path) -> String {
    // POSIX wrapper. `exec` replaces the shell so no extra `sh` lingers.
    // Argv forwards verbatim; `tedi .` arrives as argv[1] = "." which
    // `capture_startup` resolves against the caller's cwd.
    format!(
        "#!/bin/sh\n{}\nexec {} \"$@\"\n",
        SHIM_MARKER,
        shell_escape_single(&target.to_string_lossy())
    )
}

#[cfg(unix)]
fn write_shim(shim_path: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(shim_path, render_shim(target).as_bytes())
        .map_err(|e| format!("could not write {}: {e}", shim_path.display()))?;
    let mut perms = std::fs::metadata(shim_path)
        .map_err(|e| format!("could not stat shim: {e}"))?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(shim_path, perms).map_err(|e| format!("could not chmod shim: {e}"))?;
    Ok(())
}

#[cfg(unix)]
fn install_shim_unix() -> Result<ShimInstall, String> {
    let home = dirs::home_dir().ok_or("could not determine HOME")?;
    let bin_dir = home.join(".local").join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("could not create {}: {e}", bin_dir.display()))?;

    let target = resolve_shim_target()?;
    let shim_path = bin_dir.join("tedi");
    write_shim(&shim_path, &target)?;

    let on_path = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d == bin_dir))
        .unwrap_or(false);

    Ok(ShimInstall::Installed {
        path: shim_path.to_string_lossy().into_owned(),
        target: target.to_string_lossy().into_owned(),
        on_path,
    })
}

/// Called once per launch from Tauri's `setup` hook. If a TEDI-owned shim
/// exists at `~/.local/bin/tedi`, rewrite it to point at the running binary.
/// Heals two upgrade scenarios that would otherwise break `tedi .`:
///
/// - macOS: user moves `TEDI.app`, so the absolute path in the shim is stale.
/// - Linux AppImage: user replaces `TEDI-0.2.0.AppImage` with a different
///   filename; `$APPIMAGE` points at the new file but the shim still
///   references the old one.
///
/// Untouched when the file is missing, lacks `SHIM_MARKER`, or already points
/// at the right target. Errors are swallowed; Settings -> Install exposes
/// the full error path.
pub fn refresh_shim_if_present() {
    #[cfg(unix)]
    {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let shim_path = home.join(".local").join("bin").join("tedi");
        let Ok(existing) = std::fs::read_to_string(&shim_path) else {
            return;
        };
        if !existing.contains(SHIM_MARKER) {
            return;
        }
        let Ok(target) = resolve_shim_target() else {
            return;
        };
        let desired = render_shim(&target);
        if existing == desired {
            return;
        }
        let _ = write_shim(&shim_path, &target);
    }
}

#[tauri::command]
pub fn cli_install_path_shim() -> Result<ShimInstall, String> {
    #[cfg(target_os = "windows")]
    {
        Ok(ShimInstall::NotApplicable {
            message: "On Windows the `tedi` command is installed by the NSIS \
                      installer (it drops a tedi.cmd shim and appends the \
                      install dir to your user PATH). Reinstall TEDI if it's \
                      missing."
                .into(),
        })
    }
    #[cfg(unix)]
    {
        install_shim_unix()
    }
}
