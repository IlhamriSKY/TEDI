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
    // Never let git block waiting on terminal input. Without this it could
    // stall forever on a credential or host-key prompt (e.g. during push); a
    // null stdin plus GIT_TERMINAL_PROMPT=0 makes those fail fast instead of
    // hanging a worker.
    cmd.stdin(std::process::Stdio::null());
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // Same reasoning for the editor: `git pull` that resolves to a merge, and
    // `git commit --amend`, both open $EDITOR for a message. With no terminal
    // attached that either hangs the worker or fails obscurely, so accept the
    // default message instead. Every call that has a message passes `-m`, so
    // this only ever fires where there was nothing to type.
    cmd.env("GIT_EDITOR", "true");
    // Drop the AppImage's LD_LIBRARY_PATH before running the SYSTEM git. It is
    // the same failure the shell and formatter paths guard against, and git is
    // the most exposed of them: it links libcurl for https, so a bundled libcurl
    // winning the search order breaks fetch and push with an undefined-symbol
    // error rather than anything that names the cause.
    crate::modules::appimage::sanitize_env(&mut cmd);
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
    /// Forward-slash repo-relative path this entry was renamed/copied FROM,
    /// else `None`. Discarding a rename has to restore both sides.
    pub old_relative: Option<String>,
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

fn require_root(repo_path: &str) -> Result<PathBuf, String> {
    find_repo_root(&PathBuf::from(repo_path)).ok_or_else(|| "not a git repository".into())
}

fn parse_parents(raw: &str) -> Vec<String> {
    raw.split_whitespace().map(|s| s.to_string()).collect()
}

fn parse_refs(raw: &str) -> Vec<String> {
    if raw.is_empty() {
        Vec::new()
    } else {
        raw.split(", ")
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }
}

fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let out = git(start)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
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

/// Parse the `## ...` header that `git status --branch` prepends as the first
/// `-z` record. Folds branch name, upstream, and ahead/behind counts into the
/// single status process so the poller no longer fans out separate
/// `rev-parse`/`rev-list` subprocesses every refresh. Branch is `None` only for
/// a detached HEAD (`## HEAD (no branch)`); the caller then resolves the short
/// SHA. Git ref names cannot contain spaces or `..`, so the `" ["` and `"..."`
/// splits are unambiguous.
pub(crate) fn parse_branch_header(line: &str) -> (Option<String>, Option<String>, u32, u32) {
    let rest = line.strip_prefix("## ").unwrap_or(line);
    // Unborn branch (no commits yet): "No commits yet on <b>" / "Initial commit on <b>".
    for prefix in ["No commits yet on ", "Initial commit on "] {
        if let Some(b) = rest.strip_prefix(prefix) {
            return (Some(b.trim().to_string()), None, 0, 0);
        }
    }
    if rest.starts_with("HEAD (no branch)") {
        return (None, None, 0, 0);
    }
    // Optional " [ahead N, behind M]" suffix follows the branch/upstream names.
    let (names, ab) = match rest.split_once(" [") {
        Some((n, a)) => (n, Some(a.trim_end_matches(']'))),
        None => (rest, None),
    };
    let (branch, upstream) = match names.split_once("...") {
        Some((b, u)) => (b.to_string(), Some(u.to_string())),
        None => (names.to_string(), None),
    };
    let (mut ahead, mut behind) = (0u32, 0u32);
    if let Some(ab) = ab {
        for part in ab.split(", ") {
            if let Some(n) = part.strip_prefix("ahead ") {
                ahead = n.trim().parse().unwrap_or(0);
            } else if let Some(n) = part.strip_prefix("behind ") {
                behind = n.trim().parse().unwrap_or(0);
            }
        }
    }
    (Some(branch), upstream, ahead, behind)
}

/// True for the seven porcelain-v1 unmerged states. Only `UU` carries a `U`, so
/// classifying on the letter alone read `DD` (both deleted) and `AA` (both
/// added) as ordinary staged changes - the panel then listed a live conflict as
/// resolved and offered to stage half of it.
fn is_unmerged(x: u8, y: u8) -> bool {
    matches!((x, y), (b'D', b'D') | (b'A', b'A') | (b'U', _) | (_, b'U'))
}

pub(crate) fn parse_porcelain_v1(root: &Path, raw: &str) -> Vec<GitChange> {
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
        let old_relative = if is_rename {
            tokens.next().map(to_forward)
        } else {
            None
        };
        let abs = to_forward(&root.join(path).to_string_lossy());
        let rel = to_forward(path);
        let mut emit = |status: &str, staged: bool| {
            out.push(GitChange {
                path: abs.clone(),
                relative: rel.clone(),
                status: status.to_string(),
                old_relative: old_relative.clone(),
                staged,
                added: 0,
                removed: 0,
                binary: false,
            });
        };

        if is_unmerged(x, y) {
            // A conflict is neither staged nor unstaged - it is one row the
            // user resolves - so it never splits in two the way the states
            // below do.
            emit("conflicted", false);
            continue;
        }
        if x == b'?' {
            emit("untracked", false);
            continue;
        }
        if x == b'!' {
            emit("ignored", false);
            continue;
        }
        // `XY`: X is index-vs-HEAD, Y is worktree-vs-index, and a file can
        // carry both (`MM` = a staged edit plus a newer unstaged one). Git and
        // VSCode both list such a file twice; collapsing it into a single row
        // kept the unstaged half invisible and unstageable.
        if x != b' ' {
            emit(classify(x), true);
        }
        if y != b' ' {
            emit(classify(y), false);
        }
    }
    out
}

#[derive(Debug, Default, Clone, Copy)]
struct NumstatEntry {
    added: u32,
    removed: u32,
    binary: bool,
}

/// Line counts for one side of the index. `staged` reads index-vs-HEAD
/// (`--cached`), otherwise worktree-vs-index. A failure - most often an unborn
/// branch, where there is no HEAD to diff against - yields an empty table and
/// the caller falls back to counting the file itself.
fn numstat(root: &Path, staged: bool) -> HashMap<String, NumstatEntry> {
    let mut cmd = git(root);
    cmd.args(["diff", "--numstat"]);
    if staged {
        cmd.arg("--cached");
    }
    let raw = cmd
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    parse_numstat(&raw)
}

/// Parse `git diff --numstat` output. Each non-empty line is
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
    // `symlink_metadata` does not traverse links, and `is_file()` then rejects
    // symlinks, directories, and special files (named pipes / devices /
    // sockets). Opening such an entry can block forever inside `NtCreateFile`;
    // because this feeds the explorer's git decorations that would freeze the
    // UI. Only ever read a plain regular file here.
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.file_type().is_file() {
        return None;
    }
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
pub async fn git_status(repo_path: String) -> Result<GitStatus, String> {
    // A sync `#[tauri::command]` runs on the WebView2 UI (main) thread on
    // Windows, so the blocking git subprocesses + per-file reads below can
    // freeze the entire app - a minidump caught this exact stack stuck in
    // `NtCreateFile` opening an untracked working-tree file. Offload the whole
    // body to the blocking pool so the UI thread keeps pumping messages.
    tauri::async_runtime::spawn_blocking(move || git_status_inner(repo_path))
        .await
        .map_err(|e| format!("git_status join error: {e}"))?
}

fn git_status_inner(repo_path: String) -> Result<GitStatus, String> {
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

    // Fan out two independent git subprocesses. `--branch` folds the branch
    // name, upstream, and ahead/behind counts into the status output's first
    // `-z` record, so we no longer spawn separate rev-parse/rev-list processes
    // every refresh (the panel auto-polls, and two pollers ran in parallel -
    // that fan-out piled up dozens of short-lived git.exe in Task Manager).
    // Joining here blocks, which is why the public `git_status` command hands
    // this entire body to the blocking pool (see the async wrapper above): a
    // sync command would run on the Windows UI thread and freeze the app.
    let status_handle = {
        let root = root.clone();
        thread::spawn(move || {
            let mut cmd = git(&root);
            cmd.args([
                "status",
                "--porcelain=v1",
                "--branch",
                "-z",
                "--untracked-files=all",
            ]);
            run(cmd)
        })
    };
    let numstat_handle = {
        let root = root.clone();
        // Two reads, one thread. A staged row's line counts are index-vs-HEAD
        // and an unstaged row's are worktree-vs-index; the single
        // `diff --numstat HEAD` this replaced measured the sum of both against
        // HEAD, so a partially-staged file showed the same total twice.
        // Sequential on purpose: the poller's git.exe fan-out is what the
        // comment above is guarding against.
        thread::spawn(move || (numstat(&root, true), numstat(&root, false)))
    };

    let raw = status_handle
        .join()
        .map_err(|_| "git status thread panicked".to_string())??;
    let (staged_stats, work_stats) = numstat_handle
        .join()
        .map_err(|_| "numstat thread panicked".to_string())?;

    // First `-z` record is the `## ...` branch header; the rest are file
    // entries. Split it off so the porcelain parser never sees the header.
    let (header, entries_raw) = raw.split_once('\0').unwrap_or((raw.as_str(), ""));
    let (mut branch, upstream, ahead, behind) = parse_branch_header(header);
    if branch.is_none() {
        // Detached HEAD: resolve the short SHA (rare, so the extra process
        // only ever runs off the normal-branch hot path).
        branch = current_branch(&root);
    }

    let mut changes = parse_porcelain_v1(&root, entries_raw);
    for c in changes.iter_mut() {
        let stats = if c.staged { &staged_stats } else { &work_stats };
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

/// Ignored (gitignored) working-tree entries under the repo, as forward-slash
/// absolute paths with trailing slashes stripped. Fully-ignored directories are
/// collapsed to the directory itself (e.g. `.../node_modules`) via `--directory`
/// so the list stays small even with huge ignored trees. The explorer uses this
/// to dim ignored rows like VSCode. Returns an empty list outside a repo - this
/// is a best-effort decoration source, never a hard error for the caller.
#[tauri::command]
pub async fn git_ignored(repo_path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || git_ignored_inner(repo_path))
        .await
        .map_err(|e| format!("git_ignored join error: {e}"))?
}

fn git_ignored_inner(repo_path: String) -> Result<Vec<String>, String> {
    let start = PathBuf::from(&repo_path);
    let Some(root) = find_repo_root(&start) else {
        return Ok(Vec::new());
    };
    let mut cmd = git(&root);
    // -o others, -i ignored, --exclude-standard honors .gitignore + .git/info/exclude
    // + core.excludesFile, --directory collapses wholly-ignored dirs, -z NUL-separates.
    cmd.args([
        "ls-files",
        "-z",
        "-o",
        "-i",
        "--exclude-standard",
        "--directory",
    ]);
    let raw = run(cmd)?;
    let root_fwd = to_forward(&root.to_string_lossy());
    let root_fwd = root_fwd.trim_end_matches('/');
    let mut out = Vec::new();
    for entry in raw.split('\0') {
        if entry.is_empty() {
            continue;
        }
        let rel = to_forward(entry);
        let rel = rel.trim_end_matches('/');
        out.push(format!("{root_fwd}/{rel}"));
    }
    Ok(out)
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
pub async fn git_file_head(repo_path: String, relative: String) -> Result<ReadResult, String> {
    tauri::async_runtime::spawn_blocking(move || git_file_head_inner(repo_path, relative))
        .await
        .map_err(|e| format!("git_file_head join error: {e}"))?
}

fn git_file_head_inner(repo_path: String, relative: String) -> Result<ReadResult, String> {
    let root = require_root(&repo_path)?;
    Ok(show_blob(&root, "HEAD", &relative))
}

/// Return a file's blob at an arbitrary commit (`rev` is a hex SHA). Backs the
/// per-commit diff viewer, which reads the file at the commit and at its
/// parent to render a side-by-side history diff.
#[tauri::command]
pub async fn git_file_at(
    repo_path: String,
    rev: String,
    relative: String,
) -> Result<ReadResult, String> {
    tauri::async_runtime::spawn_blocking(move || git_file_at_inner(repo_path, rev, relative))
        .await
        .map_err(|e| format!("git_file_at join error: {e}"))?
}

fn git_file_at_inner(
    repo_path: String,
    rev: String,
    relative: String,
) -> Result<ReadResult, String> {
    if !is_valid_rev(&rev) {
        return Err("invalid revision".into());
    }
    let root = require_root(&repo_path)?;
    Ok(show_blob(&root, &rev, &relative))
}

/// Git subcommands the Source Control panel may drive. An argument vector
/// arrives over IPC, so the subcommand is the boundary worth pinning down:
/// everything the panel needs is here and nothing that rewrites shared history
/// or edits persistent config is.
const ALLOWED_SUBCOMMANDS: &[&str] = &[
    "add",
    "branch",
    "checkout",
    "clean",
    "commit",
    "diff",
    "fetch",
    "for-each-ref",
    "ls-tree",
    "pull",
    "push",
    "reset",
    "rev-parse",
    "rm",
    "show-ref",
];

/// git's transport options take the name of a program to run
/// (`--upload-pack`, `--receive-pack`, `--exec`). None of the panel's calls
/// need one, and an argument vector arriving over IPC must not be able to pick
/// an executable.
const DENIED_PREFIXES: &[&str] = &["--upload-pack", "--receive-pack", "--exec"];

/// Shared by the local runner and the SSH one, so a remote repo is held to the
/// same argument rules as a local one.
pub(crate) fn check_args(args: &[String]) -> Result<(), String> {
    let Some(sub) = args.first() else {
        return Err("git: no subcommand".into());
    };
    if !ALLOWED_SUBCOMMANDS.contains(&sub.as_str()) {
        return Err(format!("git: subcommand '{sub}' is not allowed"));
    }
    if args.iter().any(|a| a.bytes().any(|b| b == 0)) {
        return Err("git: argument contains a NUL byte".into());
    }
    // Values are not options, and checking them as if they were is wrong in
    // both directions: a commit message is free text that may legitimately
    // read `moved a/../b`, and a pathspec after `--` can never be an option.
    let mut skip_value = false;
    let mut in_paths = false;
    for a in &args[1..] {
        if skip_value {
            skip_value = false;
            continue;
        }
        if in_paths {
            if a.split(['/', '\\']).any(|seg| seg == "..") {
                return Err(format!("git: path '{a}' leaves the repository"));
            }
            continue;
        }
        match a.as_str() {
            "--" => in_paths = true,
            "-m" | "--message" => skip_value = true,
            _ if DENIED_PREFIXES.iter().any(|d| a.starts_with(d)) => {
                return Err(format!("git: option '{a}' is not allowed"))
            }
            _ => {}
        }
    }
    Ok(())
}

/// Run one whitelisted git subcommand in `repo_path`'s repository and return
/// its stdout; a non-zero exit is an `Err` carrying stderr.
///
/// One runner rather than a typed command per operation: the SSH panel drives
/// the identical argument vectors through `ssh_git`, so staging, discard,
/// commit, push, pull and branch switching share a single implementation
/// instead of a local and a remote copy that drift.
#[tauri::command]
pub async fn git_run(repo_path: String, args: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_run_inner(repo_path, args))
        .await
        .map_err(|e| format!("git_run join error: {e}"))?
}

fn git_run_inner(repo_path: String, args: Vec<String>) -> Result<String, String> {
    check_args(&args)?;
    let root = require_root(&repo_path)?;
    let mut cmd = git(&root);
    cmd.args(&args);
    run(cmd)
}

/// Return the combined diff (staged + working tree) plus a list of untracked
/// paths, capped at `max_bytes`. Used by the AI commit-message generator.
/// Capped aggressively so callers do not blow the model's context window
/// on a giant tree.
#[tauri::command]
pub async fn git_diff_full(repo_path: String, max_bytes: Option<usize>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_full_inner(repo_path, max_bytes))
        .await
        .map_err(|e| format!("git_diff_full join error: {e}"))?
}

fn git_diff_full_inner(repo_path: String, max_bytes: Option<usize>) -> Result<String, String> {
    let cap = max_bytes.unwrap_or(80_000);
    let root = require_root(&repo_path)?;
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
        // `cap` is a raw byte count and may land inside a multi-byte UTF-8
        // sequence; back it down to the nearest char boundary so truncate
        // can't panic.
        let mut end = cap.min(out.len());
        while end > 0 && !out.is_char_boundary(end) {
            end -= 1;
        }
        out.truncate(end);
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
pub async fn git_log(repo_path: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    tauri::async_runtime::spawn_blocking(move || git_log_inner(repo_path, limit))
        .await
        .map_err(|e| format!("git_log join error: {e}"))?
}

fn git_log_inner(repo_path: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let max = limit.unwrap_or(500).clamp(1, 5000);
    let root = require_root(&repo_path)?;
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
        let parents = parse_parents(parents_raw);
        let refs = parse_refs(refs_raw);
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
pub async fn git_commit_detail(repo_path: String, sha: String) -> Result<CommitDetail, String> {
    tauri::async_runtime::spawn_blocking(move || git_commit_detail_inner(repo_path, sha))
        .await
        .map_err(|e| format!("git_commit_detail join error: {e}"))?
}

fn git_commit_detail_inner(repo_path: String, sha: String) -> Result<CommitDetail, String> {
    if !is_valid_rev(&sha) {
        return Err("invalid commit id".into());
    }
    let root = require_root(&repo_path)?;

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

    let parents = parse_parents(parents_raw);
    let refs = parse_refs(refs_raw);

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

#[cfg(test)]
mod tests {
    use super::{check_args, is_unmerged, parse_branch_header};

    /// `ssh_git_status` reuses this parser with a POSIX remote root while
    /// running on whatever OS the app is on. On Windows `Path::join` inserts a
    /// backslash, so the paths handed to the frontend are only correct because
    /// `to_forward` normalizes them back.
    #[test]
    fn porcelain_paths_stay_posix_for_a_remote_root() {
        let changes = super::parse_porcelain_v1(
            std::path::Path::new("/home/u/repo"),
            " M src/a.rs\0?? b.txt\0",
        );
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].path, "/home/u/repo/src/a.rs");
        assert_eq!(changes[0].relative, "src/a.rs");
        assert_eq!(changes[0].status, "modified");
        assert!(!changes[0].staged);
        assert_eq!(changes[1].path, "/home/u/repo/b.txt");
        assert_eq!(changes[1].status, "untracked");
    }

    /// `XY` carries two independent states. A partially-staged file has to
    /// reach the panel as two rows or its unstaged half is invisible - and
    /// unstageable, since the checkbox acts on the row.
    #[test]
    fn partially_staged_file_splits_into_two_rows() {
        let changes =
            super::parse_porcelain_v1(std::path::Path::new("/r"), "MM a.rs\0M  b.rs\0 D c.rs\0");
        assert_eq!(changes.len(), 4);
        // a.rs: staged edit + a newer unstaged one.
        assert_eq!(
            (changes[0].relative.as_str(), changes[0].staged),
            ("a.rs", true)
        );
        assert_eq!(
            (changes[1].relative.as_str(), changes[1].staged),
            ("a.rs", false)
        );
        // b.rs: staged only. c.rs: deleted in the worktree only.
        assert_eq!(
            (changes[2].relative.as_str(), changes[2].staged),
            ("b.rs", true)
        );
        assert_eq!(
            (
                changes[3].relative.as_str(),
                changes[3].staged,
                changes[3].status.as_str()
            ),
            ("c.rs", false, "deleted")
        );
    }

    /// A rename's source path has to survive the parse: discarding one restores
    /// both sides, and without the old path the `clean` step would delete the
    /// new file and leave the old one gone.
    #[test]
    fn rename_keeps_its_source_path() {
        let changes =
            super::parse_porcelain_v1(std::path::Path::new("/r"), "R  new.rs\0old.rs\0?? z.txt\0");
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].relative, "new.rs");
        assert_eq!(changes[0].old_relative.as_deref(), Some("old.rs"));
        // The source token must be consumed, not parsed as its own entry.
        assert_eq!(changes[1].relative, "z.txt");
        assert_eq!(changes[1].old_relative, None);
    }

    /// Only `UU` contains a `U`; `DD` and `AA` are unmerged too and used to be
    /// reported as an ordinary staged delete / add.
    #[test]
    fn every_unmerged_state_is_a_conflict() {
        for (x, y) in [
            (b'D', b'D'),
            (b'A', b'A'),
            (b'U', b'U'),
            (b'A', b'U'),
            (b'U', b'A'),
            (b'D', b'U'),
            (b'U', b'D'),
        ] {
            assert!(
                is_unmerged(x, y),
                "{}{} should be unmerged",
                x as char,
                y as char
            );
        }
        for (x, y) in [(b'M', b'M'), (b'A', b'M'), (b'?', b'?'), (b' ', b'D')] {
            assert!(
                !is_unmerged(x, y),
                "{}{} should not be unmerged",
                x as char,
                y as char
            );
        }
    }

    #[test]
    fn arg_guard_rejects_what_it_must() {
        let v = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(check_args(&v(&["add", "-A", "--", "src/a.rs"])).is_ok());
        // A commit message is free text, not a path or an option.
        assert!(check_args(&v(&["commit", "-m", "moved a/../b, --exec style"])).is_ok());
        assert!(check_args(&[]).is_err());
        // Not on the list: config writes, history rewrites, arbitrary plumbing.
        assert!(check_args(&v(&["config", "core.editor", "sh"])).is_err());
        assert!(check_args(&v(&["-c", "core.pager=sh"])).is_err());
        // Transport options name a program to execute.
        assert!(check_args(&v(&["fetch", "--upload-pack=calc"])).is_err());
        // Path arguments must stay inside the repository.
        assert!(check_args(&v(&["add", "--", "../../etc/passwd"])).is_err());
        assert!(check_args(&v(&["add", "--", "..\\..\\win.ini"])).is_err());
    }

    #[test]
    fn branch_header_variants() {
        // tracked + ahead/behind
        assert_eq!(
            parse_branch_header("## main...origin/main [ahead 2, behind 3]"),
            (Some("main".into()), Some("origin/main".into()), 2, 3)
        );
        // ahead only
        assert_eq!(
            parse_branch_header("## main...origin/main [ahead 2]"),
            (Some("main".into()), Some("origin/main".into()), 2, 0)
        );
        // up to date with upstream
        assert_eq!(
            parse_branch_header("## main...origin/main"),
            (Some("main".into()), Some("origin/main".into()), 0, 0)
        );
        // no upstream configured
        assert_eq!(
            parse_branch_header("## feature/x"),
            (Some("feature/x".into()), None, 0, 0)
        );
        // unborn branch (fresh repo)
        assert_eq!(
            parse_branch_header("## No commits yet on main"),
            (Some("main".into()), None, 0, 0)
        );
        // detached HEAD -> caller resolves the short SHA
        assert_eq!(
            parse_branch_header("## HEAD (no branch)"),
            (None, None, 0, 0)
        );
    }
}
