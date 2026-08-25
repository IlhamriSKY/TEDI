use std::path::PathBuf;
use std::time::UNIX_EPOCH;

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Dir,
    Symlink,
}

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Milliseconds since UNIX epoch; 0 if unavailable.
    pub mtime: u64,
}

/// List immediate children of `path`. Dirs first, then symlinks, then files,
/// each group sorted case-insensitively. Hidden (dot-prefix) entries filtered
/// unless `include_hidden` is true.
///
/// Offloaded like `git_status`: a sync `#[tauri::command]` runs on the WebView2
/// UI (main) thread on Windows, and this one costs a `read_dir` plus a
/// `metadata()` stat PER ENTRY. The explorer refreshes every loaded directory
/// on window focus AND on visibilitychange, so unlocking the machine fires one
/// of these per expanded folder back to back against a cold disk cache - enough
/// serialized UI-thread work to trip Windows' 5s "not responding" hang report.
#[tauri::command]
pub async fn fs_read_dir(
    path: String,
    include_hidden: Option<bool>,
) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || fs_read_dir_inner(path, include_hidden))
        .await
        .map_err(|e| format!("fs_read_dir join error: {e}"))?
}

fn fs_read_dir_inner(path: String, include_hidden: Option<bool>) -> Result<Vec<DirEntry>, String> {
    let show_hidden = include_hidden.unwrap_or(false);
    let root = PathBuf::from(&path);
    let read = std::fs::read_dir(&root).map_err(|e| {
        log::debug!("fs_read_dir({}) failed: {e}", root.display());
        e.to_string()
    })?;

    let mut entries: Vec<DirEntry> = read
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            if !show_hidden && name.starts_with('.') {
                return None;
            }

            // `metadata()` follows symlinks and returns the target's stat in
            // one syscall. Fall back to `symlink_metadata` for broken
            // symlinks so we do not silently drop them from the listing.
            let (meta, was_symlink) = match std::fs::metadata(entry.path()) {
                Ok(m) => (Some(m), false),
                Err(_) => (entry.metadata().ok(), true),
            };
            let meta = meta?;

            let kind = if was_symlink {
                EntryKind::Symlink
            } else if meta.is_dir() {
                EntryKind::Dir
            } else {
                EntryKind::File
            };

            let size = meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);

            Some(DirEntry {
                name,
                kind,
                size,
                mtime,
            })
        })
        .collect();

    entries.sort_by(|a, b| {
        let rank = |k: &EntryKind| match k {
            EntryKind::Dir => 0,
            EntryKind::Symlink => 1,
            EntryKind::File => 2,
        };
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(entries)
}

/// List immediate subdirectories of `path`. Used by CwdBreadcrumb.
///
/// Symlinks to directories are included (matches shell `cd` semantics).
/// Hidden entries filtered by dot-prefix only.
#[tauri::command]
pub async fn list_subdirs(path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || list_subdirs_inner(path))
        .await
        .map_err(|e| format!("list_subdirs join error: {e}"))?
}

fn list_subdirs_inner(path: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&path);
    let read = std::fs::read_dir(&root).map_err(|e| {
        log::debug!("list_subdirs({}) read_dir failed: {e}", root.display());
        e.to_string()
    })?;

    let mut dirs: Vec<String> = read
        .filter_map(Result::ok)
        .filter(|entry| match entry.file_type() {
            Ok(t) if t.is_dir() => true,
            Ok(t) if t.is_symlink() => std::fs::metadata(entry.path())
                .map(|m| m.is_dir())
                .unwrap_or(false),
            _ => false,
        })
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| !name.starts_with('.'))
        .collect();

    dirs.sort_by_key(|a| a.to_lowercase());
    Ok(dirs)
}
