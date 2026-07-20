use std::fs;
use std::path::{Path, PathBuf};

use portable_pty::CommandBuilder;

/// Shared shell-integration helpers (platform-neutral; used by both submodules).
fn integration_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home dir".to_string())?;
    let root = home.join(".cache").join("tedi").join("shell-integration");
    fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    Ok(root)
}

fn write_if_changed(path: &Path, content: &str) -> Result<(), String> {
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    // Atomic replace so a parallel shell startup never sources a half-written file.
    crate::modules::fs::atomic::atomic_write(path, content.as_bytes())
        .map_err(|e| format!("write {}: {e}", path.display()))
}

pub fn build_command(cwd: Option<String>) -> Result<CommandBuilder, String> {
    #[cfg(unix)]
    {
        unix::build(cwd)
    }
    #[cfg(windows)]
    {
        windows::build(cwd)
    }
}

fn ensure_utf8_locale(cmd: &mut CommandBuilder) {
    let is_utf8 = |v: &str| {
        let up = v.to_ascii_uppercase();
        up.contains("UTF-8") || up.contains("UTF8")
    };
    let already_utf8 = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .any(|k| std::env::var(k).ok().as_deref().is_some_and(is_utf8));
    if already_utf8 {
        return;
    }
    #[cfg(target_os = "macos")]
    let fallback = "en_US.UTF-8";
    #[cfg(all(unix, not(target_os = "macos")))]
    let fallback = "C.UTF-8";
    #[cfg(windows)]
    let fallback = "en_US.UTF-8";
    cmd.env("LANG", fallback);
}

fn apply_common(cmd: &mut CommandBuilder, cwd: Option<String>) {
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TEDI_TERMINAL", "1");
    ensure_utf8_locale(cmd);
    apply_extra_path(cmd);

    let resolved_cwd = cwd
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
        .or_else(|| dirs::home_dir().filter(|p| p.is_dir()))
        .or_else(|| std::env::current_dir().ok());
    if let Some(cwd) = resolved_cwd {
        #[cfg(windows)]
        let cwd = PathBuf::from(cwd.to_string_lossy().replace('/', "\\"));
        log::info!("pty cwd: {}", cwd.display());
        cmd.cwd(cwd);
    } else {
        log::warn!("pty cwd: no usable directory, inheriting from process");
    }
}

/// Directories the user configured under Settings → Terminal → "Additional
/// PATH". Read straight from the `tauri-plugin-store` settings file rather than
/// threaded through the daemon protocol: `apply_common` runs in whichever
/// process owns the PTY (the GUI for the in-process backend, the sidecar for
/// the daemon backend), and both resolve the same
/// `<data_dir>/<BUNDLE_ID>/tedi-settings.json`. Reading per spawn keeps the
/// setting live - a newly opened terminal sees edits without a daemon restart.
///
/// The plugin-store writes via a non-atomic `fs::write` (truncate-in-place), so
/// a spawn's read can rarely land between the truncate and the rewrite and see
/// an empty / partial file. Retry a couple of times with a short sleep before
/// giving up; the completed file is present on the retry. Any persistent
/// missing-file / parse error yields no extra entries so the shell still
/// launches with the inherited PATH.
pub(crate) fn user_extra_path_dirs() -> Vec<String> {
    let Some(dir) = crate::modules::ids::app_data_dir() else {
        return Vec::new();
    };
    let path = dir.join("tedi-settings.json");
    for attempt in 0..3 {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if !raw.trim().is_empty() {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
                    return parse_extra_path_entries(&value);
                }
            }
        }
        // Empty / partial read (or a transient lock): back off briefly and try
        // the completed file instead of falling straight back to no entries.
        if attempt < 2 {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    Vec::new()
}

/// Pull the enabled `terminalEnvPath` directories out of the parsed settings.
fn parse_extra_path_entries(value: &serde_json::Value) -> Vec<String> {
    let Some(arr) = value.get("terminalEnvPath").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|entry| match entry {
            // Legacy shape: a bare string is always enabled.
            serde_json::Value::String(s) => Some(s.as_str()),
            // Current shape: { "path": "…", "enabled": bool }. A missing
            // `enabled` defaults to true; an explicit `false` drops the entry
            // so a user can keep a directory listed but inactive.
            serde_json::Value::Object(_) => {
                let enabled = entry
                    .get("enabled")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(true);
                if enabled {
                    entry.get("path").and_then(serde_json::Value::as_str)
                } else {
                    None
                }
            }
            _ => None,
        })
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// Platform PATH-list separator (`;` on Windows, `:` elsewhere). Distinct from
/// the path-component separator (`\` / `/`).
#[cfg(windows)]
const PATH_LIST_SEP: char = ';';
#[cfg(not(windows))]
const PATH_LIST_SEP: char = ':';

/// Strip one surrounding pair of double quotes (Windows "Copy as path" yields
/// `"C:\…"`), returning the trimmed remainder.
fn strip_quotes(s: &str) -> &str {
    let t = s.trim();
    let b = t.as_bytes();
    if b.len() >= 2 && b[0] == b'"' && b[b.len() - 1] == b'"' {
        t[1..t.len() - 1].trim()
    } else {
        t
    }
}

/// Dedup key for a PATH directory: unify slashes + case-fold on Windows, drop a
/// trailing separator everywhere, so `C:/Tools\`, `C:\Tools` and `c:\tools`
/// collapse to one.
fn path_dedup_key(p: &str) -> String {
    #[cfg(windows)]
    {
        p.replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        p.trim_end_matches('/').to_string()
    }
}

/// Build a PATH value with `extra_dirs` prepended to the inherited PATH, or
/// `None` when nothing valid is configured (caller leaves PATH inherited).
///
/// Prepended so user entries win over inherited ones (run a Laragon `composer`
/// without editing the OS PATH). Hardened beyond a naive prepend:
/// - strips surrounding quotes from a pasted path,
/// - skips a single entry containing the list separator instead of failing the
///   whole list (`join_paths` is all-or-nothing), so one bad `a;b` paste can't
///   drop every other configured dir,
/// - de-duplicates (case-insensitively on Windows), INCLUDING against the
///   inherited PATH, so a dir the OS already exports isn't listed twice.
///
/// `cmd.env("PATH", …)` then overrides rather than duplicates: portable-pty and
/// std both case-fold env keys on Windows, so this replaces the inherited
/// `Path` rather than adding a second variable.
pub(crate) fn assemble_path(extra_dirs: &[String]) -> Option<std::ffi::OsString> {
    if extra_dirs.is_empty() {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    let mut entries: Vec<PathBuf> = Vec::new();

    for dir in extra_dirs {
        let stripped = strip_quotes(dir);
        if stripped.is_empty() {
            continue;
        }
        if stripped.contains(PATH_LIST_SEP) {
            log::warn!(
                "terminal additional PATH entry skipped (contains '{PATH_LIST_SEP}'): {stripped}"
            );
            continue;
        }
        // A user may paste forward-slash paths from the explorer; Windows tools
        // resolve PATH entries via backslashes, so normalize there.
        #[cfg(windows)]
        let cleaned: String = stripped.replace('/', "\\");
        #[cfg(not(windows))]
        let cleaned: String = stripped.to_string();
        let key = path_dedup_key(&cleaned);
        if key.is_empty() || !seen.insert(key) {
            continue;
        }
        let cleaned = PathBuf::from(cleaned);
        // Laragon nests toolchains in versioned subfolders, so the folder a user
        // naturally adds (`bin\php`) has no executable itself - the child
        // (`bin\php\php-8.3.1-...`) does. Expand to those children so the tool
        // resolves in the terminal without hunting for the exact versioned path.
        // The child is listed before the parent (parent stays on PATH, harmless)
        // so it wins, and goes through `seen` so nothing is duplicated.
        for sub in super::path_probe::tool_subdirs(&cleaned) {
            if seen.insert(path_dedup_key(&sub.to_string_lossy())) {
                entries.push(sub);
            }
        }
        entries.push(cleaned);
    }

    // Nothing the user configured survived: leave the inherited PATH untouched.
    if entries.is_empty() {
        return None;
    }

    let current = std::env::var_os("PATH").unwrap_or_default();
    for p in std::env::split_paths(&current) {
        if p.as_os_str().is_empty() {
            continue;
        }
        // Skip an inherited dir already contributed by a user entry so the
        // assembled PATH doesn't list the same directory twice.
        if !seen.insert(path_dedup_key(&p.to_string_lossy())) {
            continue;
        }
        entries.push(p);
    }

    match std::env::join_paths(&entries) {
        Ok(joined) => Some(joined),
        // Should not happen now (separator-bearing user entries are filtered and
        // inherited entries never contain the separator), but stay defensive:
        // leave PATH untouched rather than corrupting the whole variable.
        Err(e) => {
            log::warn!("terminal additional PATH skipped: {e}");
            None
        }
    }
}

/// Prepend the user's configured directories to the spawned shell's PATH so
/// commands living there (a Laragon `composer`, a portable toolchain, …)
/// resolve in the interactive terminal without editing the OS-level PATH.
/// No-op when nothing is configured.
fn apply_extra_path(cmd: &mut CommandBuilder) {
    if let Some(joined) = assemble_path(&user_extra_path_dirs()) {
        cmd.env("PATH", joined);
    }
}

#[cfg(unix)]
mod unix {
    use std::fs;
    use std::path::{Path, PathBuf};

    use portable_pty::CommandBuilder;

    const ZSHENV: &str = include_str!("scripts/zshenv.zsh");
    const ZPROFILE: &str = include_str!("scripts/zprofile.zsh");
    const ZLOGIN: &str = include_str!("scripts/zlogin.zsh");
    const ZSHRC: &str = include_str!("scripts/zshrc.zsh");
    const BASHRC: &str = include_str!("scripts/bashrc.bash");
    const FISH_INIT: &str = include_str!("scripts/init.fish");

    pub enum Shell {
        Zsh,
        Bash,
        Fish,
        Other,
    }

    impl Shell {
        pub fn detect() -> (Shell, String) {
            let path = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let name = path.rsplit('/').next().unwrap_or("").to_string();
            let shell = match name.as_str() {
                "zsh" => Shell::Zsh,
                "bash" => Shell::Bash,
                "fish" => Shell::Fish,
                _ => Shell::Other,
            };
            (shell, path)
        }
    }

    pub fn build(cwd: Option<String>) -> Result<CommandBuilder, String> {
        let (shell, shell_path) = Shell::detect();
        let mut cmd = CommandBuilder::new(&shell_path);
        super::apply_common(&mut cmd, cwd);

        match shell {
            Shell::Zsh => {
                match prepare_zdotdir() {
                    Ok(zdotdir) => {
                        if let Ok(user_zd) = std::env::var("ZDOTDIR") {
                            cmd.env("TEDI_USER_ZDOTDIR", user_zd);
                        }
                        cmd.env("ZDOTDIR", zdotdir);
                    }
                    Err(e) => {
                        log::warn!("zsh shell integration disabled: {e}");
                    }
                }
                // Login shell so /etc/zprofile runs path_helper on macOS.
                // Without -l, GUI-launched apps get a minimal PATH missing Homebrew.
                cmd.arg("-l");
            }
            Shell::Bash => {
                match prepare_bash_rcfile() {
                    Ok(rc) => {
                        cmd.arg("--rcfile");
                        cmd.arg(rc);
                    }
                    Err(e) => {
                        log::warn!("bash shell integration disabled: {e}");
                    }
                }
                // bash ignores --rcfile under -l, so we use -i and source
                // /etc/profile from inside the rcfile to emulate login init.
                cmd.arg("-i");
            }
            Shell::Fish => {
                match prepare_fish_init() {
                    Ok(init) => {
                        cmd.arg("--init-command");
                        cmd.arg(format!("source {}", shell_quote(&init)));
                    }
                    Err(e) => {
                        log::warn!("fish shell integration disabled: {e}");
                    }
                }
                cmd.arg("-i");
            }
            Shell::Other => {
                log::info!(
                    "unsupported shell '{}', spawning without integration",
                    shell_path
                );
            }
        }
        Ok(cmd)
    }

    fn shell_quote(p: &Path) -> String {
        let s = p.to_string_lossy();
        format!("'{}'", s.replace('\'', "'\\''"))
    }

    fn prepare_zdotdir() -> Result<PathBuf, String> {
        let dir = super::integration_root()?.join("zsh");
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        super::write_if_changed(&dir.join(".zshenv"), ZSHENV)?;
        super::write_if_changed(&dir.join(".zprofile"), ZPROFILE)?;
        super::write_if_changed(&dir.join(".zshrc"), ZSHRC)?;
        super::write_if_changed(&dir.join(".zlogin"), ZLOGIN)?;
        Ok(dir)
    }

    fn prepare_bash_rcfile() -> Result<PathBuf, String> {
        let dir = super::integration_root()?.join("bash");
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let rc = dir.join("bashrc");
        super::write_if_changed(&rc, BASHRC)?;
        Ok(rc)
    }

    fn prepare_fish_init() -> Result<PathBuf, String> {
        let dir = super::integration_root()?.join("fish");
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let init = dir.join("init.fish");
        super::write_if_changed(&init, FISH_INIT)?;
        Ok(init)
    }
}

#[cfg(windows)]
mod windows {
    use std::fs;
    use std::path::PathBuf;

    use portable_pty::CommandBuilder;

    const PROFILE_PS1: &str = include_str!("scripts/profile.ps1");

    pub fn build(cwd: Option<String>) -> Result<CommandBuilder, String> {
        let shell_path = super::windows_shell_path();
        let shell_name = shell_path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();
        let is_powershell = shell_name == "pwsh.exe" || shell_name == "powershell.exe";

        let mut cmd = CommandBuilder::new(&shell_path);
        super::apply_common(&mut cmd, cwd);

        if is_powershell {
            match prepare_ps_profile() {
                Ok(profile) => {
                    cmd.arg("-NoLogo");
                    cmd.arg("-NoExit");
                    cmd.arg("-ExecutionPolicy");
                    cmd.arg("Bypass");
                    cmd.arg("-File");
                    cmd.arg(profile);
                }
                Err(e) => {
                    log::warn!("powershell shell integration disabled: {e}");
                }
            }
        } else {
            log::info!("spawning {} without shell integration", shell_name);
        }

        log::info!("spawning Windows shell: {}", shell_path.display());
        Ok(cmd)
    }

    fn prepare_ps_profile() -> Result<PathBuf, String> {
        let dir = super::integration_root()?.join("powershell");
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
        let file = dir.join("profile.ps1");
        super::write_if_changed(&file, PROFILE_PS1)?;
        Ok(file)
    }
}

#[cfg(windows)]
pub fn windows_shell_path() -> PathBuf {
    if let Some(p) = which_in_path("pwsh.exe") {
        return p;
    }

    if let Some(pf) = std::env::var_os("ProgramFiles").map(PathBuf::from) {
        let candidate = pf.join("PowerShell").join("7").join("pwsh.exe");
        if candidate.is_file() {
            return candidate;
        }
    }

    let system32 = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32");
    let ps5 = system32
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if ps5.is_file() {
        return ps5;
    }

    system32.join("cmd.exe")
}

#[cfg(windows)]
fn which_in_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
