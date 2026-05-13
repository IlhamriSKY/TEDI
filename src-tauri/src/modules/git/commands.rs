use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW flag — prevents a console window from flashing on Windows
/// when we shell out to `git.exe`.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn git(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(repo);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn run(mut cmd: Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("git exited with status {}", out.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    /// Forward-slash absolute path to the working-tree file.
    pub path: String,
    /// Forward-slash repo-relative path (what git prints).
    pub relative: String,
    /// One of "modified", "added", "deleted", "renamed", "untracked", "conflicted".
    pub status: String,
    /// True if the entry is staged (index differs from HEAD).
    pub staged: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub changes: Vec<GitChange>,
}

fn to_forward(s: &str) -> String {
    s.replace('\\', "/")
}

fn classify(code: u8) -> &'static str {
    match code {
        b'M' => "modified",
        b'A' => "added",
        b'D' => "deleted",
        b'R' => "renamed",
        b'C' => "copied",
        b'U' => "conflicted",
        b'?' => "untracked",
        b'!' => "ignored",
        _ => "modified",
    }
}

fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut cmd = Command::new("git");
    cmd.arg("rev-parse").arg("--show-toplevel").current_dir(start);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

fn current_branch(repo: &Path) -> Option<String> {
    let mut cmd = git(repo);
    cmd.arg("rev-parse").arg("--abbrev-ref").arg("HEAD");
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s == "HEAD" {
        // detached HEAD — show the short SHA instead
        let mut sha = git(repo);
        sha.arg("rev-parse").arg("--short").arg("HEAD");
        let o = sha.output().ok()?;
        if !o.status.success() {
            return None;
        }
        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
    } else if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn parse_porcelain_v1(root: &Path, raw: &str) -> Vec<GitChange> {
    // Porcelain v1 with -z uses NUL as the entry separator and a second NUL
    // after the source path of a rename, so we cannot just split on '\n'.
    // Each entry is "XY <path>" (and "<src>" for renames).
    let mut out: Vec<GitChange> = Vec::new();
    let mut tokens = raw.split('\0').filter(|s| !s.is_empty()).peekable();
    while let Some(token) = tokens.next() {
        if token.len() < 4 {
            continue;
        }
        let bytes = token.as_bytes();
        let x = bytes[0];
        let y = bytes[1];
        // bytes[2] is the space
        let path = &token[3..];
        let is_rename = x == b'R' || y == b'R' || x == b'C' || y == b'C';
        // Renames are emitted as "R  new\0old" — consume the source path.
        if is_rename {
            let _src = tokens.next();
        }
        let staged = x != b' ' && x != b'?';
        let status_code = if x != b' ' && x != b'?' { x } else { y };
        let abs = root.join(path);
        out.push(GitChange {
            path: to_forward(&abs.to_string_lossy()),
            relative: to_forward(path),
            status: classify(status_code).to_string(),
            staged,
        });
    }
    out
}

#[tauri::command]
pub fn git_status(repo_path: String) -> Result<GitStatus, String> {
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Ok(GitStatus {
            is_repo: false,
            root: None,
            branch: None,
            changes: Vec::new(),
        });
    };

    let mut cmd = git(&root);
    cmd.args(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    let raw = run(cmd)?;
    let changes = parse_porcelain_v1(&root, &raw);

    Ok(GitStatus {
        is_repo: true,
        root: Some(to_forward(&root.to_string_lossy())),
        branch: current_branch(&root),
        changes,
    })
}

/// Returns the HEAD blob's contents for a working-tree path, or an empty
/// string if the file was added/untracked (no HEAD version).
#[tauri::command]
pub fn git_file_head(repo_path: String, relative: String) -> Result<String, String> {
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Err("not a git repository".into());
    };
    let mut cmd = git(&root);
    cmd.arg("show").arg(format!("HEAD:{}", relative));
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        // file likely didn't exist at HEAD (newly added / untracked)
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Discards working-tree changes for a single file. Untracked files are
/// removed from disk; tracked files are restored to their HEAD content.
#[tauri::command]
pub fn git_discard_file(repo_path: String, relative: String) -> Result<(), String> {
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Err("not a git repository".into());
    };

    // Probe: is this path tracked at HEAD?
    let mut probe = git(&root);
    probe.args(["ls-files", "--error-unmatch", "--", relative.as_str()]);
    #[cfg(windows)]
    probe.creation_flags(CREATE_NO_WINDOW);
    let tracked = probe
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    if tracked {
        // Unstage any staged hunks AND restore working tree to HEAD.
        let mut cmd = git(&root);
        cmd.args(["checkout", "HEAD", "--", relative.as_str()]);
        run(cmd)?;
        // `checkout HEAD --` leaves the index/staged copy intact when the
        // file was staged-only-deleted; force a reset of the index too.
        let mut reset = git(&root);
        reset.args(["reset", "HEAD", "--", relative.as_str()]);
        let _ = reset.output();
    } else {
        // Untracked — delete from disk.
        let abs = root.join(&relative);
        if abs.exists() {
            let meta = std::fs::symlink_metadata(&abs).map_err(|e| e.to_string())?;
            if meta.is_dir() {
                std::fs::remove_dir_all(&abs).map_err(|e| e.to_string())?;
            } else {
                std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

/// Discards every working-tree change AND removes untracked files.
/// Equivalent to `git reset --hard HEAD && git clean -fd`.
#[tauri::command]
pub fn git_discard_all(repo_path: String) -> Result<(), String> {
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Err("not a git repository".into());
    };

    let mut reset = git(&root);
    reset.args(["reset", "--hard", "HEAD"]);
    run(reset)?;

    let mut clean = git(&root);
    clean.args(["clean", "-fd"]);
    run(clean)?;
    Ok(())
}
