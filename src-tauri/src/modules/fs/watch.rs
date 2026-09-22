//! Change notifications for a directory tree, so the file explorer reflects a
//! write it did not make - a `git checkout`, a build, another editor - within a
//! fraction of a second instead of on the next poll tick.
//!
//! The Explorer used to re-read the root and every expanded directory every
//! four seconds for as long as TEDI had focus. That is one `fs_read_dir` round
//! trip per visible directory, four times a minute, to notice nothing; and when
//! the tree sat over `node_modules` that listing is not free. A watcher costs
//! one handle while the working tree is quiet and reports a save ~200 ms after
//! it lands, which is also sooner than the poll ever did. The poll does not go
//! away: it drops to a slow safety net, so a host that refuses the watch (a
//! network path, a tree past the platform's watch budget, an older host) keeps
//! behaving exactly as before.
//!
//! A batch reports the PARENT DIRECTORIES that can list differently, not the
//! raw paths: the tree holds one listing per directory, so a directory name is
//! all it needs, and a `git checkout` touching thousands of files under one
//! folder collapses to that one folder. Git's object store and reflogs are
//! dropped on the way - they churn on every git command and move nothing the
//! tree shows - so a `git status` does not repaint the Explorer.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

/// A burst (a save, a checkout, a build writing many files) is reported once,
/// after it has been quiet this long...
const QUIET: Duration = Duration::from_millis(200);
/// ...but never later than this after it started, so a continuous stream of
/// writes still reaches the tree.
const MAX_BATCH: Duration = Duration::from_millis(1000);
/// Directories remembered per batch. Past this the batch is reported as a
/// rescan: a directory rename can move tens of thousands of paths, and all of
/// them together mean exactly what refreshing everything does.
const MAX_BATCH_DIRS: usize = 512;

type SharedWatcher = Arc<Mutex<RecommendedWatcher>>;

struct Entry {
    id: u32,
    // Dropping the watcher stops it: its event sender goes with it and the pump
    // thread sees the channel close and exits.
    _watcher: SharedWatcher,
}

/// Live watches, one per (window, root). Per WINDOW because a float window is a
/// second webview with its own subscriptions, and letting it replace the main
/// window's watch would silently drop the main window back to polling.
fn watches() -> &'static Mutex<std::collections::HashMap<(String, PathBuf), Entry>> {
    static WATCHES: OnceLock<Mutex<std::collections::HashMap<(String, PathBuf), Entry>>> =
        OnceLock::new();
    WATCHES.get_or_init(Default::default)
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// Watch the directory tree at `root` and call `on_change` after anything in it
/// that can change a listing. Resolves to an id for [`fs_unwatch`], or an error
/// meaning "keep polling".
#[tauri::command]
pub async fn fs_watch(
    window: tauri::Window,
    root: String,
    on_change: Channel<FsChange>,
) -> Result<u32, String> {
    let label = window.label().to_string();
    // Arming a recursive watch walks the tree: file I/O that must stay off the
    // UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        watch_blocking(label, PathBuf::from(root), move |change| {
            on_change.send(change).is_ok()
        })
    })
    .await
    .map_err(|e| format!("fs_watch join error: {e}"))?
}

#[tauri::command]
pub async fn fs_unwatch(window: tauri::Window, id: u32) -> Result<(), String> {
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || unwatch(&label, id))
        .await
        .map_err(|e| format!("fs_unwatch join error: {e}"))
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
    on_change: impl Fn(FsChange) -> bool + Send + 'static,
) -> Result<u32, String> {
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    let watcher: SharedWatcher = Arc::new(Mutex::new(watcher));
    watcher
        .lock()
        .unwrap()
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let key = (label, root.clone());
    // A second watch for the same window and root means the page that owned the
    // first one is gone (a reload never calls unwatch), so it replaces it.
    let replaced = watches().lock().unwrap().insert(
        key.clone(),
        Entry {
            id,
            _watcher: watcher,
        },
    );
    drop(replaced);

    let cleanup_key = key.clone();
    if let Err(e) = std::thread::Builder::new()
        .name("fs-watch".into())
        .spawn(move || {
            pump(rx, on_change);
            // The page stopped listening (or the watch was dropped). Only remove
            // our OWN entry: a replacement may already sit under this key.
            unwatch(&key.0, id);
        })
    {
        // Nothing will ever pump this watch, so the entry must not outlive it.
        // By id, in case a replacement already took the key.
        unwatch(&cleanup_key.0, id);
        return Err(e.to_string());
    }
    Ok(id)
}

/// A batch of changes, as the explorer needs it: which directory listings can
/// have changed, or that so much moved that everything should be re-read.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct FsChange {
    /// Parent directories that may list differently, forward-slash and deduped.
    pub dirs: Vec<String>,
    /// The batch was too big or an event was lost: refresh every loaded
    /// directory rather than trusting `dirs`.
    pub rescan: bool,
}

/// Collect events into quiet-terminated batches and report each batch. Returns
/// when the watcher is dropped or the listener has gone away.
fn pump(rx: Receiver<notify::Result<notify::Event>>, on_change: impl Fn(FsChange) -> bool) {
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
        let change = batch.change();
        if change.dirs.is_empty() && !change.rescan {
            continue;
        }
        if !on_change(change) {
            return;
        }
    }
}

#[derive(Default)]
struct Batch {
    /// Parent directories that may list differently.
    dirs: HashSet<PathBuf>,
    /// An error, an overflow, a batch too big to trust: refresh everything.
    rescan: bool,
}

impl Batch {
    fn add(&mut self, ev: notify::Result<notify::Event>) {
        let Ok(ev) = ev else {
            self.rescan = true;
            return;
        };
        // inotify also reports opens and closes; a directory read is an open, so
        // counting them would make `fs_read_dir` itself look like a change.
        if ev.kind.is_access() {
            return;
        }
        if ev.need_rescan() {
            self.rescan = true;
        }
        for p in ev.paths {
            if is_git_noise(&p) {
                continue;
            }
            let dir = p
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(&p));
            if self.dirs.len() >= MAX_BATCH_DIRS && !self.dirs.contains(&dir) {
                self.rescan = true;
                continue;
            }
            self.dirs.insert(dir);
        }
    }

    fn change(&self) -> FsChange {
        if self.rescan {
            return FsChange {
                dirs: Vec::new(),
                rescan: true,
            };
        }
        let mut dirs: Vec<String> = self.dirs.iter().map(crate::modules::fs::to_canon).collect();
        dirs.sort();
        FsChange {
            dirs,
            rescan: false,
        }
    }
}

/// Git's object store and reflogs. They change on every git command and move
/// nothing the tree lists, so a `git status` must not repaint the Explorer.
fn is_git_noise(p: &Path) -> bool {
    let mut comps = p.components();
    while let Some(c) = comps.next() {
        if c.as_os_str() == ".git" {
            return matches!(
                comps.next().and_then(|n| n.as_os_str().to_str()),
                Some("objects" | "logs" | "lfs" | "fsmonitor--daemon")
            );
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tedi-fs-watch-{name}-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join(".git").join("objects")).unwrap();
        dir
    }

    fn batch_of(events: Vec<(notify::EventKind, &str)>, root: &Path) -> Batch {
        let mut b = Batch::default();
        for (kind, p) in events {
            b.add(Ok(notify::Event::new(kind).add_path(root.join(p))));
        }
        b
    }

    #[test]
    fn a_batch_names_the_directories_that_can_have_changed() {
        use notify::event::{CreateKind, DataChange, ModifyKind};
        let root = scratch("batch");
        let write = notify::EventKind::Modify(ModifyKind::Data(DataChange::Any));
        let create = notify::EventKind::Create(CreateKind::File);

        let b = batch_of(vec![(write, "src/main.rs"), (create, "src/lib.rs")], &root);
        assert_eq!(
            b.change().dirs,
            vec![crate::modules::fs::to_canon(root.join("src"))],
            "two files in one directory collapse to one entry"
        );

        let b = batch_of(vec![(write, "top.md")], &root);
        assert_eq!(b.change().dirs, vec![crate::modules::fs::to_canon(&root)]);

        let b = batch_of(vec![(write, ".git/objects/ab/cd")], &root);
        assert!(
            b.change().dirs.is_empty(),
            "the object store moves nothing the tree shows"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_access_is_not_a_change() {
        use notify::event::{AccessKind, AccessMode};
        let root = scratch("access");
        let open = notify::EventKind::Access(AccessKind::Open(AccessMode::Any));
        let b = batch_of(vec![(open, "src/main.rs")], &root);
        assert!(b.change().dirs.is_empty(), "reading a dir is not a change");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_overflow_asks_for_a_rescan() {
        let root = scratch("overflow");
        let mut b = Batch::default();
        b.add(Err(notify::Error::generic("overflow")));
        assert!(b.change().rescan);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn git_noise_is_recognised() {
        assert!(is_git_noise(Path::new("/x/.git/objects/ab/cd")));
        assert!(is_git_noise(Path::new("/x/.git/logs/HEAD")));
        assert!(!is_git_noise(Path::new("/x/.git/HEAD")));
        assert!(!is_git_noise(Path::new("/x/src/.gitkeep")));
        assert!(!is_git_noise(Path::new("/x/src/main.rs")));
    }

    /// End to end on this platform's real backend: creating a file is reported
    /// against its directory, and dropping the watch stops it.
    #[test]
    fn reports_a_real_write_and_stops_on_unwatch() {
        let root = scratch("e2e");
        let (tx, rx) = mpsc::channel();
        let id = watch_blocking("test".into(), root.clone(), move |c| tx.send(c).is_ok())
            .expect("watch");
        std::thread::sleep(Duration::from_millis(300));

        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("new.rs"), "x").unwrap();
        let got = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("a write is reported");
        assert!(
            got.dirs
                .contains(&crate::modules::fs::to_canon(root.join("src"))),
            "the new file's directory is named: {got:?}"
        );

        unwatch("test", id);
        std::thread::sleep(Duration::from_millis(300));
        while rx.try_recv().is_ok() {}
        std::fs::write(root.join("src").join("new.rs"), "y").unwrap();
        assert!(
            rx.recv_timeout(Duration::from_millis(900)).is_err(),
            "nothing is reported after unwatch"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
