//! Install pipeline for extensions.
//!
//! Reads a .zip from disk, bytes, or URL, validates it, extracts into
//! `<extensions_dir>/<id>/`, then updates the persisted state entry. Any
//! existing folder for the same id is wiped first.
//!
//! Guards: `enclosed_name()` rejects zip entries that resolve outside the
//! destination root. Symlinks are written as data files (not followed).
//! Total uncompressed size capped at `MAX_INSTALL_BYTES`; per-entry at
//! `MAX_FILE_BYTES`. Manifest is parsed before committing so a malformed
//! package never replaces a working install.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::commands::PeekResult;
use super::manifest::Manifest;
use super::state::{now_ms, save as save_state, ExtensionEntry};

/// 50 MiB cap on the whole package. Fits a JS bundle plus theme assets
/// without letting a runaway archive fill the user's disk.
const MAX_INSTALL_BYTES: u64 = 50 * 1024 * 1024;
/// 10 MiB per file. Inlined fonts are normally <500 KiB; anything above
/// this is suspicious for the extensions we expect.
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

pub struct InstallOutcome {
    pub manifest: Manifest,
    pub entry: ExtensionEntry,
    /// `true` when the install replaced an existing entry. UI uses this to
    /// pick "updated" vs "installed" copy. Surfaced through `ext_install_from_*`
    /// once the UI grows a distinct "updated" toast.
    #[allow(dead_code)]
    pub replaced: bool,
}

/// Run the install pipeline. `source` is recorded verbatim in the state file.
pub fn install_from_bytes(
    extensions_root: &Path,
    state_path: &Path,
    zip_bytes: &[u8],
    source: &str,
) -> Result<InstallOutcome, String> {
    if zip_bytes.len() as u64 > MAX_INSTALL_BYTES {
        return Err(format!(
            "extension package too large ({} bytes, cap {} bytes)",
            zip_bytes.len(),
            MAX_INSTALL_BYTES
        ));
    }

    // Stage to a temp dir under the extensions root for an atomic-ish swap.
    fs::create_dir_all(extensions_root).map_err(|e| format!("mkdir root: {e}"))?;
    let staging = extensions_root.join(format!(".staging-{}", now_ms()));
    if staging.exists() {
        fs::remove_dir_all(&staging).map_err(|e| format!("clear staging: {e}"))?;
    }
    fs::create_dir_all(&staging).map_err(|e| format!("mkdir staging: {e}"))?;

    let extract_result = extract_into(zip_bytes, &staging);
    if let Err(e) = extract_result {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }

    // Manifest must exist exactly at the staging root after extract_into.
    let manifest_path = staging.join("manifest.json");
    if !manifest_path.exists() {
        let _ = fs::remove_dir_all(&staging);
        return Err("manifest.json missing from package root".into());
    }
    let manifest_text =
        fs::read_to_string(&manifest_path).map_err(|e| format!("read manifest: {e}"))?;
    let manifest = match Manifest::parse(&manifest_text) {
        Ok(m) => m,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    };

    // Validate `main` if declared so a broken extension does not reach
    // the activation path.
    if let Some(main) = manifest.main.as_deref() {
        let resolved = resolve_inside_root(&staging, main)
            .ok_or_else(|| "manifest.main path escapes extension root".to_string())?;
        if !resolved.exists() {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("manifest.main not found in package: {main}"));
        }
    }

    // Commit: move staging to <root>/<id>, replacing any existing folder
    // for the same id.
    //
    // On Windows, a running sidecar binary inside the old folder locks
    // every file under it and turns `fs::remove_dir_all` into "Access is
    // denied (os error 5)". Renaming the directory works even when files
    // inside are in use (NTFS tracks files by handle, not path), so we
    // rename the old install aside and let a background thread delete the
    // trash. The new install lands at `dest` immediately. Stale `.trash-*`
    // dirs are reaped by `sweep_stale_staging` on the next list call.
    let dest = extensions_root.join(&manifest.id);
    let replaced = dest.exists();
    if replaced {
        let trash = extensions_root.join(format!(".trash-{}-{}", manifest.id, now_ms()));
        match fs::rename(&dest, &trash) {
            Ok(()) => {
                let trash_for_thread = trash.clone();
                std::thread::spawn(move || {
                    let _ = fs::remove_dir_all(&trash_for_thread);
                });
            }
            Err(rename_err) => {
                // Fallback: direct remove. Works on Linux/macOS because Unix
                // file handles survive unlink. On Windows this is the
                // original failure path; surface both errors so the cause
                // is clear.
                fs::remove_dir_all(&dest).map_err(|e| {
                    format!(
                        "remove old: {e} (rename also failed: {rename_err}). \
                         The extension's sidecar may still be holding files open; \
                         disable the extension first, then retry."
                    )
                })?;
            }
        }
    }
    fs::rename(&staging, &dest).map_err(|e| {
        // Best-effort cleanup if rename failed for any reason.
        let _ = fs::remove_dir_all(&staging);
        format!("commit install: {e}")
    })?;

    // Unix only: chmod 0o755 over `sidecar/` so bundled binaries are
    // executable. Zips do not carry POSIX mode bits reliably across
    // packagers. Scoped to `sidecar/` so we do not touch JS / JSON /
    // asset files. No-op on Windows.
    #[cfg(unix)]
    {
        let sidecar_root = dest.join("sidecar");
        if sidecar_root.exists() {
            if let Err(err) = make_sidecar_executable(&sidecar_root) {
                // Best-effort: log as a soft error but do not abort the
                // install. The extension can still try to spawn and report
                // a clearer failure.
                eprintln!("[extensions] chmod sidecar failed: {err}");
            }
        }
    }

    // Windows only: strip the Mark-of-the-Web alternate data stream
    // (`Zone.Identifier`) from every file under `sidecar/`. Tauri's
    // `reqwest` download attaches MOTW to everything we write, which makes
    // SmartScreen / Defender silently refuse to launch the binary via
    // shell_bg_spawn. Same effect as PowerShell's `Unblock-File`.
    #[cfg(target_os = "windows")]
    {
        let sidecar_root = dest.join("sidecar");
        if sidecar_root.exists() {
            if let Err(err) = strip_motw_from_tree(&sidecar_root) {
                eprintln!("[extensions] MOTW strip failed: {err}");
            }
        }
    }

    let fingerprint = hash_dir(&dest)?;

    let mut state = super::state::load(state_path);
    let prior = state.entries.get(&manifest.id).cloned();
    let entry = ExtensionEntry {
        enabled: prior.as_ref().map(|p| p.enabled).unwrap_or(true),
        source: source.to_string(),
        installed_at_ms: prior
            .as_ref()
            .map(|p| p.installed_at_ms)
            .unwrap_or_else(now_ms),
        version: manifest.version.clone(),
        fingerprint,
        approved_permissions: manifest.permissions.clone(),
        // Install resets the "latest_version" hint; the new install IS the
        // latest the user has seen. The next manual update check repopulates it.
        latest_version: None,
        last_checked_at_ms: None,
    };
    state.entries.insert(manifest.id.clone(), entry.clone());
    save_state(state_path, &state)?;

    Ok(InstallOutcome {
        manifest,
        entry,
        replaced,
    })
}

/// Walk the zip and write each entry into `dest`. Path traversal is rejected
/// via `enclosed_name()`. When every entry shares the same first segment and
/// `<segment>/manifest.json` exists (e.g. GitHub release archives), that
/// prefix is stripped on extract.
fn extract_into(zip_bytes: &[u8], dest: &Path) -> Result<(), String> {
    let reader = io::Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(reader).map_err(|e| format!("open zip: {e}"))?;

    // Pre-scan for an optional single-root unwrap.
    let strip_prefix = detect_single_root(&mut archive)?;

    let mut total_bytes: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("entry {i}: {e}"))?;
        let Some(raw_path) = entry.enclosed_name() else {
            return Err(format!(
                "rejected zip entry (suspicious path): {}",
                entry.name()
            ));
        };

        let rel: PathBuf = match strip_prefix.as_deref() {
            Some(prefix) => match raw_path.strip_prefix(prefix) {
                Ok(p) => {
                    if p.as_os_str().is_empty() {
                        continue;
                    }
                    p.to_path_buf()
                }
                Err(_) => raw_path.clone(),
            },
            None => raw_path.clone(),
        };
        if rel.as_os_str().is_empty() {
            continue;
        }

        let target = dest.join(&rel);
        // Re-check that the target stays under `dest`. Defence in depth;
        // `enclosed_name` already filters but the assert is cheap.
        if !target.starts_with(dest) {
            return Err(format!("zip entry escapes root: {}", rel.display()));
        }

        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| format!("mkdir {}: {e}", target.display()))?;
            continue;
        }

        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }

        let entry_size = entry.size();
        if entry_size > MAX_FILE_BYTES {
            return Err(format!(
                "zip entry too large: {} ({} bytes, cap {})",
                rel.display(),
                entry_size,
                MAX_FILE_BYTES
            ));
        }
        total_bytes = total_bytes.saturating_add(entry_size);
        if total_bytes > MAX_INSTALL_BYTES {
            return Err(format!(
                "uncompressed size exceeds cap ({} bytes)",
                MAX_INSTALL_BYTES
            ));
        }

        let mut out = fs::File::create(&target)
            .map_err(|e| format!("create {}: {e}", target.display()))?;
        let mut buf = Vec::with_capacity(entry_size as usize);
        // Cap copy so a malicious zip header that claims a small size cannot
        // stream more bytes. `take` enforces the cap on the decompressor side.
        let mut limited = entry.by_ref().take(MAX_FILE_BYTES + 1);
        limited
            .read_to_end(&mut buf)
            .map_err(|e| format!("read entry {}: {e}", rel.display()))?;
        if buf.len() as u64 > MAX_FILE_BYTES {
            return Err(format!(
                "zip entry exceeded declared size: {}",
                rel.display()
            ));
        }
        io::Write::write_all(&mut out, &buf)
            .map_err(|e| format!("write {}: {e}", target.display()))?;
    }
    Ok(())
}

/// Return the shared first path segment if every non-empty entry begins with
/// it and `<segment>/manifest.json` is in the archive. Lets GitHub-style
/// `repo-<sha>/...` archives flatten cleanly.
fn detect_single_root(archive: &mut ZipArchive<io::Cursor<&[u8]>>) -> Result<Option<String>, String> {
    let mut candidate: Option<String> = None;
    let mut saw_nested_manifest = false;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("entry {i}: {e}"))?;
        let Some(p) = entry.enclosed_name() else {
            continue;
        };
        let s = p.to_string_lossy().replace('\\', "/");
        if s.is_empty() {
            continue;
        }
        if s == "manifest.json" {
            return Ok(None);
        }
        let first = s.split('/').next().unwrap_or("");
        if first.is_empty() {
            continue;
        }
        if s == format!("{first}/manifest.json") {
            saw_nested_manifest = true;
        }
        match &candidate {
            Some(existing) if existing != first => return Ok(None),
            None => candidate = Some(first.to_string()),
            _ => {}
        }
    }
    if !saw_nested_manifest {
        return Ok(None);
    }
    Ok(candidate)
}

fn resolve_inside_root(root: &Path, rel: &str) -> Option<PathBuf> {
    // Reject absolute or parent-traversal inputs.
    if rel.contains("..") || rel.starts_with('/') || rel.starts_with('\\') {
        return None;
    }
    let joined = root.join(rel);
    if joined.starts_with(root) {
        Some(joined)
    } else {
        None
    }
}

/// Stable fingerprint of an extension directory. Sorts (rel-path,
/// sha256(file)) pairs, then hashes them. Independent of timestamps.
fn hash_dir(root: &Path) -> Result<String, String> {
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    walk(root, root, &mut entries)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    let mut top = Sha256::new();
    for (rel, hash) in &entries {
        top.update(rel.as_bytes());
        top.update([0u8]);
        top.update(hash);
        top.update([0u8]);
    }
    Ok(hex::encode(top.finalize()))
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) -> Result<(), String> {
    let read = fs::read_dir(dir).map_err(|e| format!("walk {}: {e}", dir.display()))?;
    for entry in read {
        let entry = entry.map_err(|e| format!("walk entry: {e}"))?;
        let path = entry.path();
        let meta = entry
            .metadata()
            .map_err(|e| format!("stat {}: {e}", path.display()))?;
        if meta.is_dir() {
            walk(root, &path, out)?;
        } else {
            let rel = path
                .strip_prefix(root)
                .map_err(|_| "walk produced path outside root".to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            let bytes = fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
            let mut h = Sha256::new();
            h.update(&bytes);
            out.push((rel, h.finalize().to_vec()));
        }
    }
    Ok(())
}

pub fn resolve_asset(root: &Path, rel: &str) -> Result<PathBuf, String> {
    resolve_inside_root(root, rel)
        .ok_or_else(|| format!("asset path escapes extension root: {rel}"))
}

/// Windows: remove the `Zone.Identifier` NTFS alternate data stream from
/// every file under `root`. Same effect as PowerShell's `Unblock-File`; lets
/// SmartScreen / Defender run a bundled binary instead of silently refusing
/// to launch via shell_bg_spawn.
///
/// Strips via `DeleteFileW` on the `<path>:Zone.Identifier` stream name.
/// `ERROR_FILE_NOT_FOUND` is fine; only real errors surface.
#[cfg(target_os = "windows")]
fn strip_motw_from_tree(root: &Path) -> Result<(), String> {
    let entries = fs::read_dir(root)
        .map_err(|e| format!("read {}: {e}", root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        let meta = entry
            .metadata()
            .map_err(|e| format!("stat {}: {e}", path.display()))?;
        if meta.is_dir() {
            strip_motw_from_tree(&path)?;
        } else {
            strip_motw_from_file(&path);
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn strip_motw_from_file(path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::DeleteFileW;

    let mut stream_path = path.as_os_str().to_os_string();
    stream_path.push(":Zone.Identifier");
    let wide: Vec<u16> = stream_path
        .encode_wide()
        .chain(std::iter::once(0u16))
        .collect();
    // SAFETY: `wide` is a null-terminated UTF-16 buffer that lives for the
    // call. DeleteFileW only reads it.
    unsafe {
        let _ = DeleteFileW(wide.as_ptr());
    }
}

/// Recursive `chmod 0o755` of every file under `sidecar_root`. Run after
/// install so extensions that ship a native sidecar binary do not require
/// each user to `chmod +x` by hand. Directories keep their default mode
/// (`fs::create_dir_all` already gives 0o755).
#[cfg(unix)]
fn make_sidecar_executable(sidecar_root: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let entries = fs::read_dir(sidecar_root)
        .map_err(|e| format!("read {}: {e}", sidecar_root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        let meta = entry
            .metadata()
            .map_err(|e| format!("stat {}: {e}", path.display()))?;
        if meta.is_dir() {
            make_sidecar_executable(&path)?;
        } else {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("chmod {}: {e}", path.display()))?;
        }
    }
    Ok(())
}

/// Read-only inspection of a zip. Same single-root unwrap and size caps as
/// the install pipeline, but never writes to disk. Used by the install
/// dialog to render icon and manifest preview before the user confirms.
pub fn peek_bytes(zip_bytes: &[u8], source: &str) -> Result<PeekResult, String> {
    if zip_bytes.len() as u64 > MAX_INSTALL_BYTES {
        return Err(format!(
            "extension package too large ({} bytes, cap {} bytes)",
            zip_bytes.len(),
            MAX_INSTALL_BYTES
        ));
    }
    let reader = io::Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(reader).map_err(|e| format!("open zip: {e}"))?;
    let strip_prefix = detect_single_root(&mut archive)?;

    let manifest_text = read_entry(&mut archive, strip_prefix.as_deref(), "manifest.json")?
        .ok_or_else(|| "manifest.json missing from package root".to_string())?;
    let manifest_text = String::from_utf8(manifest_text)
        .map_err(|e| format!("manifest.json is not valid UTF-8: {e}"))?;
    let manifest = Manifest::parse(&manifest_text)?;

    // Best-effort icon read. A missing or broken icon is not fatal; the
    // dialog falls back to the letter avatar.
    let (icon_base64, icon_rel_path) = match manifest.icon.as_deref() {
        Some(icon_rel) if !icon_rel.is_empty() => {
            match read_entry(&mut archive, strip_prefix.as_deref(), icon_rel) {
                Ok(Some(bytes)) => (
                    Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
                    Some(icon_rel.to_string()),
                ),
                _ => (None, None),
            }
        }
        _ => (None, None),
    };

    Ok(PeekResult {
        manifest,
        icon_base64,
        icon_rel_path,
        source: source.to_string(),
    })
}

/// Read one logical entry from the archive by relative path. Accounts for
/// an optional single-root prefix the same way `extract_into` does. Returns
/// `Ok(None)` when the entry is missing. Per-entry size capped at
/// `MAX_FILE_BYTES`.
fn read_entry(
    archive: &mut ZipArchive<io::Cursor<&[u8]>>,
    strip_prefix: Option<&str>,
    target_rel: &str,
) -> Result<Option<Vec<u8>>, String> {
    use std::io::Read;

    let needle = match strip_prefix {
        Some(prefix) => format!("{prefix}/{target_rel}"),
        None => target_rel.to_string(),
    };
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("entry {i}: {e}"))?;
        let Some(raw_path) = entry.enclosed_name() else {
            continue;
        };
        let path_str = raw_path.to_string_lossy().replace('\\', "/");
        if path_str != needle {
            continue;
        }
        let entry_size = entry.size();
        if entry_size > MAX_FILE_BYTES {
            return Err(format!(
                "zip entry too large: {} ({} bytes, cap {})",
                path_str, entry_size, MAX_FILE_BYTES
            ));
        }
        let mut buf = Vec::with_capacity(entry_size as usize);
        let mut limited = entry.by_ref().take(MAX_FILE_BYTES + 1);
        limited
            .read_to_end(&mut buf)
            .map_err(|e| format!("read entry {}: {e}", path_str))?;
        if buf.len() as u64 > MAX_FILE_BYTES {
            return Err(format!("zip entry exceeded declared size: {}", path_str));
        }
        return Ok(Some(buf));
    }
    Ok(None)
}
