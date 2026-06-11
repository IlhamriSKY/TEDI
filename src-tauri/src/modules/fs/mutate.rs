use std::path::PathBuf;

/// Create an empty file. Fails if it already exists.
#[tauri::command]
pub fn fs_create_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    std::fs::write(&p, "").map_err(|e| {
        log::debug!("fs_create_file({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Create a directory, creating parents as needed. Fails if the path
/// already exists. Matches the "new folder" UX where typing "a/b/c"
/// creates the full chain.
#[tauri::command]
pub fn fs_create_dir(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.exists() {
        return Err(format!("already exists: {}", p.display()));
    }
    std::fs::create_dir_all(&p).map_err(|e| {
        log::debug!("fs_create_dir({}) failed: {e}", p.display());
        e.to_string()
    })
}

/// Rename or move a path. Refuses to overwrite an existing target.
#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    let from_p = PathBuf::from(&from);
    let to_p = PathBuf::from(&to);
    if !from_p.exists() {
        return Err(format!("not found: {}", from_p.display()));
    }
    if to_p.exists() {
        return Err(format!("already exists: {}", to_p.display()));
    }
    std::fs::rename(&from_p, &to_p).map_err(|e| {
        log::debug!(
            "fs_rename({} -> {}) failed: {e}",
            from_p.display(),
            to_p.display()
        );
        e.to_string()
    })
}

/// Copy a file or directory (recursive for dirs). Refuses to overwrite an
/// existing target. Non-destructive, but still user-confirmed by callers.
#[tauri::command]
pub fn fs_copy(from: String, to: String) -> Result<(), String> {
    let from_p = PathBuf::from(&from);
    let to_p = PathBuf::from(&to);
    if !from_p.exists() {
        return Err(format!("not found: {}", from_p.display()));
    }
    if to_p.exists() {
        return Err(format!("already exists: {}", to_p.display()));
    }
    let meta = std::fs::symlink_metadata(&from_p).map_err(|e| {
        log::debug!("fs_copy stat({}) failed: {e}", from_p.display());
        e.to_string()
    })?;
    let result = if meta.is_dir() {
        copy_dir_recursive(&from_p, &to_p)
    } else {
        std::fs::copy(&from_p, &to_p).map(|_| ())
    };
    result.map_err(|e| {
        log::warn!(
            "fs_copy({} -> {}) failed: {e}",
            from_p.display(),
            to_p.display()
        );
        e.to_string()
    })
}

fn copy_dir_recursive(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Delete a file or directory (recursive for dirs). Callers confirm
/// destructive operations with the user.
#[tauri::command]
pub fn fs_delete(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let meta = std::fs::symlink_metadata(&p).map_err(|e| {
        log::debug!("fs_delete stat({}) failed: {e}", p.display());
        e.to_string()
    })?;

    let result = if meta.is_dir() {
        std::fs::remove_dir_all(&p)
    } else {
        std::fs::remove_file(&p)
    };

    result.map_err(|e| {
        log::warn!("fs_delete({}) failed: {e}", p.display());
        e.to_string()
    })
}
