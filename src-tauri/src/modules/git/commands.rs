use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;

use serde::Serialize;

use crate::modules::fs::file::{classify_bytes, ReadResult};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// CREATE_NO_WINDOW flag. Prevents a console window from flashing on Windows
/// when shelling out to `git.exe`.
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
    /// True when the entry is staged (index differs from HEAD).
    pub staged: bool,
    /// Lines added relative to HEAD. 0 when unknown or binary.
    pub added: u32,
    /// Lines removed relative to HEAD. 0 when unknown or binary.
    pub removed: u32,
    /// True when git reported the entry as binary (line counts meaningless).
    pub binary: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    /// Tracking branch like "origin/main", or `None` when no upstream is set.
    pub upstream: Option<String>,
    /// Commits ahead of upstream (HEAD has but upstream lacks).
    pub ahead: u32,
    /// Commits behind upstream (upstream has but HEAD lacks).
    pub behind: u32,
    pub changes: Vec<GitChange>,
}

fn to_forward(s: &str) -> String {
    s.replace('\\', "/")
}

/// Git's well-known empty-tree object. Diffing a root commit against this
/// renders every file as added, matching `git show --root`.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Accept only hex revisions (full / abbreviated SHAs). Guards the commit
/// commands against a frontend-supplied value that begins with `-` being
/// reinterpreted as a git option, and rejects refspecs we never pass.
fn is_valid_rev(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit())
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
    cmd.arg("rev-parse")
        .arg("--show-toplevel")
        .current_dir(start);
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
        // detached HEAD: show the short SHA instead
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

fn upstream_and_counts(repo: &Path) -> (Option<String>, u32, u32) {
    let mut up = git(repo);
    up.arg("rev-parse").arg("--abbrev-ref").arg("@{u}");
    let upstream = match up.output() {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() {
                None
            } else {
                Some(s)
            }
        }
        _ => None,
    };
    if upstream.is_none() {
        return (None, 0, 0);
    }
    let mut counts = git(repo);
    counts.args(["rev-list", "--left-right", "--count", "HEAD...@{u}"]);
    let (ahead, behind) = match counts.output() {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout);
            let mut parts = s.split_whitespace();
            let a: u32 = parts.next().and_then(|t| t.parse().ok()).unwrap_or(0);
            let b: u32 = parts.next().and_then(|t| t.parse().ok()).unwrap_or(0);
            (a, b)
        }
        _ => (0, 0),
    };
    (upstream, ahead, behind)
}

fn parse_porcelain_v1(root: &Path, raw: &str) -> Vec<GitChange> {
    // Porcelain v1 with -z uses NUL as the entry separator and a second NUL
    // after the source path of a rename. Each entry is "XY <path>" plus
    // "<src>" for renames.
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
        // Renames are emitted as "R  new\0old"; consume the source path.
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
            added: 0,
            removed: 0,
            binary: false,
        });
    }
    out
}

#[derive(Debug, Default, Clone, Copy)]
struct NumstatEntry {
    added: u32,
    removed: u32,
    binary: bool,
}

/// Parse `git diff --numstat HEAD` output. Each non-empty line is
/// `<added>\t<removed>\t<path>`; binary files show "-" for both counts.
/// Renames appear as "old => new" or the compact "dir/{old => new}/file";
/// normalized to the new path so it matches the porcelain status output.
fn parse_numstat(raw: &str) -> HashMap<String, NumstatEntry> {
    let mut out: HashMap<String, NumstatEntry> = HashMap::new();
    for line in raw.lines() {
        let mut parts = line.splitn(3, '\t');
        let (Some(a), Some(r), Some(p)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let binary = a == "-" || r == "-";
        let added: u32 = if binary { 0 } else { a.parse().unwrap_or(0) };
        let removed: u32 = if binary { 0 } else { r.parse().unwrap_or(0) };
        let rel = rename_new_side(p);
        out.insert(
            to_forward(&rel),
            NumstatEntry {
                added,
                removed,
                binary,
            },
        );
    }
    out
}

fn rename_new_side(p: &str) -> String {
    // Compact form: "prefix/{old => new}/suffix" becomes "prefix/new/suffix"
    if let Some(brace) = p.find('{') {
        let prefix = &p[..brace];
        let rest = &p[brace + 1..];
        if let Some(arrow) = rest.find(" => ") {
            let after = &rest[arrow + 4..];
            if let Some(close) = after.find('}') {
                let new_mid = &after[..close];
                let suffix = &after[close + 1..];
                return format!("{prefix}{new_mid}{suffix}");
            }
        }
    }
    // Simple form: "old => new"
    if let Some(idx) = p.find(" => ") {
        return p[idx + 4..].to_string();
    }
    p.to_string()
}

/// Count newlines in a working-tree file for an untracked entry. Capped so
/// we do not read multi-megabyte logs just to render a `+N` chip. Returns
/// `None` for binary or oversize files.
fn count_file_lines(path: &str) -> Option<u32> {
    let meta = std::fs::metadata(path).ok()?;
    // Skip anything larger than 512KB. Counting lines in a giant log tells
    // the user nothing useful and stalls the refresh.
    if meta.len() > 512 * 1024 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    // Quick binary sniff: a NUL byte in the first 8KB means not text.
    let sniff_len = bytes.len().min(8192);
    if bytes[..sniff_len].contains(&0u8) {
        return None;
    }
    let text = std::str::from_utf8(&bytes).ok()?;
    if text.is_empty() {
        return Some(0);
    }
    let n = text.matches('\n').count() as u32;
    Some(if text.ends_with('\n') { n } else { n + 1 })
}

#[tauri::command]
pub fn git_status(repo_path: String) -> Result<GitStatus, String> {
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Ok(GitStatus {
            is_repo: false,
            root: None,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            changes: Vec::new(),
        });
    };

    // Fan out four independent git subprocesses. Each spawn on Windows costs
    // ~10ms; serial runs added ~40ms per refresh (the panel auto-polls).
    // Joining here keeps the API sync. Tauri runs each `#[tauri::command]`
    // on its worker pool, so blocking is fine.
    let status_handle = {
        let root = root.clone();
        thread::spawn(move || {
            let mut cmd = git(&root);
            cmd.args(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
            run(cmd)
        })
    };
    let branch_handle = {
        let root = root.clone();
        thread::spawn(move || current_branch(&root))
    };
    let upstream_handle = {
        let root = root.clone();
        thread::spawn(move || upstream_and_counts(&root))
    };
    let numstat_handle = {
        let root = root.clone();
        thread::spawn(move || {
            let mut nc = git(&root);
            nc.args(["diff", "--numstat", "HEAD"]);
            nc.output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default()
        })
    };

    let raw = status_handle
        .join()
        .map_err(|_| "git status thread panicked".to_string())??;
    let branch = branch_handle
        .join()
        .map_err(|_| "branch thread panicked".to_string())?;
    let (upstream, ahead, behind) = upstream_handle
        .join()
        .map_err(|_| "upstream thread panicked".to_string())?;
    let stats_raw = numstat_handle
        .join()
        .map_err(|_| "numstat thread panicked".to_string())?;

    let mut changes = parse_porcelain_v1(&root, &raw);
    let stats = parse_numstat(&stats_raw);
    for c in changes.iter_mut() {
        if let Some(s) = stats.get(&c.relative) {
            c.added = s.added;
            c.removed = s.removed;
            c.binary = s.binary;
        } else if c.status == "untracked" {
            match count_file_lines(&c.path) {
                Some(n) => c.added = n,
                None => c.binary = true,
            }
        }
    }

    Ok(GitStatus {
        is_repo: true,
        root: Some(to_forward(&root.to_string_lossy())),
        branch,
        upstream,
        ahead,
        behind,
        changes,
    })
}

/// Read a blob at `rev` for a repo-relative path (`git show <rev>:<path>`),
/// classified like `fs_read_file` (text / image / binary). A path absent at
/// that revision (added later, deleted, or a rename's other side) yields an
/// empty `Text` so the diff side renders blank. Raw stdout bytes are
/// preserved so PNG/JPEG blobs survive the Tauri boundary without lossy
/// UTF-8 decoding.
fn show_blob(root: &Path, rev: &str, relative: &str) -> ReadResult {
    let mut cmd = git(root);
    cmd.arg("show").arg(format!("{rev}:{relative}"));
    let out = match cmd.output() {
        Ok(o) => o,
        Err(_) => {
            return ReadResult::Text {
                content: String::new(),
                size: 0,
            }
        }
    };
    if !out.status.success() {
        return ReadResult::Text {
            content: String::new(),
            size: 0,
        };
    }
    // `classify_bytes` only uses the path for extension-based MIME hints
    // (SVG/AVIF); the repo-relative path is enough.
    classify_bytes(Path::new(relative), out.stdout)
}

/// Return the HEAD blob for a working-tree path. Backs the working-tree side
/// of the Source Control diff viewer.
#[tauri::command]
pub fn git_file_head(repo_path: String, relative: String) -> Result<ReadResult, String> {
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Err("not a git repository".into());
    };
    Ok(show_blob(&root, "HEAD", &relative))
}

/// Return a file's blob at an arbitrary commit (`rev` is a hex SHA). Backs the
/// per-commit diff viewer, which reads the file at the commit and at its
/// parent to render a side-by-side history diff.
#[tauri::command]
pub fn git_file_at(repo_path: String, rev: String, relative: String) -> Result<ReadResult, String> {
    if !is_valid_rev(&rev) {
        return Err("invalid revision".into());
    }
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Err("not a git repository".into());
    };
    Ok(show_blob(&root, &rev, &relative))
}

/// Discard working-tree changes for a single file. Untracked files are
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
    let tracked = probe.output().map(|o| o.status.success()).unwrap_or(false);

    if tracked {
        // Unstage staged hunks and restore working tree to HEAD.
        let mut cmd = git(&root);
        cmd.args(["checkout", "HEAD", "--", relative.as_str()]);
        run(cmd)?;
        // `checkout HEAD --` leaves the index copy intact when the file was
        // staged-only-deleted; reset the index too.
        let mut reset = git(&root);
        reset.args(["reset", "HEAD", "--", relative.as_str()]);
        let _ = reset.output();
    } else {
        // Untracked: delete from disk.
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

/// Discard every working-tree change and remove untracked files.
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

/// Stage every working-tree change (tracked + untracked) and commit with
/// the given message. Mirrors the all-or-nothing panel UI.
#[tauri::command]
pub fn git_commit(repo_path: String, message: String) -> Result<(), String> {
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Err("not a git repository".into());
    };
    let msg = message.trim();
    if msg.is_empty() {
        return Err("commit message is empty".into());
    }
    let mut add = git(&root);
    add.args(["add", "-A"]);
    run(add)?;
    let mut commit = git(&root);
    commit.args(["commit", "-m", msg]);
    run(commit)?;
    Ok(())
}

/// Return the combined diff (staged + working tree) plus a list of untracked
/// paths, capped at `max_bytes`. Used by the AI commit-message generator.
/// Capped aggressively so callers do not blow the model's context window
/// on a giant tree.
#[tauri::command]
pub fn git_diff_full(repo_path: String, max_bytes: Option<usize>) -> Result<String, String> {
    let cap = max_bytes.unwrap_or(80_000);
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Err("not a git repository".into());
    };
    let mut out = String::new();

    let mut staged = git(&root);
    staged.args(["diff", "--staged", "--no-color", "--unified=3"]);
    if let Ok(s) = run(staged) {
        if !s.is_empty() {
            out.push_str("# staged\n");
            out.push_str(&s);
        }
    }

    let mut work = git(&root);
    work.args(["diff", "--no-color", "--unified=3"]);
    if let Ok(w) = run(work) {
        if !w.is_empty() {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str("# working-tree\n");
            out.push_str(&w);
        }
    }

    let mut ls = git(&root);
    ls.args(["ls-files", "--others", "--exclude-standard", "-z"]);
    if let Ok(raw) = run(ls) {
        let untracked: Vec<&str> = raw.split('\0').filter(|s| !s.is_empty()).collect();
        if !untracked.is_empty() {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str("# untracked\n");
            for p in &untracked {
                out.push_str("+++ b/");
                out.push_str(p);
                out.push('\n');
            }
        }
    }

    if out.len() > cap {
        out.truncate(cap);
        out.push_str(&format!("\n\n[diff truncated by host: >{} bytes]", cap));
    }
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    /// Full 40-char SHA.
    pub sha: String,
    /// Abbreviated SHA (git's default short length).
    pub short_sha: String,
    /// Parent SHAs (full). Empty for the root commit; 2+ for merges.
    pub parents: Vec<String>,
    /// Raw refs pointing at this commit. Entries may include prefixes like
    /// "HEAD -> main", "tag: v1.0", or remote names like "origin/main".
    pub refs: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    /// Author timestamp as Unix seconds.
    pub author_time: i64,
    /// First line of the commit message.
    pub subject: String,
}

/// Return up to `limit` commits reachable from any ref (`--all`), in
/// topological + date order. Used by the Source Control "Graph" tab.
#[tauri::command]
pub fn git_log(repo_path: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let max = limit.unwrap_or(500).clamp(1, 5000);
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Err("not a git repository".into());
    };
    // Tab-separated fields; subject is last so embedded tabs in the message
    // can't desync the parse. `%D` emits decorations without surrounding
    // parens (no `%d`), which keeps refs easy to split.
    let fmt = "%H%x09%h%x09%P%x09%D%x09%an%x09%ae%x09%at%x09%s";
    let mut cmd = git(&root);
    cmd.args([
        "log",
        "--all",
        "--topo-order",
        "--date-order",
        &format!("--max-count={max}"),
        &format!("--pretty=format:{fmt}"),
    ]);
    let raw = match run(cmd) {
        Ok(s) => s,
        Err(e) => {
            // Empty repo (no commits yet) reports "does not have any commits yet".
            let lower = e.to_lowercase();
            if lower.contains("does not have any commits") || lower.contains("bad default revision")
            {
                return Ok(Vec::new());
            }
            return Err(e);
        }
    };

    let mut out: Vec<GitCommit> = Vec::new();
    for line in raw.split('\n') {
        if line.is_empty() {
            continue;
        }
        let mut parts = line.splitn(8, '\t');
        let sha = parts.next().unwrap_or("").to_string();
        let short_sha = parts.next().unwrap_or("").to_string();
        let parents_raw = parts.next().unwrap_or("");
        let refs_raw = parts.next().unwrap_or("");
        let author_name = parts.next().unwrap_or("").to_string();
        let author_email = parts.next().unwrap_or("").to_string();
        let author_time: i64 = parts
            .next()
            .and_then(|s| s.parse().ok())
            .unwrap_or_default();
        let subject = parts.next().unwrap_or("").to_string();
        if sha.is_empty() {
            continue;
        }
        let parents: Vec<String> = parents_raw
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        let refs: Vec<String> = if refs_raw.is_empty() {
            Vec::new()
        } else {
            refs_raw
                .split(", ")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        };
        out.push(GitCommit {
            sha,
            short_sha,
            parents,
            refs,
            author_name,
            author_email,
            author_time,
            subject,
        });
    }
    Ok(out)
}

/// A single file touched by a commit, relative to the commit's first parent
/// (or the empty tree for the root commit).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
    /// Forward-slash repo-relative path at the commit (the new side).
    pub path: String,
    /// Previous path for renames/copies, else null.
    pub old_path: Option<String>,
    /// "modified" | "added" | "deleted" | "renamed" | "copied".
    pub status: String,
    /// Lines added vs the parent. 0 when binary or not applicable.
    pub added: u32,
    /// Lines removed vs the parent. 0 when binary or not applicable.
    pub removed: u32,
    /// True when git reported the entry as binary.
    pub binary: bool,
}

/// Full metadata + changed-file list for one commit. Powers the Source
/// Control history detail pane.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_time: i64,
    pub committer_name: String,
    pub committer_email: String,
    pub commit_time: i64,
    /// First line of the commit message.
    pub subject: String,
    /// Message body (everything after the subject), trailing newline trimmed.
    pub body: String,
    pub files: Vec<CommitFile>,
}

/// Parse `git diff --name-status -M -z`. With `-z`, fields are NUL-terminated
/// and paths are emitted raw (no quoting/munging). Renames/copies carry an
/// extra path: `R100\0old\0new`; everything else is `STATUS\0path`.
fn parse_name_status_z(raw: &str) -> Vec<(String, String, Option<String>)> {
    let mut out = Vec::new();
    let mut it = raw.split('\0').filter(|s| !s.is_empty());
    while let Some(status) = it.next() {
        let code = status.as_bytes().first().copied().unwrap_or(b'M');
        if code == b'R' || code == b'C' {
            let (Some(old), Some(new)) = (it.next(), it.next()) else {
                break;
            };
            out.push((
                classify(code).to_string(),
                to_forward(new),
                Some(to_forward(old)),
            ));
        } else {
            let Some(path) = it.next() else { break };
            out.push((classify(code).to_string(), to_forward(path), None));
        }
    }
    out
}

/// Parse `git diff --numstat -M -z` into per-(new)path line counts. With `-z`
/// a normal record is one `added\tremoved\tpath` token; a rename is three:
/// `added\tremoved\t` (empty path), then `old`, then `new`.
fn parse_numstat_z(raw: &str) -> HashMap<String, NumstatEntry> {
    let mut out: HashMap<String, NumstatEntry> = HashMap::new();
    let tokens: Vec<&str> = raw.split('\0').collect();
    let mut i = 0;
    while i < tokens.len() {
        let tok = tokens[i];
        if tok.is_empty() {
            i += 1;
            continue;
        }
        let mut parts = tok.splitn(3, '\t');
        let a = parts.next().unwrap_or("");
        let r = parts.next().unwrap_or("");
        let p = parts.next().unwrap_or("");
        let binary = a == "-" || r == "-";
        let added = if binary { 0 } else { a.parse().unwrap_or(0) };
        let removed = if binary { 0 } else { r.parse().unwrap_or(0) };
        let entry = NumstatEntry {
            added,
            removed,
            binary,
        };
        if p.is_empty() {
            // Rename: the next two tokens are the old and new paths.
            let new = tokens.get(i + 2).copied().unwrap_or("");
            if !new.is_empty() {
                out.insert(to_forward(new), entry);
            }
            i += 3;
        } else {
            out.insert(to_forward(p), entry);
            i += 1;
        }
    }
    out
}

/// Return full metadata and the changed-file list for a single commit. The
/// file set is computed against the first parent (`--first-parent` semantics
/// via `git diff <parent> <sha>`); the root commit diffs against the empty
/// tree so all files read as added.
#[tauri::command]
pub fn git_commit_detail(repo_path: String, sha: String) -> Result<CommitDetail, String> {
    if !is_valid_rev(&sha) {
        return Err("invalid commit id".into());
    }
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Err("not a git repository".into());
    };

    // NUL-separated so embedded tabs/newlines in the message can't desync the
    // parse; body (%b) is last and may contain anything.
    let fmt = "%H%x00%h%x00%P%x00%D%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%s%x00%b";
    let mut meta = git(&root);
    meta.args(["show", "-s", &format!("--format={fmt}"), sha.as_str()]);
    let raw = run(meta)?;
    let raw = raw.strip_suffix('\n').unwrap_or(&raw);
    let mut f = raw.splitn(12, '\u{0}');
    let full_sha = f.next().unwrap_or("").to_string();
    let short_sha = f.next().unwrap_or("").to_string();
    let parents_raw = f.next().unwrap_or("");
    let refs_raw = f.next().unwrap_or("");
    let author_name = f.next().unwrap_or("").to_string();
    let author_email = f.next().unwrap_or("").to_string();
    let author_time: i64 = f.next().and_then(|s| s.parse().ok()).unwrap_or_default();
    let committer_name = f.next().unwrap_or("").to_string();
    let committer_email = f.next().unwrap_or("").to_string();
    let commit_time: i64 = f.next().and_then(|s| s.parse().ok()).unwrap_or_default();
    let subject = f.next().unwrap_or("").to_string();
    let body = f.next().unwrap_or("").trim_end().to_string();
    if full_sha.is_empty() {
        return Err("commit not found".into());
    }

    let parents: Vec<String> = parents_raw
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();
    let refs: Vec<String> = if refs_raw.is_empty() {
        Vec::new()
    } else {
        refs_raw
            .split(", ")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    };

    // Diff against the first parent; the root commit has none, so use the
    // empty tree (every file then reads as added).
    let base = parents
        .first()
        .cloned()
        .unwrap_or_else(|| EMPTY_TREE.to_string());

    let mut ns = git(&root);
    ns.args([
        "diff",
        "--name-status",
        "-M",
        "-z",
        base.as_str(),
        full_sha.as_str(),
    ]);
    let name_status_raw = run(ns).unwrap_or_default();

    let mut nm = git(&root);
    nm.args([
        "diff",
        "--numstat",
        "-M",
        "-z",
        base.as_str(),
        full_sha.as_str(),
    ]);
    let stats = parse_numstat_z(&run(nm).unwrap_or_default());

    let files: Vec<CommitFile> = parse_name_status_z(&name_status_raw)
        .into_iter()
        .map(|(status, path, old_path)| {
            let s = stats.get(&path).copied().unwrap_or_default();
            CommitFile {
                path,
                old_path,
                status,
                added: s.added,
                removed: s.removed,
                binary: s.binary,
            }
        })
        .collect();

    Ok(CommitDetail {
        sha: full_sha,
        short_sha,
        parents,
        refs,
        author_name,
        author_email,
        author_time,
        committer_name,
        committer_email,
        commit_time,
        subject,
        body,
        files,
    })
}

/// Push the current branch to its upstream. With no upstream configured,
/// falls back to `git push -u origin <branch>` to publish the branch.
#[tauri::command]
pub fn git_push(repo_path: String) -> Result<String, String> {
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Err("not a git repository".into());
    };
    let mut up = git(&root);
    up.arg("rev-parse").arg("--abbrev-ref").arg("@{u}");
    let has_upstream = up.output().map(|o| o.status.success()).unwrap_or(false);
    if has_upstream {
        let mut push = git(&root);
        push.arg("push");
        return run(push);
    }
    let branch = current_branch(&root).ok_or_else(|| "no current branch".to_string())?;
    let mut push = git(&root);
    push.args(["push", "-u", "origin", branch.as_str()]);
    run(push)
}
