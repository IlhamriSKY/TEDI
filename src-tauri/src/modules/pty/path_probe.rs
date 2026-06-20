//! Probe a configured "Additional PATH" folder for known dev tools and their
//! versions, so the settings editor can show "composer 2.7.1 · php 8.3.1" and
//! flag a folder that doesn't exist or contains nothing recognizable.
//!
//! Detection also descends one level into immediate subfolders, so a Laragon
//! parent like `bin\php` resolves the versioned `bin\php\php-8.3.1-...` child
//! that actually holds the executable. `tool_subdirs` exposes that same
//! expansion to PATH assembly, so the tool actually runs in the terminal
//! instead of merely showing up as a detected badge.
//!
//! The probe runs each tool with the SAME assembled PATH a freshly opened
//! terminal would get (the user's other enabled dirs prepended) so a wrapper
//! like Laragon's `composer.bat`, which shells out to `php`, resolves the `php`
//! folder the user also configured. Without that, probing composer in isolation
//! would fail even though it works fine in a real terminal.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Per-tool probe timeout. A `--version` query returns in well under a second;
/// this only bounds a tool that hangs (e.g. one that blocks reading stdin).
const PROBE_TIMEOUT: Duration = Duration::from_secs(6);

struct KnownTool {
    /// Display name shown in the editor badge.
    name: &'static str,
    /// Executable base names to look for, first match wins. Platform extensions
    /// (.exe/.cmd/.bat on Windows) are appended by `find_exe`.
    bases: &'static [&'static str],
    /// Argument that prints a version line on stdout (or stderr).
    arg: &'static str,
}

/// Tools worth detecting in a Laragon / portable-toolchain `bin` folder.
const KNOWN_TOOLS: &[KnownTool] = &[
    KnownTool {
        name: "composer",
        bases: &["composer"],
        arg: "--version",
    },
    KnownTool {
        name: "php",
        bases: &["php"],
        arg: "--version",
    },
    KnownTool {
        name: "node",
        bases: &["node"],
        arg: "--version",
    },
    KnownTool {
        name: "npm",
        bases: &["npm"],
        arg: "--version",
    },
    KnownTool {
        name: "pnpm",
        bases: &["pnpm"],
        arg: "--version",
    },
    KnownTool {
        name: "yarn",
        bases: &["yarn"],
        arg: "--version",
    },
    KnownTool {
        name: "git",
        bases: &["git"],
        arg: "--version",
    },
    KnownTool {
        name: "python",
        bases: &["python", "python3"],
        arg: "--version",
    },
];

/// Executable extensions to try, in preference order. On Windows a bare name is
/// not executable, so we look for the wrapper/binary forms.
#[cfg(windows)]
const EXE_EXTS: &[&str] = &["exe", "cmd", "bat"];
#[cfg(not(windows))]
const EXE_EXTS: &[&str] = &[""];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolVersion {
    /// Logical tool name, e.g. "composer".
    tool: String,
    /// Extracted version, e.g. "2.7.1". Empty when the executable was found but
    /// the probe couldn't produce a version (timed out, exited non-zero, or
    /// e.g. composer with no `php` resolvable) - the UI shows "detected" then.
    version: String,
    /// File name actually executed, e.g. "composer.bat".
    exe: String,
    /// Immediate subfolder the exe was found in, relative to the configured
    /// dir, e.g. "php-8.3.1-Win32-vs16-x64". Empty when the exe sits directly in
    /// the configured folder. Surfaced so the badge shows which Laragon
    /// versioned child was picked (and added to PATH).
    subdir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathProbeResult {
    /// Whether the configured path exists and is a directory.
    is_dir: bool,
    /// Known tools detected in the folder (empty when none recognized).
    tools: Vec<ToolVersion>,
}

/// Probe `path` for known tools, building PATH from `extra_dirs` (the caller's
/// currently-enabled list) so wrappers resolve sibling tools. Falls back to the
/// persisted settings when `extra_dirs` is omitted.
#[tauri::command]
pub async fn terminal_probe_path(
    path: String,
    extra_dirs: Option<Vec<String>>,
) -> Result<PathProbeResult, String> {
    tauri::async_runtime::spawn_blocking(move || probe(path, extra_dirs))
        .await
        .map_err(|e| format!("join error: {e}"))
}

fn probe(path: String, extra_dirs: Option<Vec<String>>) -> PathProbeResult {
    #[cfg(windows)]
    let dir = PathBuf::from(path.replace('/', "\\"));
    #[cfg(not(windows))]
    let dir = PathBuf::from(&path);

    if !dir.is_dir() {
        return PathProbeResult {
            is_dir: false,
            tools: Vec::new(),
        };
    }

    // Same PATH a freshly opened terminal would get, so a wrapper that shells
    // out (composer.bat -> php) finds its sibling folder.
    let dirs = extra_dirs.unwrap_or_else(super::shell_init::user_extra_path_dirs);
    let extra_path = super::shell_init::assemble_path(&dirs);

    let mut tools = Vec::new();
    for tool in KNOWN_TOOLS {
        let Some(exe) = locate_tool(&dir, tool) else {
            continue;
        };
        let version = run_version(&exe, tool.arg, extra_path.as_ref())
            .map(|line| extract_version(&line))
            .unwrap_or_default();
        let exe_name = exe
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        // Non-empty only when the exe lived in a subfolder (Laragon layout).
        let subdir = exe
            .parent()
            .filter(|p| *p != dir.as_path())
            .and_then(Path::file_name)
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_string();
        tools.push(ToolVersion {
            tool: tool.name.to_string(),
            version,
            exe: exe_name,
            subdir,
        });
    }

    PathProbeResult {
        is_dir: true,
        tools,
    }
}

/// First executable matching `base` (+ platform extension) that exists in `dir`.
fn find_exe(dir: &Path, base: &str) -> Option<PathBuf> {
    for ext in EXE_EXTS {
        let name = if ext.is_empty() {
            base.to_string()
        } else {
            format!("{base}.{ext}")
        };
        let cand = dir.join(&name);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Locate `tool`'s executable directly in `dir`, or failing that in an
/// immediate subdirectory - Laragon nests toolchains in versioned children
/// (`bin\php\php-8.3.1-...\php.exe`), so the folder a user adds (`bin\php`) has
/// no executable itself. Subdirectories are tried in sorted order for a stable
/// pick when several versions sit side by side.
fn locate_tool(dir: &Path, tool: &KnownTool) -> Option<PathBuf> {
    if let Some(exe) = tool.bases.iter().find_map(|b| find_exe(dir, b)) {
        return Some(exe);
    }
    let mut subs = subdirs(dir);
    subs.sort();
    subs.iter()
        .find_map(|sub| tool.bases.iter().find_map(|b| find_exe(sub, b)))
}

/// Immediate subdirectories of `dir`, bounded so a pathological directory can't
/// make the probe (or PATH assembly) walk thousands of children.
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    match std::fs::read_dir(dir) {
        Ok(read) => read
            .flatten()
            .map(|e| e.path())
            .take(512)
            .filter(|p| p.is_dir())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// True when `dir` directly holds at least one recognized dev-tool executable.
fn dir_contains_known_tool(dir: &Path) -> bool {
    KNOWN_TOOLS
        .iter()
        .any(|t| t.bases.iter().any(|b| find_exe(dir, b).is_some()))
}

/// `dir`'s immediate subdirectories that directly contain a recognized tool
/// executable. Lets `assemble_path` expand a Laragon parent like `bin\php` to
/// the versioned child (`bin\php\php-8.3.1-...`) that actually holds the exe, so
/// the tool resolves in the terminal without the user adding the deep path by
/// hand. Sorted for a stable PATH order across runs.
pub(crate) fn tool_subdirs(dir: &Path) -> Vec<PathBuf> {
    let mut subs: Vec<PathBuf> = subdirs(dir)
        .into_iter()
        .filter(|p| dir_contains_known_tool(p))
        .collect();
    subs.sort();
    subs
}

/// Run `<exe> <arg>` with a bounded timeout, returning the first non-empty
/// output line on a clean (zero-exit) run. `extra_path` overrides PATH for the
/// child so a wrapper resolves sibling tools. Returns `None` on spawn failure,
/// timeout, a non-zero exit, or empty output.
fn run_version(exe: &Path, arg: &str, extra_path: Option<&std::ffi::OsString>) -> Option<String> {
    let mut cmd = Command::new(exe);
    cmd.arg(arg)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(p) = extra_path {
        cmd.env("PATH", p);
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().ok()?;
    // Keep the pipe handles alive so we can read them after the process exits.
    let mut stdout = child.stdout.take();
    let mut stderr = child.stderr.take();

    let deadline = Instant::now() + PROBE_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }

    // The child has exited and version output is small, so draining both pipes
    // to EOF here cannot block. Read both: a CLI (or a wrapper like
    // composer.bat -> php) may print its real version to stdout while emitting
    // PHP/Imagick startup warnings to stderr, or mix the two onto one stream.
    let mut out = String::new();
    if let Some(mut p) = stdout.take() {
        let _ = p.read_to_string(&mut out);
    }
    let mut err = String::new();
    if let Some(mut p) = stderr.take() {
        let _ = p.read_to_string(&mut err);
    }
    pick_version_line(&out).or_else(|| pick_version_line(&err))
}

/// True for a PHP/Imagick startup diagnostic line (Warning/Notice/Deprecated)
/// that a CLI or its wrapper may print before its own version output - e.g.
/// "Warning: Version warning: Imagick was compiled against ImageMagick ...".
/// Without skipping these, the first output line is mistaken for the version.
fn is_noise_line(line: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "Warning",
        "Notice",
        "Deprecated",
        "Strict Standards",
        "PHP Warning",
        "PHP Notice",
        "PHP Deprecated",
        "PHP Strict Standards",
    ];
    PREFIXES.iter().any(|p| line.starts_with(p))
}

/// Choose the version line from a tool's captured output, skipping startup
/// diagnostics (see `is_noise_line`). Prefers a line carrying a dotted version
/// token; otherwise the first non-noise line. Returns `None` when only noise or
/// blanks remain, so the UI shows "detected" instead of a stray warning.
fn pick_version_line(text: &str) -> Option<String> {
    let mut first_clean: Option<&str> = None;
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || is_noise_line(line) {
            continue;
        }
        if find_dotted_token(line).is_some() {
            return Some(line.to_string());
        }
        if first_clean.is_none() {
            first_clean = Some(line);
        }
    }
    first_clean.map(str::to_string)
}

/// First dotted numeric token (e.g. "2.7.1", "20.10.0") in `line`, if any.
fn find_dotted_token(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            let tok = line[start..i].trim_end_matches('.');
            if tok.contains('.') {
                return Some(tok);
            }
        } else {
            i += 1;
        }
    }
    None
}

/// Pull a version token (e.g. "2.7.1", "20.10.0") out of a tool's version line,
/// falling back to the whole trimmed line when no dotted number is present.
fn extract_version(line: &str) -> String {
    find_dotted_token(line)
        .unwrap_or_else(|| line.trim())
        .to_string()
}
