//! Bookkeeping shared by `fs::watch` and `git::watch`: at most one live watcher
//! per (window, root), released by id, by window, or by being replaced.

use notify::RecommendedWatcher;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

pub(crate) type SharedWatcher = Arc<Mutex<RecommendedWatcher>>;

struct Entry {
    id: u32,
    // Dropping the watcher is what stops it: its event sender goes with it, and
    // the pump thread sees the channel close and exits.
    _watcher: SharedWatcher,
}

/// Live watches keyed by (window, root). Per WINDOW because a float window is a
/// second webview with its own subscriptions, and letting it replace the main
/// window's watch would silently drop the main window back to polling.
pub(crate) struct Registry {
    map: OnceLock<Mutex<HashMap<(String, PathBuf), Entry>>>,
    next_id: AtomicU32,
}

impl Registry {
    pub(crate) const fn new() -> Self {
        Self {
            map: OnceLock::new(),
            next_id: AtomicU32::new(1),
        }
    }

    fn map(&self) -> &Mutex<HashMap<(String, PathBuf), Entry>> {
        self.map.get_or_init(Default::default)
    }

    /// Take this in the async command, before the blocking hop, so ids follow
    /// call order (see `insert`).
    pub(crate) fn next_id(&self) -> u32 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// A second watch for the same window and root means the page that owned the
    /// first is gone (a reload never calls unwatch), so it replaces it. An older
    /// call that finishes arming late never replaces a newer one: its watcher is
    /// dropped instead, and its pump exits.
    pub(crate) fn insert(&self, label: String, root: PathBuf, id: u32, watcher: SharedWatcher) {
        let entry = Entry {
            id,
            _watcher: watcher,
        };
        let replaced = {
            let mut map = self.map().lock().unwrap();
            let key = (label, root);
            match map.get(&key) {
                Some(newer) if newer.id > id => Some(entry),
                _ => map.insert(key, entry),
            }
        };
        // Outside the lock: stopping a watcher can wait on its thread.
        drop(replaced);
    }

    /// Remove one watch, by id, so a replacement under the same key survives.
    pub(crate) fn unwatch(&self, label: &str, id: u32) {
        let removed = {
            let mut map = self.map().lock().unwrap();
            let key = map
                .iter()
                .find(|(k, e)| k.0 == label && e.id == id)
                .map(|(k, _)| k.clone());
            key.and_then(|k| map.remove(&k))
        };
        drop(removed);
    }

    /// Drop every watch a closed window owned. A Channel to a destroyed webview
    /// still reports `Ok` on send, so its pump would otherwise run, and hold a
    /// recursive watch, for the rest of the app's life.
    pub(crate) fn drop_window(&self, label: &str) {
        let removed: Vec<Entry> = {
            let mut map = self.map().lock().unwrap();
            let keys: Vec<_> = map.keys().filter(|k| k.0 == label).cloned().collect();
            keys.iter().filter_map(|k| map.remove(k)).collect()
        };
        drop(removed);
    }
}

/// SMB shares, mapped network drives and `\\wsl.localhost` drop change
/// notifications, so a watch there would read as a stale view: callers refuse
/// and the frontend keeps polling.
#[cfg(windows)]
pub(crate) fn is_network_path(p: &Path) -> bool {
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
pub(crate) fn is_network_path(_p: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watcher() -> SharedWatcher {
        Arc::new(Mutex::new(notify::recommended_watcher(|_| {}).unwrap()))
    }

    fn ids(r: &Registry) -> Vec<(String, u32)> {
        let mut v: Vec<_> = r
            .map()
            .lock()
            .unwrap()
            .iter()
            .map(|(k, e)| (k.0.clone(), e.id))
            .collect();
        v.sort();
        v
    }

    #[test]
    fn a_late_older_watch_never_replaces_a_newer_one() {
        let r = Registry::new();
        let (older, newer) = (r.next_id(), r.next_id());
        r.insert("main".into(), "/repo".into(), newer, watcher());
        r.insert("main".into(), "/repo".into(), older, watcher());
        assert_eq!(ids(&r), vec![("main".into(), newer)]);
        // The older caller's deferred unwatch must not take the newer one down.
        r.unwatch("main", older);
        assert_eq!(ids(&r), vec![("main".into(), newer)]);
    }

    #[test]
    fn a_closed_window_drops_only_its_own_watches() {
        let r = Registry::new();
        r.insert("main".into(), "/a".into(), r.next_id(), watcher());
        r.insert("float-1".into(), "/a".into(), r.next_id(), watcher());
        r.insert("float-1".into(), "/b".into(), r.next_id(), watcher());
        r.drop_window("float-1");
        assert_eq!(ids(&r), vec![("main".into(), 1)]);
    }
}
