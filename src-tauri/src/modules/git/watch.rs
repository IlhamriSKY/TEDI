//! Change notifications for a local repository, so the git views refresh when
//! something changed instead of asking git every 2.5 seconds whether it did.
//!
//! Measured before this existed: every Explorer and the Source Control panel
//! polled `git_status` on that clock, and one status is four git processes plus
//! the Git for Windows shim and a conhost each, 161-253 ms of CPU. With the
//! duplicate calls shared that was still 8-13% of one core for as long as TEDI
//! had focus, and ~100 short-lived processes a minute in Task Manager, while the
//! working tree sat untouched: a watcher on the same two repositories over the
//! same 40 seconds saw ZERO changes. It also saw none caused by the polling
//! itself (`--no-optional-locks` status, numstat and ls-files write nothing), so
//! refreshing on an event cannot feed back into another event.
//!
//! A batch reports what it can have moved (`RepoChange`), because the two git
//! reads a view makes answer different questions. `git status` moves with any
//! working-tree path that is not gitignored and with `.git` itself minus the
//! object store and reflogs, which only ever change together with a ref or the
//! index. The ignored list moves only when an ignored path is created, removed
//! or renamed. Writes INTO an ignored file that already exists move neither,
//! and that is exactly where the noise lives - a Laravel log, a Vite cache, a
//! `target/` mid-build - so a watcher that fired on them would cost as much as
//! the poll it replaced, while a new `dist/` still gets dimmed promptly.
//!
//! Windows and macOS watch the root recursively, which is one handle. Everywhere
//! else (inotify, kqueue) a watch is one per DIRECTORY and the budget is shared
//! with every other program the user runs, so only non-ignored directories are
//! watched and a tree past `MAX_WATCHED_DIRS` is refused: taking an editor's
//! inotify budget away to save a poll would be the worse trade. A refused or
//! failed watch is not an error to the user - the caller simply keeps polling,
//! exactly as before. So does a network path, where change notifications are
//! unreliable enough that a missed event would read as a stale panel.

use ignore::gitignore::Gitignore;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

/// A burst (a save, a checkout, `npm run build` writing a tracked file) is
/// reported once, after it has been quiet this long...
const QUIET: Duration = Duration::from_millis(250);
/// ...but never later than this after it started, so a continuous stream of
/// writes still refreshes the panel. The caller throttles on top of this.
const MAX_BATCH: Duration = Duration::from_millis(1000);
/// Paths remembered per batch. Past this the batch is simply "changed": a
/// branch switch can touch tens of thousands of files, and all of them together
/// mean exactly what the first one did.
const MAX_BATCH_PATHS: usize = 4096;
#[cfg(not(any(windows, target_os = "macos")))]
const MAX_WATCHED_DIRS: usize = 2_000;

type SharedWatcher = Arc<Mutex<RecommendedWatcher>>;

struct Entry {
    id: u32,
    // Dropping the watcher is what stops it: its event sender goes with it, and
    // the pump thread sees the channel close and exits.
    _watcher: SharedWatcher,
}

/// Live watches, one per (window, root). Per WINDOW because a float window is a
/// second webview with its own subscriptions, and letting it replace the main
/// window's watch would silently drop the main window back to its safety poll.
fn watches() -> &'static Mutex<HashMap<(String, PathBuf), Entry>> {
    static WATCHES: OnceLock<Mutex<HashMap<(String, PathBuf), Entry>>> = OnceLock::new();
    WATCHES.get_or_init(Default::default)
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// Watch the repository at `root` and call `on_change` after anything in it that
/// can move `git status` changes. Resolves to an id for [`git_unwatch`], or an
/// error meaning "keep polling".
#[tauri::command]
pub async fn git_watch(
    window: tauri::Window,
    root: String,
    on_change: Channel<RepoChange>,
) -> Result<u32, String> {
    let label = window.label().to_string();
    // The ignore walk and, off Windows/macOS, one watch per directory: file I/O
    // that must stay off the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        watch_blocking(label, PathBuf::from(root), move |change| {
            on_change.send(change).is_ok()
        })
    })
    .await
    .map_err(|e| format!("git_watch join error: {e}"))?
}

#[tauri::command]
pub async fn git_unwatch(window: tauri::Window, id: u32) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || unwatch(&label, id))
        .await
        .map_err(|e| format!("git_unwatch join error: {e}"))
}

fn unwatch(label: &str, id: u32) {
    let removed = {
        let mut map = watches().lock().unwrap();
        let key = map
            .iter()
            .find(|(k, e)| k.0 == label && e.id == id)
            .map(|(k, _)| k.clone());
        key.and_then(|k| map.remove(&k))
    };
    // Outside the lock: stopping a watcher can wait on its thread.
    drop(removed);
}

fn watch_blocking(
    label: String,
    root: PathBuf,
    on_change: impl Fn(RepoChange) -> bool + Send + 'static,
) -> Result<u32, String> {
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    if is_network_path(&root) {
        return Err("network path: change notifications are unreliable, keep polling".into());
    }
    let filter = IgnoreFilter::build(&root);
    let (tx, rx) = std::sync::mpsc::channel();
    let watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    let watcher: SharedWatcher = Arc::new(Mutex::new(watcher));
    let watched = {
        let mut w = watcher.lock().unwrap();
        arm(&mut w, &root)?
    };

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let key = (label, root.clone());
    // A second watch for the same window and root means the page that owned the
    // first one is gone (a reload never calls unwatch), so it replaces it.
    let replaced = watches().lock().unwrap().insert(
        key.clone(),
        Entry {
            id,
            _watcher: watcher.clone(),
        },
    );
    drop(replaced);

    let weak = Arc::downgrade(&watcher);
    std::thread::Builder::new()
        .name("git-watch".into())
        .spawn(move || {
            pump(rx, root, filter, weak, watched, on_change);
            // The page stopped listening (or the watch was dropped). Only remove
            // our OWN entry: a replacement may already sit under this key.
            unwatch(&key.0, id);
        })
        .map_err(|e| e.to_string())?;
    Ok(id)
}

/// What a batch of changes can have moved, so a view runs only the git command
/// that can show it.
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RepoChange {
    /// `git status` may read differently: a working-tree path that is not
    /// ignored, or `.git` state (the index, HEAD, a ref).
    pub tracked: bool,
    /// The IGNORED list may read differently: an ignored path was created,
    /// removed or renamed, an ignore file changed, or the index did (a `git rm
    /// --cached` moves a file onto that list). Content written to an ignored
    /// file that already existed - a log line, a cache entry - moves nothing,
    /// which is the whole point: that is the noise.
    pub ignored: bool,
}

/// Collect events into quiet-terminated batches and report each batch that
/// can have moved something. Returns when the watcher is dropped or the
/// listener has gone away.
fn pump(
    rx: Receiver<notify::Result<notify::Event>>,
    root: PathBuf,
    mut filter: IgnoreFilter,
    #[allow(unused_variables)] watcher: Weak<Mutex<RecommendedWatcher>>,
    // Per-directory watches already placed, so directories created later count
    // against the same `MAX_WATCHED_DIRS` as the initial tree. Always 0 where
    // one recursive watch covers everything.
    #[allow(unused_variables)] watched: usize,
    on_change: impl Fn(RepoChange) -> bool,
) {
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut watched = watched;
    while let Ok(first) = rx.recv() {
        let started = Instant::now();
        let mut batch = Batch::default();
        batch.add(first);
        loop {
            let left = MAX_BATCH.saturating_sub(started.elapsed()).min(QUIET);
            if left.is_zero() {
                break;
            }
            match rx.recv_timeout(left) {
                Ok(ev) => batch.add(ev),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => return,
            }
        }

        if batch.paths.keys().any(|p| is_ignore_file(&root, p)) {
            filter = IgnoreFilter::build(&root);
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        if let Some(w) = watcher.upgrade() {
            for dir in &batch.new_dirs {
                if filter.classify(dir) == Class::Tracked {
                    // Past the cap the new directory goes unwatched; its parent
                    // still reports it being created, and the caller's safety
                    // poll covers edits inside it. The count only grows: the
                    // kernel drops a deleted directory's watch without telling
                    // us, so this errs toward watching less, never more.
                    let _ = add_tree(&mut w.lock().unwrap(), dir, &mut watched);
                }
            }
        }

        let change = batch.change(&root, &filter);
        if change != RepoChange::default() && !on_change(change) {
            return;
        }
    }
}

#[derive(Default)]
struct Batch {
    /// Each path, and whether any event on it created, removed or renamed it.
    paths: HashMap<PathBuf, bool>,
    /// An error, an overflow, or a batch too big to remember: report it.
    rescan: bool,
    #[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
    new_dirs: Vec<PathBuf>,
}

impl Batch {
    fn add(&mut self, ev: notify::Result<notify::Event>) {
        let Ok(ev) = ev else {
            self.rescan = true;
            return;
        };
        if ev.need_rescan() {
            self.rescan = true;
        }
        let created = matches!(ev.kind, notify::EventKind::Create(_));
        let structural = created
            || matches!(
                ev.kind,
                notify::EventKind::Remove(_)
                    | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
            );
        for p in ev.paths {
            if created && cfg!(not(any(windows, target_os = "macos"))) && p.is_dir() {
                self.new_dirs.push(p.clone());
            }
            if let Some(seen) = self.paths.get_mut(&p) {
                *seen |= structural;
            } else if self.paths.len() < MAX_BATCH_PATHS {
                self.paths.insert(p, structural);
            } else {
                self.rescan = true;
            }
        }
    }

    fn change(&self, root: &Path, filter: &IgnoreFilter) -> RepoChange {
        if self.rescan {
            return RepoChange {
                tracked: true,
                ignored: true,
            };
        }
        let mut change = RepoChange::default();
        for (p, &structural) in &self.paths {
            if is_ignore_file(root, p) || is_index(root, p) {
                change = RepoChange {
                    tracked: true,
                    ignored: true,
                };
                break;
            }
            match filter.classify(p) {
                Class::Tracked => change.tracked = true,
                Class::Ignored if structural => change.ignored = true,
                Class::Ignored | Class::GitNoise => {}
            }
            if change.tracked && change.ignored {
                break;
            }
        }
        change
    }
}

fn is_ignore_file(root: &Path, p: &Path) -> bool {
    p.file_name().is_some_and(|n| n == ".gitignore") || p == root.join(".git/info/exclude")
}

/// The index of this repository, or of the worktree or submodule whose gitdir
/// lives outside it.
fn is_index(root: &Path, p: &Path) -> bool {
    p.file_name().is_some_and(|n| n == "index")
        && (p.parent() == Some(&root.join(".git")) || !p.starts_with(root))
}

#[derive(Debug, PartialEq, Eq)]
enum Class {
    /// Can move `git status`.
    Tracked,
    /// Gitignored: only its creation or removal matters, and only to the
    /// ignored list.
    Ignored,
    /// Git's object store and reflogs, which only ever change alongside a ref
    /// or the index that is already reported.
    GitNoise,
}

/// Sorts a changed path into what it can affect.
struct IgnoreFilter {
    root: PathBuf,
    /// One matcher per ignore file with the directory it applies from, deepest
    /// first, because a nested `.gitignore` is anchored to its own directory
    /// and overrides the ones above it - folding them into one matcher would
    /// anchor `/build` in `sub/.gitignore` to the ROOT and drop real changes.
    files: Vec<(PathBuf, Gitignore)>,
    global: Gitignore,
}

impl IgnoreFilter {
    fn build(root: &Path) -> Self {
        let mut files = Vec::new();
        let exclude = root.join(".git").join("info").join("exclude");
        if exclude.is_file() {
            let mut b = ignore::gitignore::GitignoreBuilder::new(root);
            b.add(&exclude);
            if let Ok(g) = b.build() {
                files.push((root.to_path_buf(), g));
            }
        }
        // The walker honours the ignore files it has already read, so it never
        // descends into `node_modules` looking for more of them.
        for entry in ignore::WalkBuilder::new(root)
            .hidden(false)
            .filter_entry(|e| e.file_name() != ".git")
            .build()
            .flatten()
        {
            if entry.file_name() == ".gitignore" {
                if let Some(dir) = entry.path().parent() {
                    let (g, _) = Gitignore::new(entry.path());
                    files.push((dir.to_path_buf(), g));
                }
            }
        }
        files.sort_by_key(|(dir, _)| std::cmp::Reverse(dir.components().count()));
        let (global, _) = Gitignore::global();
        Self {
            root: root.to_path_buf(),
            files,
            global,
        }
    }

    fn classify(&self, path: &Path) -> Class {
        // Outside the root is the gitdir of a worktree or submodule: its HEAD
        // and index are exactly what a status reads.
        let Ok(rel) = path.strip_prefix(&self.root) else {
            return Class::Tracked;
        };
        let mut comps = rel.components();
        match comps.next() {
            None => return Class::Tracked,
            Some(first) if first.as_os_str() == ".git" => {
                let second = comps
                    .next()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned());
                return if matches!(
                    second.as_deref(),
                    Some("objects" | "logs" | "lfs" | "fsmonitor--daemon")
                ) {
                    Class::GitNoise
                } else {
                    Class::Tracked
                };
            }
            Some(_) => {}
        }
        let is_dir = path.is_dir();
        for (dir, g) in &self.files {
            if let Ok(under) = path.strip_prefix(dir) {
                let m = g.matched_path_or_any_parents(under, is_dir);
                if m.is_ignore() {
                    return Class::Ignored;
                }
                if m.is_whitelist() {
                    return Class::Tracked;
                }
            }
        }
        if self
            .global
            .matched_path_or_any_parents(rel, is_dir)
            .is_ignore()
        {
            Class::Ignored
        } else {
            Class::Tracked
        }
    }
}

/// The gitdir of a worktree or submodule, whose `.git` is a file pointing at it.
fn external_gitdir(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if !dot_git.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let target = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let path = root.join(target);
    path.is_dir().then_some(path)
}

/// Place the watches. Returns how many per-directory watches that took.
#[cfg(any(windows, target_os = "macos"))]
fn arm(w: &mut RecommendedWatcher, root: &Path) -> Result<usize, String> {
    w.watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    if let Some(gitdir) = external_gitdir(root) {
        let _ = w.watch(&gitdir, RecursiveMode::Recursive);
    }
    Ok(0)
}

/// Place the watches. Returns how many per-directory watches that took.
#[cfg(not(any(windows, target_os = "macos")))]
fn arm(w: &mut RecommendedWatcher, root: &Path) -> Result<usize, String> {
    let mut count = 0;
    add_tree(w, root, &mut count)?;
    let git = root.join(".git");
    let gitdir = if git.is_dir() {
        Some(git)
    } else {
        external_gitdir(root)
    };
    if let Some(gitdir) = gitdir {
        // The index, HEAD, FETCH_HEAD and COMMIT_EDITMSG live at the top; refs
        // is a small tree, and a push moves nothing else a status reads.
        w.watch(&gitdir, RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
        let refs = gitdir.join("refs");
        if refs.is_dir() {
            let _ = w.watch(&refs, RecursiveMode::Recursive);
        }
    }
    Ok(count)
}

/// Watch `dir` and every non-ignored directory below it, one non-recursive watch
/// each. `count` is shared with the caller so the cap covers the whole root.
#[cfg(not(any(windows, target_os = "macos")))]
fn add_tree(w: &mut RecommendedWatcher, dir: &Path, count: &mut usize) -> Result<(), String> {
    for entry in ignore::WalkBuilder::new(dir)
        .hidden(false)
        .filter_entry(|e| e.file_name() != ".git")
        .build()
        .flatten()
    {
        if !entry.file_type().is_some_and(|t| t.is_dir()) {
            continue;
        }
        *count += 1;
        if *count > MAX_WATCHED_DIRS {
            return Err(format!(
                "more than {MAX_WATCHED_DIRS} directories to watch; keep polling"
            ));
        }
        w.watch(entry.path(), RecursiveMode::NonRecursive)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
fn is_network_path(p: &Path) -> bool {
    use std::path::{Component, Prefix};
    let Some(Component::Prefix(prefix)) = p.components().next() else {
        return false;
    };
    match prefix.kind() {
        Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
            let drive: Vec<u16> = format!("{}:\\", letter as char)
                .encode_utf16()
                .chain(Some(0))
                .collect();
            // SAFETY: `drive` is a NUL-terminated UTF-16 string that outlives the call.
            let kind =
                unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(drive.as_ptr()) };
            // DRIVE_REMOTE: a mapped network share.
            kind == 4
        }
        // UNC shares, `\\wsl.localhost\...`, device paths.
        _ => true,
    }
}

#[cfg(not(windows))]
fn is_network_path(_p: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tedi-git-watch-{name}-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".git").join("objects")).unwrap();
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("sub").join("build")).unwrap();
        std::fs::create_dir_all(dir.join("build")).unwrap();
        std::fs::write(dir.join(".gitignore"), "logs/\n*.log\n").unwrap();
        std::fs::write(dir.join("sub").join(".gitignore"), "/build\n").unwrap();
        std::fs::write(dir.join("logs").join("app.txt"), "noise").unwrap();
        dir
    }

    #[test]
    fn classify_follows_git_ignore_semantics() {
        let root = scratch("filter");
        let f = IgnoreFilter::build(&root);
        let is = |p: &str, want: Class| assert_eq!(f.classify(&root.join(p)), want, "{p}");
        is("src/main.rs", Class::Tracked);
        is(".gitignore", Class::Tracked);
        is(".git/index", Class::Tracked);
        is(".git/HEAD", Class::Tracked);
        is(".git/refs/heads/main", Class::Tracked);
        is(".git/objects/ab/cdef", Class::GitNoise);
        is(".git/logs/HEAD", Class::GitNoise);
        is("logs/app.txt", Class::Ignored);
        is("debug.log", Class::Ignored);
        is("src/deep/trace.log", Class::Ignored);
        // Anchored in sub/.gitignore: ignored under sub/, NOT at the root.
        is("sub/build/out.js", Class::Ignored);
        is("build/out.js", Class::Tracked);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn batch_of(events: Vec<(notify::EventKind, &str)>, root: &Path) -> Batch {
        let mut b = Batch::default();
        for (kind, p) in events {
            b.add(Ok(notify::Event::new(kind).add_path(root.join(p))));
        }
        b
    }

    #[test]
    fn a_batch_reports_only_what_it_can_have_moved() {
        use notify::event::{CreateKind, DataChange, ModifyKind, RemoveKind};
        let root = scratch("batch");
        let f = IgnoreFilter::build(&root);
        let write = notify::EventKind::Modify(ModifyKind::Data(DataChange::Any));
        let create = notify::EventKind::Create(CreateKind::File);
        let remove = notify::EventKind::Remove(RemoveKind::File);
        let change = |ev| batch_of(ev, &root).change(&root, &f);
        let none = RepoChange::default();
        let tracked = RepoChange {
            tracked: true,
            ignored: false,
        };
        let ignored = RepoChange {
            tracked: false,
            ignored: true,
        };
        let both = RepoChange {
            tracked: true,
            ignored: true,
        };

        assert_eq!(
            change(vec![(write, "logs/app.txt"), (write, "debug.log")]),
            none,
            "log lines move nothing"
        );
        assert_eq!(
            change(vec![(write, ".git/objects/ab/cd")]),
            none,
            "the object store alone moves nothing"
        );
        assert_eq!(
            change(vec![(create, "new.log")]),
            ignored,
            "a new ignored file moves the ignored list"
        );
        assert_eq!(
            change(vec![(remove, "logs/app.txt")]),
            ignored,
            "so does removing one"
        );
        assert_eq!(
            change(vec![(write, "src/main.rs")]),
            tracked,
            "an edit moves status only"
        );
        assert_eq!(
            change(vec![(write, "src/main.rs"), (create, "dist.log")]),
            both
        );
        assert_eq!(
            change(vec![(write, ".gitignore")]),
            both,
            "an ignore file moves both"
        );
        assert_eq!(
            change(vec![(write, ".git/index")]),
            both,
            "the index moves both (git rm --cached)"
        );
        let mut lost = Batch::default();
        lost.add(Err(notify::Error::generic("overflow")));
        assert_eq!(
            lost.change(&root, &f),
            both,
            "a lost event means anything moved"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// End to end on this platform's real backend: a log line stays silent, a
    /// new ignored file reaches the ignored list only, an edit reaches status,
    /// and dropping the watch stops it.
    #[test]
    fn reports_real_changes_by_kind() {
        let root = scratch("e2e");
        let (tx, rx) = mpsc::channel();
        let id = watch_blocking("test".into(), root.clone(), move |c| tx.send(c).is_ok())
            .expect("watch");
        // Let the backend settle before the first write.
        std::thread::sleep(Duration::from_millis(300));

        std::fs::write(root.join("logs").join("app.txt"), "more noise").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(900)).is_err(),
            "appending to an existing ignored file must not be reported"
        );

        std::fs::write(root.join("fresh.log"), "x").unwrap();
        let got = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("new ignored file");
        assert_eq!(
            got,
            RepoChange {
                tracked: false,
                ignored: true
            }
        );

        std::fs::write(root.join("src").join("main.rs"), "fn main() {}").unwrap();
        let got = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("tracked edit");
        assert!(
            got.tracked,
            "an edit to a tracked path must reach status: {got:?}"
        );

        unwatch("test", id);
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        std::fs::write(root.join("src").join("main.rs"), "fn main() { }").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(900)).is_err(),
            "nothing is reported after unwatch"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
