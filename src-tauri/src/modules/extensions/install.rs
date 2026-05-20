//! Install pipeline: read a .zip (from disk, bytes, or URL), validate it,
//! extract into `<extensions_dir>/<id>/` after wiping any existing folder
//! for that id, then write/update the persisted state entry.
//!
//! Security guards:
//!   - `enclosed_name()` rejects any zip entry that resolves outside the
//!     destination root. Symlinks created by zip entries are not honoured -
//!     `zip` crate writes them as data files unless explicitly enabled.
//!   - Total uncompressed size capped at `MAX_INSTALL_BYTES` to defeat
//!     decompression bombs.
//!   - Per-entry size capped at `MAX_FILE_BYTES`.
//!   - Manifest is parsed *before* committing the new folder so a malformed
//!     drop never replaces a known-good install.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use super::commands::PeekResult;
use super::manifest::Manifest;
use super::state::{now_ms, save as save_state, ExtensionEntry};

/// 50 MiB - generous for a JS bundle + theme assets, snug enough that a
/// runaway/garbage archive doesn't fill the user's disk before we notice.
const MAX_INSTALL_BYTES: u64 = 50 * 1024 * 1024;
/// 10 MiB per file - a single inlined font is normally <500 KiB; a single
/// asset above this is suspicious for the kinds of extensions we expect.
const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;

pub struct InstallOutcome {
    pub manifest: Manifest,
    pub entry: ExtensionEntry,
    /// `true` when the installed id replaced an existing entry. The UI
    /// uses this to decide whether to surface "updated" vs "installed".
    /// Wired through to the frontend via the `replaced` field on the
    /// JSON returned by `ext_install_from_*` once the install UI grows
    /// a distinct "updated" toast.
    #[allow(dead_code)]
    pub replaced: bool,
}

/// Top-level pipeline. `source` is recorded verbatim in the state file.
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

    // Stage to a temp dir under the extensions root so the swap is atomic-ish.
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

    // Validate `main` if declared - rejecting here keeps a broken extension
    // out of the activation path.
    if let Some(main) = manifest.main.as_deref() {
        let resolved = resolve_inside_root(&staging, main)
            .ok_or_else(|| "manifest.main path escapes extension root".to_string())?;
        if !resolved.exists() {
            let _ = fs::remove_dir_all(&staging);
            return Err(format!("manifest.main not found in package: {main}"));
        }
    }

    // Commit: move staging to <root>/<id>. Replace any existing folder
    // for the same id; the user already approved the install/update.
    //
    // On Windows, a running sidecar binary inside the old folder
    // locks every file under it and turns `fs::remove_dir_all` into
    // "Access is denied (os error 5)". Renaming the *directory* is
    // allowed even when files inside are in use (NTFS tracks files
    // by handle, not path), so we rename the old install out of the
    // way and let a background thread delete the trash. The new
    // install can land at `dest` immediately. Stale `.trash-*` dirs
    // are reaped by `sweep_stale_staging` on the next list call.
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
                // Fallback: try direct remove (works on Linux/macOS
                // because Unix file handles survive unlink). On
                // Windows this is the original failure path - surface
                // both errors so the cause is clear.
                fs::remove_dir_all(&dest).map_err(|e| {
                    format!(
                        "remove old: {e} (rename also failed: {rename_err}). \
                         The extension's sidecar may still be holding files open - \
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

    // Unix only: extensions that ship a sidecar binary under `sidecar/`
    // need it executable. Zips can't carry POSIX mode bits reliably
    // across packagers, so we set 0o755 ourselves. Scoped to the
    // `sidecar/` subtree so we don't surprise authors by chmoding their
    // JS / JSON / asset files. No-op on Windows.
    #[cfg(unix)]
    {
        let sidecar_root = dest.join("sidecar");
        if sidecar_root.exists() {
            if let Err(err) = make_sidecar_executable(&sidecar_root) {
                // Best-effort: surface as a soft error in the log but
                // don't abort the install. The extension can still try
                // to spawn and report a clearer failure to the user.
                eprintln!("[extensions] chmod sidecar failed: {err}");
            }
        }
    }

    // Windows only: strip the Mark-of-the-Web alternate data stream
    // (`Zone.Identifier`) from every file under `sidecar/`. Tauri's
    // `reqwest`-based download attaches MOTW to anything we write,
    // which makes SmartScreen / Defender refuse to execute the binary
    // silently when an extension tries to launch it via shell_bg_spawn.
    // Same effect as PowerShell's `Unblock-File`, just done in Rust.
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
        // Install resets the "latest_version" hint - the new install IS
        // the latest the user has seen. The next manual update check
        // re-populates it.
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
/// via `enclosed_name()`. Some zips wrap their content in a single root
/// folder (e.g. GitHub release archives); we unwrap that automatically when
/// every entry shares the same first segment AND `manifest.json` sits at
/// `<segment>/manifest.json`.
fn extract_into(zip_bytes: &[u8], dest: &Path) -> Result<(), String> {
    let reader = io::Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(reader).map_err(|e| format!("open zip: {e}"))?;

    // Pre-scan for the optional single-root unwrap.
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
        // Re-check that the target stays under `dest` (defence in depth -
        // `enclosed_name` already filters but cheap to assert again).
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
        // Cap copy to prevent a malicious zip header from claiming a small
        // size but streaming more bytes. `take` enforces the same cap on the
        // decompressor side.
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

/// If every non-empty entry begins with the same first path segment and
/// `<segment>/manifest.json` is inside the archive, return that segment so
/// we can strip it during extraction (so GitHub-style `repo-<sha>/...`
/// archives flatten cleanly).
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
    // Reject absolute / parent-traversal inputs outright.
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

/// Stable fingerprint of an extension directory: sorted (rel-path, sha256(file))
/// pairs, then hashed. Independent of timestamp.
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

/// Windows: remove the `Zone.Identifier` NTFS alternate data stream
/// from every file under `root`. This is the on-disk equivalent of
/// PowerShell's `Unblock-File` and lets SmartScreen / Defender run an
/// extension's bundled binary without prompting (or, more commonly,
/// silently refusing to launch via shell_bg_spawn).
///
/// We strip via `DeleteFileW` on the `<path>:Zone.Identifier` stream
/// name. `ERROR_FILE_NOT_FOUND` is fine; only real errors are surfaced.
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
    // SAFETY: `wide` is a null-terminated UTF-16 buffer that lives for
    // the duration of the call; DeleteFileW only reads it.
    unsafe {
        let _ = DeleteFileW(wide.as_ptr());
    }
}

/// Recursive `chmod 0o755` of every file under `sidecar_root`. Used
/// post-install so extensions that ship a native sidecar binary don't
/// require each end user to `chmod +x` by hand. Directories keep their
/// default mode (`fs::create_dir_all` already gives them 0o755).
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

/// Read-only inspection of a zip. Same single-root unwrap + size caps as
/// the install pipeline, but never writes to disk. Used by the install
/// dialog to render icon + manifest preview before the user confirms.
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

    // Best-effort icon read. A missing/broken icon is not fatal: the
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

/// Read one logical entry from the archive by relative path, accounting
/// for an optional single-root prefix the same way `extract_into` does.
/// Returns `Ok(None)` when the entry doesn't exist. Per-entry size is
/// still capped at `MAX_FILE_BYTES`.
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
