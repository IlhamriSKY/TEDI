//! The git STATUS pipeline: `git_status`, `git_ignored` and `git_find_repos`, plus the
//! porcelain and branch-header parsers that `ssh_git_status` reuses.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::commands::{
    classify, current_branch, find_repo_root, git, run_capped, to_forward, NumstatEntry,
};

/// How long `git status` may spend listing every untracked file before the walk
/// is abandoned for the collapsed one. A healthy repository answers in
/// milliseconds - the pathological one measured over thirty seconds - so this
/// is generous for every repo that is not the problem.
const STATUS_WALK_BUDGET: Duration = Duration::from_secs(3);

/// How long a repository stays on the cheap listing after overrunning the
/// budget once. Without it every poll would spend the whole budget again just
/// to rediscover what it already knew; with it, a repository the user then
/// fixes - a `.gitignore`, a `git rm -r --cached` - is retried rather than
/// demoted for the rest of the session.
const SLOW_WALK_RETRY: Duration = Duration::from_secs(300);

/// Repo roots whose untracked walk overran `STATUS_WALK_BUDGET`, and when.
fn slow_walks() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static SLOW: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    SLOW.get_or_init(Default::default)
}

fn walk_recently_overran(root: &Path) -> bool {
    slow_walks()
        .lock()
        .unwrap()
        .get(root)
        .is_some_and(|at| at.elapsed() < SLOW_WALK_RETRY)
}

fn mark_walk_overran(root: &Path) {
    let mut map = slow_walks().lock().unwrap();
    // Drop expired entries here rather than on read, so the map cannot grow
    // with every repo root a long session ever visited.
    map.retain(|_, at| at.elapsed() < SLOW_WALK_RETRY);
    map.insert(root.to_path_buf(), Instant::now());
}

/// `git status` for the panel. `untracked` is the `--untracked-files` mode:
/// `all` lists every untracked file, `normal` collapses each into its
/// directory and is the only one whose cost is bounded by the repo rather than
/// by the working tree.
fn status_cmd(root: &Path, untracked: &str) -> Command {
    let mut cmd = git(root);
    cmd.args([
        // A poll must never take the index lock: this one repeats every 2.5s
        // and is killed mid-run above, and an index lock outliving the process
        // that took it blocks every later git command in the repo until
        // someone deletes it by hand.
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "--branch",
        "-z",
    ]);
    cmd.arg(format!("--untracked-files={untracked}"));
    cmd
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
    /// True when `changes` was cut short at `MAX_CHANGES`. The panel says so
    /// rather than passing off a partial list as the whole working tree.
    pub truncated: bool,
    /// "merge", "rebase", "cherry-pick", "revert" while one is half-finished,
    /// else `None`. Lets the panel offer Abort / Continue only when there is
    /// something to abort, instead of a menu entry that usually just errors.
    pub in_progress: Option<String>,
}

/// Which multi-step operation the repository is sitting in the middle of.
/// These are the marker paths git itself checks; reading them is three stat
/// calls, which is why this can ride along on the 2.5s status poll.
fn operation_in_progress(root: &Path) -> Option<String> {
    let git_dir = root.join(".git");
    // A worktree or submodule has a `.git` FILE pointing elsewhere, so the
    // markers are not under it and the honest answer is "cannot tell".
    if !git_dir.is_dir() {
        return None;
    }
    for (marker, name) in [
        ("MERGE_HEAD", "merge"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
    ] {
        if git_dir.join(marker).exists() {
            return Some(name.to_string());
        }
    }
    None
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

/// Cap on the rows one `git status` may return.
///
/// Nothing downstream of this parser is bounded: every row is serialized to
/// JSON, crosses the IPC boundary, is parsed again in the webview, sorted with
/// `localeCompare` and rendered as its own DOM node. A repository whose working
/// tree is huge - a `git init` left in a home directory, whose every file is
/// then untracked - answers `--untracked-files=all` with over a million rows,
/// and one refresh of that allocated gigabytes and stopped the window
/// responding to Windows. That is the "TEDI freezes after I minimize it or
/// switch away" report: the Source Control panel and the explorer's git
/// decorations both refresh on resume, so coming back to the window ran two of
/// them at once.
///
/// No one reads two thousand rows; past that the list is a size, not a list.
const MAX_CHANGES: usize = 2000;

/// Parse porcelain-v1 `-z` output into rows, capped at [`MAX_CHANGES`].
///
/// The second return value is true when the cap cut the list short, so callers
/// can say so instead of passing a partial list off as the whole working tree.
pub(crate) fn parse_porcelain_v1(root: &Path, raw: &str) -> (Vec<GitChange>, bool) {
    // Porcelain v1 with -z uses NUL as the entry separator and a second NUL
    // after the source path of a rename. Each entry is "XY <path>" plus
    // "<src>" for renames.
    let mut out: Vec<GitChange> = Vec::new();
    let mut tokens = raw.split('\0').filter(|s| !s.is_empty()).peekable();
    while let Some(token) = tokens.next() {
        // Checked per entry rather than per row: one `XY` entry can emit two
        // rows, so this overshoots by at most one, which the truncate below
        // trims off.
        if out.len() >= MAX_CHANGES {
            out.truncate(MAX_CHANGES);
            return (out, true);
        }
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
    (out, false)
}

/// Line counts for one side of the index. `staged` reads index-vs-HEAD
/// (`--cached`), otherwise worktree-vs-index. A failure - most often an unborn
/// branch, where there is no HEAD to diff against - yields an empty table and
/// the caller falls back to counting the file itself.
fn numstat(root: &Path, staged: bool) -> HashMap<String, NumstatEntry> {
    let mut cmd = git(root);
    // `--no-optional-locks` for the same reason `status_cmd` above documents,
    // and this one needs it just as much: `git_status` calls numstat twice on
    // the same 2.5s poll, so without it every tick that finds a stat-dirty
    // entry takes the index lock to rewrite it, doubling up with the status
    // walk beside it and racing any git the user runs in a terminal.
    cmd.args(["--no-optional-locks", "diff", "--numstat"]);
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

/// How many untracked rows per refresh are worth a file read for their `+N`
/// chip. See the call site in `git_status_inner`: the per-file cap below bounds
/// one read, this bounds how many of them a single poll may do.
const UNTRACKED_LINE_COUNT_BUDGET: usize = 512;

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
pub async fn git_status(repo_path: String, line_counts: Option<bool>) -> Result<GitStatus, String> {
    // A sync `#[tauri::command]` runs on the WebView2 UI (main) thread on
    // Windows, so the blocking git subprocesses + per-file reads below can
    // freeze the entire app - a minidump caught this exact stack stuck in
    // `NtCreateFile` opening an untracked working-tree file. Offload the whole
    // body to the blocking pool so the UI thread keeps pumping messages.
    // Line counts are opt-OUT: every existing caller keeps getting them, and
    // only a view that draws no `+N` chip (the Explorer's decorations, the
    // worktree menu's change count) says so.
    tauri::async_runtime::spawn_blocking(move || {
        git_status_inner(repo_path, line_counts.unwrap_or(true))
    })
    .await
    .map_err(|e| format!("git_status join error: {e}"))?
}

fn git_status_inner(repo_path: String, line_counts: bool) -> Result<GitStatus, String> {
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
            truncated: false,
            in_progress: None,
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
        // `(output, cut short by the record cap, listed with untracked files
        // folded into their directories)`.
        thread::spawn(move || -> Result<(String, bool, bool), String> {
            // One row costs at most two records (a rename prints its source as
            // a record of its own), plus the leading `## branch` header, so
            // this can never cut the list short of `MAX_CHANGES` rows.
            let cap = MAX_CHANGES * 2 + 1;
            // Listing every untracked file is what makes the panel useful on a
            // normal repo and ruinous on a huge one, so ask for it under a
            // budget and settle for the collapsed listing when it overruns.
            if !walk_recently_overran(&root) {
                if let Some((raw, cut_short)) =
                    run_capped(status_cmd(&root, "all"), cap, STATUS_WALK_BUDGET)?
                {
                    return Ok((raw, cut_short, false));
                }
                log::info!(
                    "git_status: {} took over {}s to list untracked files; \
                     collapsing them into their folders for the next {}s",
                    root.display(),
                    STATUS_WALK_BUDGET.as_secs(),
                    SLOW_WALK_RETRY.as_secs()
                );
                mark_walk_overran(&root);
            }
            let (raw, cut_short) =
                run_capped(status_cmd(&root, "normal"), cap, STATUS_WALK_BUDGET)?
                    .ok_or_else(|| "git status timed out".to_string())?;
            Ok((raw, cut_short, true))
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
        //
        // Skipped outright when nobody will draw the counts. The two `diff
        // --numstat` are 45-57% of a whole status (measured 67-78 ms against
        // 41-62 ms for the status itself), and the Explorer refreshes on every
        // change to the tree while Source Control is usually closed.
        thread::spawn(move || {
            if line_counts {
                (numstat(&root, true), numstat(&root, false))
            } else {
                (HashMap::new(), HashMap::new())
            }
        })
    };

    let (raw, cut_short, collapsed) = status_handle
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

    let (mut changes, capped) = parse_porcelain_v1(&root, entries_raw);
    // A collapsed listing is only a partial view if it actually folded
    // something away, and git marks a folded directory with a trailing slash.
    // Without this check, any repo whose walk merely ran long - a cold cache
    // after a lock, a network drive, a big monorepo - would be labelled "too
    // many changes to list" while showing its three modified files, which reads
    // as a bug rather than as the honest note it is meant to be. Tracked
    // changes are identical under both listings, so there is nothing else the
    // fallback can have hidden.
    let hid_untracked = collapsed && changes.iter().any(|c| c.relative.ends_with('/'));
    let truncated = capped || cut_short || hid_untracked;
    // `git diff --numstat` only knows about tracked files, so an untracked row's
    // `+N` chip costs a real file read. That read is bounded per file (512 KB,
    // see `count_file_lines`) but was unbounded in COUNT, and this pass reruns on
    // every poll of the Source Control panel. A single stray build directory
    // (16k untracked files, measured live) therefore turned one refresh into
    // gigabytes of reads every few seconds - which is the "git source control
    // spikes the RAM" report. The chip is cosmetic and stops meaning anything at
    // this scale, so past the budget the row still lists, just without it.
    let mut counted = 0usize;
    for c in changes.iter_mut() {
        let stats = if c.staged { &staged_stats } else { &work_stats };
        if let Some(s) = stats.get(&c.relative) {
            c.added = s.added;
            c.removed = s.removed;
            c.binary = s.binary;
        } else if line_counts
            && c.status == "untracked"
            // A collapsed listing reports whole untracked directories, which
            // git prints with a trailing slash. Opening one as a file fails,
            // so without this each would cost a futile open and come back
            // wearing a "binary" chip.
            && !c.relative.ends_with('/')
            && counted < UNTRACKED_LINE_COUNT_BUDGET
        {
            counted += 1;
            match count_file_lines(&c.path) {
                Some(n) => c.added = n,
                None => c.binary = true,
            }
        }
    }
    // Never truncate silently: say what was skipped and why. `truncated` also
    // reaches the panel, which shows it - this is for the log after the fact.
    if truncated {
        log::info!(
            "git_status: {} has more changes than the panel lists; showing {}",
            root.display(),
            changes.len()
        );
    } else if counted >= UNTRACKED_LINE_COUNT_BUDGET {
        log::info!(
            "git_status: {} changes, line counts skipped past {} untracked entries",
            changes.len(),
            UNTRACKED_LINE_COUNT_BUDGET
        );
    }

    Ok(GitStatus {
        is_repo: true,
        root: Some(to_forward(&root.to_string_lossy())),
        branch,
        upstream,
        ahead,
        behind,
        changes,
        truncated,
        in_progress: operation_in_progress(&root),
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
    // `--directory` keeps the OUTPUT small, but finding what to collapse still
    // walks every untracked path, which is the same hazard `git_status_inner`
    // guards: 42 seconds measured in a repository whose working tree is a home
    // directory, on a decoration that repeats every 2.5s alongside the status
    // poll. Dimming a row is cosmetic, so a repo that has already blown the
    // budget goes without it rather than grinding for it.
    if walk_recently_overran(&root) {
        return Ok(Vec::new());
    }
    let mut cmd = git(&root);
    // -o others, -i ignored, --exclude-standard honors .gitignore + .git/info/exclude
    // + core.excludesFile, --directory collapses wholly-ignored dirs, -z NUL-separates.
    cmd.args([
        "--no-optional-locks",
        "ls-files",
        "-z",
        "-o",
        "-i",
        "--exclude-standard",
        "--directory",
    ]);
    // Same row cap as the change list: past it the explorer has more dimmed
    // rows than it can show at once anyway.
    let Some((raw, _)) = run_capped(cmd, MAX_CHANGES, STATUS_WALK_BUDGET)? else {
        log::info!(
            "git_ignored: {} took over {}s to walk; leaving ignored rows undimmed",
            root.display(),
            STATUS_WALK_BUDGET.as_secs()
        );
        mark_walk_overran(&root);
        return Ok(Vec::new());
    };
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

/// How far below the workspace root `git_find_repos` looks. VS Code's own scan
/// defaults to 1; 3 still reaches `projects/client/app` without walking a
/// whole home directory.
const REPO_SCAN_DEPTH: usize = 3;
const REPO_SCAN_BUDGET: Duration = Duration::from_secs(2);
const REPO_SCAN_MAX: usize = 100;
/// Dependency and build trees: huge, and never a checkout the user works in.
const REPO_SCAN_SKIP: &[&str] = &["node_modules", "target", "vendor", "dist", "build"];

/// Git repositories at or below `root`, forward-slash and sorted, so Source
/// Control can switch between the checkouts a workspace folder holds instead of
/// only ever showing the one its root resolves to.
///
/// Depth-, time- and count-capped: it runs on workspace open and on a manual
/// refresh, never on the status poll. Hidden directories are skipped, which
/// also keeps the walk out of every `.git` itself.
#[tauri::command]
pub async fn git_find_repos(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(find_repos(Path::new(&root), REPO_SCAN_DEPTH)))
        .await
        .map_err(|e| format!("git_find_repos join error: {e}"))?
}

fn find_repos(root: &Path, depth: usize) -> Vec<String> {
    let started = Instant::now();
    let walker = ignore::WalkBuilder::new(root)
        .standard_filters(false)
        .hidden(true)
        .follow_links(false)
        .max_depth(Some(depth))
        .filter_entry(|e| {
            e.file_type().is_some_and(|t| t.is_dir())
                && !REPO_SCAN_SKIP.contains(&e.file_name().to_string_lossy().as_ref())
        })
        .build();
    let mut out = Vec::new();
    for entry in walker {
        if started.elapsed() > REPO_SCAN_BUDGET || out.len() >= REPO_SCAN_MAX {
            break;
        }
        let Ok(entry) = entry else { continue };
        // `exists`, not `is_dir`: a linked worktree or a submodule has a `.git`
        // FILE, and is just as much a repository.
        if entry.path().join(".git").exists() {
            out.push(to_forward(&entry.path().to_string_lossy()));
        }
    }
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::super::commands::git_run_inner;
    use super::{git, is_unmerged, parse_branch_header};
    use std::process::Stdio;

    /// `ssh_git_status` reuses this parser with a POSIX remote root while
    /// running on whatever OS the app is on. On Windows `Path::join` inserts a
    /// backslash, so the paths handed to the frontend are only correct because
    /// `to_forward` normalizes them back.
    #[test]
    fn porcelain_paths_stay_posix_for_a_remote_root() {
        let (changes, truncated) = super::parse_porcelain_v1(
            std::path::Path::new("/home/u/repo"),
            " M src/a.rs\0?? b.txt\0",
        );
        assert!(!truncated);
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
        let (changes, _) =
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

    /// A `git init` left in a home directory makes every file under it
    /// untracked, and `--untracked-files=all` then answers with over a million
    /// rows. Nothing downstream of the parser is bounded - JSON, IPC, the
    /// webview's parse, a `localeCompare` sort, a DOM node each - so an
    /// uncapped list allocated gigabytes and stopped the window responding.
    #[test]
    fn a_huge_working_tree_is_capped_and_says_so() {
        let raw: String = (0..super::MAX_CHANGES * 3)
            .map(|i| format!("?? f{i}.txt\0"))
            .collect();
        let (changes, truncated) = super::parse_porcelain_v1(std::path::Path::new("/r"), &raw);
        assert!(
            truncated,
            "the cap has to report itself, never truncate silently"
        );
        assert_eq!(changes.len(), super::MAX_CHANGES);
        // Cut from the tail, so what is listed is still the front of the list.
        assert_eq!(changes[0].relative, "f0.txt");
    }

    /// A rename's source path has to survive the parse: discarding one restores
    /// both sides, and without the old path the `clean` step would delete the
    /// new file and leave the old one gone.
    #[test]
    fn rename_keeps_its_source_path() {
        let (changes, _) =
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

    /// Opting out of line counts must change ONLY the counts: the same rows, in
    /// the same states, just without the two `diff --numstat` behind the chips.
    /// Skipped when `git` is absent, like the worktree test below.
    #[test]
    fn status_without_line_counts_lists_the_same_changes() {
        if std::process::Command::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_err()
        {
            eprintln!("skipping: no git on PATH");
            return;
        }
        let tmp = std::env::temp_dir().join(format!("tedi-status-lc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("create temp repo dir");
        let root = tmp.to_string_lossy().to_string();
        git_run_inner(root.clone(), vec!["init".into(), "-q".into(), ".".into()]).expect("init");
        std::fs::write(tmp.join("a.txt"), "one\ntwo\nthree\n").expect("seed");
        git_run_inner(
            root.clone(),
            vec!["add".into(), "-A".into(), "--".into(), "a.txt".into()],
        )
        .expect("add");
        let commit = git(&tmp)
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-qm",
                "init",
            ])
            .output()
            .expect("commit");
        assert!(commit.status.success(), "commit failed");
        std::fs::write(tmp.join("a.txt"), "one\ntwo\nthree\nfour\nfive\n").expect("modify");
        std::fs::write(tmp.join("b.txt"), "x\ny\n").expect("untracked");

        let full = super::git_status_inner(root.clone(), true).expect("full status");
        let lean = super::git_status_inner(root.clone(), false).expect("lean status");
        let rows = |s: &super::GitStatus| {
            let mut v: Vec<(String, String, bool)> = s
                .changes
                .iter()
                .map(|c| (c.relative.clone(), c.status.clone(), c.staged))
                .collect();
            v.sort();
            v
        };
        assert_eq!(rows(&full), rows(&lean), "the same rows either way");
        assert_eq!(rows(&full).len(), 2, "one modified, one untracked");
        assert!(
            full.changes.iter().any(|c| c.added > 0),
            "the full status carries line counts"
        );
        assert!(
            lean.changes
                .iter()
                .all(|c| c.added == 0 && c.removed == 0 && !c.binary),
            "the lean status carries none"
        );
        assert_eq!(full.branch, lean.branch);
        let _ = std::fs::remove_dir_all(&tmp);
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

#[cfg(test)]
mod find_repos_tests {
    use super::find_repos;
    use std::fs;

    #[test]
    fn finds_nested_checkouts_and_skips_dependency_and_hidden_trees() {
        let root = std::env::temp_dir().join(format!("tedi-find-repos-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        for dir in [
            "a/.git",
            "b/c/.git",
            "node_modules/pkg/.git",
            ".hidden/x/.git",
            "too/deep/down/here/.git",
        ] {
            fs::create_dir_all(root.join(dir)).unwrap();
        }
        // A worktree / submodule carries a `.git` FILE.
        fs::create_dir_all(root.join("wt")).unwrap();
        fs::write(root.join("wt/.git"), "gitdir: ../a/.git/worktrees/wt").unwrap();

        let base = super::to_forward(&root.to_string_lossy());
        let got: Vec<String> = find_repos(&root, 3)
            .into_iter()
            .map(|p| p.trim_start_matches(&base).to_string())
            .collect();
        let _ = fs::remove_dir_all(&root);
        assert_eq!(got, vec!["/a", "/b/c", "/wt"]);
    }
}
