//! CLI argument handling for `tedi .` / `tedi <path>`.
//!
//! Captures the first positional argument from `argv` once at process start
//! (so a later `set_current_dir` can't move the resolution out from under us),
//! resolves it to an absolute path against the launch cwd, and classifies it
//! as a folder or file. The frontend pulls this via `cli_initial_target` on
//! boot and again via the `tedi:open-cli-target` event when `tauri-plugin-single-instance`
//! forwards a fresh invocation into the running window.

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

/// Returns true if `s` looks like a Tauri/webview flag (`--foo`, `-bar`) and
/// should be skipped when scanning for the positional path arg.
fn is_flag(s: &str) -> bool {
    s.starts_with('-')
}

fn is_version_flag(s: &str) -> bool {
    matches!(s, "--version" | "-V")
}

fn is_help_flag(s: &str) -> bool {
    matches!(s, "--help" | "-h")
}

fn help_text() -> String {
    // Hand-laid out: backslash-continuation in Rust strings eats leading
    // whitespace on the next line, which makes the aligned wrap under "PATH"
    // collapse to flush-left. `concat!` keeps every line literal so the
    // 21-space indent below "Folder to open" stays put.
    concat!(
        "TEDI ",
        env!("CARGO_PKG_VERSION"),
        " — Terminal Environment & Development Infrastructure\n",
        "\n",
        "USAGE:\n",
        "    tedi [PATH]\n",
        "    tedi [FLAG]\n",
        "\n",
        "If TEDI is already running, the request is forwarded to that window\n",
        "(a second window is not opened).\n",
        "\n",
        "FLAGS:\n",
        "    -h, --help       Print this help and exit\n",
        "    -V, --version    Print version and exit\n",
        "\n",
        "ARGS:\n",
        "    PATH             Folder to open, or file to edit. Use `.` for the\n",
        "                     current directory. Relative paths resolve against\n",
        "                     the shell's cwd.",
    )
    .to_string()
}

/// Short-circuit `--version` / `--help` before any GUI setup runs. Called at
/// the very top of `lib::run`. Matches anywhere in argv (not just argv[1]) so
/// `tedi <path> --version` still prints version.
///
/// On Windows release builds the GUI binary has `windows_subsystem = "windows"`
/// — stdout is detached from the parent console, so this `println!` is
/// invisible. The `installer.nsh`-generated `tedi.cmd` shim intercepts the
/// same flags *before* launching the EXE and prints there instead, so users
/// who invoke `tedi --version` from a terminal always see output. Direct
/// `TEDI.exe --version` is an edge case and accepts the silence.
pub fn handle_version_help_and_exit() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().skip(1).any(|a| is_version_flag(a)) {
        println!("{} {}", env!("CARGO_PKG_NAME"), env!("CARGO_PKG_VERSION"));
        std::process::exit(0);
    }
    if args.iter().skip(1).any(|a| is_help_flag(a)) {
        println!("{}", help_text());
        std::process::exit(0);
    }
}

/// Pick the first non-flag arg after argv\[0\]. Returns `None` if no positional
/// arg was passed.
fn first_positional<I>(args: I) -> Option<String>
where
    I: IntoIterator<Item = String>,
{
    args.into_iter().skip(1).find(|a| !is_flag(a))
}

/// Resolve `raw` against `base`. Relative paths join `base`; absolute paths
/// pass through. We deliberately avoid `canonicalize` because on Windows it
/// returns UNC paths (`\\?\C:\...`) that `portable-pty` and the rest of the
/// frontend don't handle uniformly.
fn resolve(base: &Path, raw: &str) -> PathBuf {
    let p = Path::new(raw);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base.join(p)
    }
}

/// Normalise to forward-slash form to match the frontend's canonical path
/// representation (see [TEDI.md] §UI conventions).
fn to_forward_slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// Classify a resolved path. Missing paths and anything that isn't a regular
/// file or directory are dropped (return `None`).
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

/// Parse `argv` against `cwd` into a `CliTarget`. Used by both startup
/// (against `std::env::args()`) and single-instance forwarding (against the
/// new process's argv).
pub fn parse(args: Vec<String>, cwd: &Path) -> Option<CliTarget> {
    let raw = first_positional(args)?;
    let resolved = resolve(cwd, &raw);
    classify(&resolved)
}

/// Capture the startup target. Called from `lib::run` before any `set_current_dir`
/// could shift the cwd. Idempotent — only the first call wins.
pub fn capture_startup() {
    let cwd = match std::env::current_dir() {
        Ok(p) => p,
        Err(_) => return,
    };
    let target = parse(std::env::args().collect(), &cwd);
    if let Ok(mut slot) = INITIAL_TARGET.lock() {
        if slot.is_none() {
            *slot = target;
        }
    }
}

/// Drain the captured target. Returns it and clears the slot so a window
/// reload doesn't re-trigger the initial open.
fn take_initial_target() -> Option<CliTarget> {
    INITIAL_TARGET.lock().ok().and_then(|mut slot| slot.take())
}

#[tauri::command]
pub fn cli_initial_target() -> Option<CliTarget> {
    take_initial_target()
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ShimInstall {
    /// Shim was (re)written and is ready to use. `on_path` reflects whether
    /// `~/.local/bin` is currently on the user's `$PATH`. Only constructed on
    /// unix targets — the Windows branch returns `NotApplicable`.
    #[allow(dead_code)]
    Installed {
        path: String,
        target: String,
        on_path: bool,
    },
    /// Platform handles `tedi` via its native installer (Windows → NSIS).
    /// The frontend should surface this as an informational note, not an error.
    #[allow(dead_code)]
    NotApplicable { message: String },
}

/// Resolve the binary the shim should point at. On AppImage Linux runs the
/// usable target is `$APPIMAGE` (the .AppImage file the user keeps around),
/// not the temp `current_exe()` which lives inside the squashfs mount and
/// disappears between invocations.
#[cfg(unix)]
fn resolve_shim_target() -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("APPIMAGE") {
        return Ok(PathBuf::from(p));
    }
    std::env::current_exe().map_err(|e| format!("could not resolve current exe: {e}"))
}

#[cfg(unix)]
fn shell_escape_single(s: &str) -> String {
    // POSIX-safe single-quote escape: 'foo' → 'foo', it'd → 'it'\''d'
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

/// Marker we plant in every TEDI-written shim. `refresh_shim_if_present`
/// uses it to tell our shim apart from a user-authored `~/.local/bin/tedi`
/// (which we must not clobber).
#[cfg(unix)]
const SHIM_MARKER: &str = "# tedi-cli-shim v1";

#[cfg(unix)]
fn render_shim(target: &std::path::Path) -> String {
    // POSIX wrapper. `exec` replaces the shell so the caller doesn't keep an
    // extra `sh` process around. Argv is forwarded verbatim — `tedi .` lands
    // in Rust as argv[1] = "." which `capture_startup` resolves against the
    // caller's cwd.
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

/// Called once per app launch (from Tauri's `setup` hook). If a TEDI-owned
/// shim already exists at `~/.local/bin/tedi`, rewrite it to point at the
/// currently-running binary. Heals two upgrade scenarios that would otherwise
/// silently break `tedi .`:
///
/// * **macOS**: user moves `TEDI.app` between folders, so the old absolute
///   path baked into the shim is stale.
/// * **Linux AppImage**: user replaces `TEDI-0.2.0.AppImage` with
///   `TEDI-0.3.0.AppImage` (different filename) — `$APPIMAGE` now points to
///   the new file, but the shim still references the old one.
///
/// Untouched if:
/// * The file doesn't exist (user never opted in via Settings).
/// * The file lacks our `SHIM_MARKER` (it's a user-authored script we must
///   not clobber).
/// * The file already points at the right target (avoids spurious mtime
///   churn on every launch).
///
/// Errors are swallowed: a stale shim is a UX papercut, not a launch
/// blocker. Settings → "Install" still exposes the full error path.
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
