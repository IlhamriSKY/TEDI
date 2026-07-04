//! Tauri commands for the frontend: thin wrappers around `install`/`state`
//! plus list/enable/disable/uninstall.
//!
//! Extensions live at `<app_data_dir>/extensions/<id>/`, state at
//! `<app_data_dir>/extensions/state.json`. Root resolved once via
//! `tauri::AppHandle::path()`; missing dirs are created on first call.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::Manager;

use super::github::{
    http_get_bytes, normalize_owner_repo, raw_content_bytes, resolve_latest_release,
    resolve_latest_tag, MAX_DOWNLOAD_BYTES,
};
use super::install::{install_from_bytes, resolve_asset, PeekResult};
use super::manifest::Manifest;
use super::state::{load as load_state, save as save_state, ExtensionEntry, ExtensionsStateFile};
use super::version::{compare_versions, strip_v_prefix};

/// Per-app singleton holding a write-lock so concurrent install/uninstall
/// calls do not race on the state file.
#[derive(Default)]
pub struct ExtensionsState {
    write_lock: Mutex<()>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ListEntry {
    pub id: String,
    pub manifest: Manifest,
    pub enabled: bool,
    pub source: String,
    pub installed_at_ms: i64,
    pub version: String,
    pub fingerprint: String,
    pub approved_permissions: Vec<String>,
    /// Absolute path to the extension root. Frontend turns this into a
    /// `convertFileSrc` URL for dynamic `import()`.
    pub root: String,
    /// Last upstream version observed by `ext_check_update`. `None` until
    /// the user runs a check on a GitHub-sourced extension.
    pub latest_version: Option<String>,
    pub last_checked_at_ms: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct UpdateCheckResult {
    pub id: String,
    pub current_version: String,
    pub latest_version: Option<String>,
    /// `true` when `latest_version` is strictly newer than `current_version`.
    pub has_update: bool,
    pub last_checked_at_ms: i64,
    /// Empty for non-github sources, which cannot be auto-checked.
    pub source: String,
}

fn extensions_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    root.push("extensions");
    if !root.exists() {
        fs::create_dir_all(&root).map_err(|e| format!("mkdir extensions root: {e}"))?;
    }
    // Stale `.staging-<ts>` folders are left behind by crashes mid-install.
    // List code filters them out, but they take disk forever. Sweep any
    // older than ~10 minutes on every list call so the directory self-heals.
    sweep_stale_staging(&root);
    Ok(root)
}

fn sweep_stale_staging(root: &Path) {
    use super::state::now_ms;
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let now = now_ms();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        // `.staging-<ts>`: install crashed mid-extract.
        // `.trash-<id>-<ts>`: update could not delete the previous copy
        // (sidecar still holding a file open). Both safe to sweep after
        // 10 minutes.
        let ts_str = if let Some(s) = name_str.strip_prefix(".staging-") {
            s
        } else if let Some(s) = name_str.strip_prefix(".trash-") {
            // Format: `.trash-<id>-<ts>`; take the trailing segment.
            s.rsplit_once('-').map(|(_, t)| t).unwrap_or("")
        } else {
            continue;
        };
        let Ok(ts) = ts_str.parse::<i64>() else {
            continue;
        };
        if now.saturating_sub(ts) > 10 * 60 * 1000 {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(extensions_root(app)?.join("state.json"))
}

/// Parse the manifest of an installed-extension subdirectory, or `None` if it
/// should be skipped: not a directory, a `.staging-`/`.trash-` leftover, or a
/// missing/unreadable/invalid `manifest.json`. Shared by the GUI `ext_list`
/// and the CLI installed-extension scan.
pub(crate) fn read_installed_manifest(path: &Path) -> Option<Manifest> {
    if !path.is_dir() {
        return None;
    }
    // Skip staging/trash dirs left behind on crash or replace. Swept by
    // `sweep_stale_staging`; not real extensions.
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.starts_with(".staging-") || name.starts_with(".trash-") {
        return None;
    }
    let manifest_path = path.join("manifest.json");
    if !manifest_path.exists() {
        return None;
    }
    let text = fs::read_to_string(&manifest_path).ok()?;
    Manifest::parse(&text).ok()
}

#[tauri::command]
pub async fn ext_list(app: tauri::AppHandle) -> Result<Vec<ListEntry>, String> {
    let root = extensions_root(&app)?;
    let state = load_state(&state_path(&app)?);
    let mut out: Vec<ListEntry> = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| format!("read root: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        let Some(manifest) = read_installed_manifest(&path) else {
            continue;
        };
        let st = state.entries.get(&manifest.id);
        out.push(ListEntry {
            id: manifest.id.clone(),
            enabled: st.map(|s| s.enabled).unwrap_or(true),
            source: st
                .map(|s| s.source.clone())
                .unwrap_or_else(|| "local".into()),
            installed_at_ms: st.map(|s| s.installed_at_ms).unwrap_or(0),
            version: st
                .map(|s| s.version.clone())
                .unwrap_or_else(|| manifest.version.clone()),
            fingerprint: st.map(|s| s.fingerprint.clone()).unwrap_or_default(),
            approved_permissions: st
                .map(|s| s.approved_permissions.clone())
                .unwrap_or_else(|| manifest.permissions.clone()),
            root: path.to_string_lossy().to_string(),
            latest_version: st.and_then(|s| s.latest_version.clone()),
            last_checked_at_ms: st.and_then(|s| s.last_checked_at_ms),
            manifest,
        });
    }
    out.sort_by(|a, b| a.manifest.name.cmp(&b.manifest.name));
    Ok(out)
}

#[tauri::command]
pub async fn ext_read_manifest(app: tauri::AppHandle, id: String) -> Result<Manifest, String> {
    super::manifest::validate_id(&id)?;
    let root = extensions_root(&app)?;
    let manifest_path = root.join(&id).join("manifest.json");
    let text = fs::read_to_string(&manifest_path).map_err(|e| format!("read manifest: {e}"))?;
    Manifest::parse(&text)
}

#[tauri::command]
pub async fn ext_read_asset(
    app: tauri::AppHandle,
    id: String,
    rel_path: String,
) -> Result<String, String> {
    super::manifest::validate_id(&id)?;
    let root = extensions_root(&app)?.join(&id);
    let target = resolve_asset(&root, &rel_path)?;
    fs::read_to_string(&target).map_err(|e| format!("read asset {rel_path}: {e}"))
}

/// Binary sibling of [`ext_read_asset`] returning base64-encoded bytes.
/// Used by the frontend to render manifest-declared icons as `data:` URLs.
/// Path-traversal protection via `resolve_asset`; rel paths with `..` or
/// absolute paths are refused. Soft 5 MiB cap keeps an oversized icon from
/// blowing the IPC string.
#[tauri::command]
pub async fn ext_read_asset_bytes(
    app: tauri::AppHandle,
    id: String,
    rel_path: String,
) -> Result<String, String> {
    use base64::Engine as _;
    super::manifest::validate_id(&id)?;
    let root = extensions_root(&app)?.join(&id);
    let target = resolve_asset(&root, &rel_path)?;
    let meta = fs::metadata(&target).map_err(|e| format!("stat asset {rel_path}: {e}"))?;
    const MAX_ASSET_BYTES: u64 = 5 * 1024 * 1024;
    if meta.len() > MAX_ASSET_BYTES {
        return Err(format!(
            "asset {rel_path} too large for IPC ({} bytes, cap {})",
            meta.len(),
            MAX_ASSET_BYTES
        ));
    }
    let bytes = fs::read(&target).map_err(|e| format!("read asset {rel_path}: {e}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

#[tauri::command]
pub async fn ext_install_from_zip(
    state: tauri::State<'_, ExtensionsState>,
    app: tauri::AppHandle,
    zip_path: String,
    // Permissions the user approved in the review dialog. The install refuses
    // if the package's actual manifest requests anything outside this set, so
    // the dialog's consent is an authoritative upper bound. `None` (e.g. a
    // caller that never showed a dialog) skips the check.
    approved_permissions: Option<Vec<String>>,
) -> Result<ListEntry, String> {
    // Stat first so accidentally pointing at a multi-GB ISO does not OOM
    // the install path; `fs::read` would otherwise allocate the whole file
    // before the cap fires.
    let meta = fs::metadata(&zip_path).map_err(|e| format!("stat {zip_path}: {e}"))?;
    if meta.len() > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "extension file too large: {} bytes (cap {})",
            meta.len(),
            MAX_DOWNLOAD_BYTES
        ));
    }
    let bytes = fs::read(&zip_path).map_err(|e| format!("read {zip_path}: {e}"))?;
    install_and_return(
        state,
        &app,
        &bytes,
        &format!("local:{zip_path}"),
        approved_permissions,
    )
    .await
}

#[tauri::command]
pub async fn ext_peek_zip(zip_path: String) -> Result<PeekResult, String> {
    let meta = fs::metadata(&zip_path).map_err(|e| format!("stat {zip_path}: {e}"))?;
    if meta.len() > MAX_DOWNLOAD_BYTES {
        return Err(format!(
            "extension file too large: {} bytes (cap {})",
            meta.len(),
            MAX_DOWNLOAD_BYTES
        ));
    }
    let bytes = fs::read(&zip_path).map_err(|e| format!("read {zip_path}: {e}"))?;
    super::install::peek_bytes(&bytes, &format!("local:{zip_path}"))
}

/// Per-file caps for the lightweight (raw-content) peek path. A manifest is
/// ~1 KiB; an icon is normally well under a MiB. Generous ceilings keep a
/// hostile host from streaming an unbounded body while letting real packages
/// through; an oversized icon just falls back to the letter avatar.
const MAX_PEEK_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_PEEK_ICON_BYTES: u64 = 5 * 1024 * 1024;

#[tauri::command]
pub async fn ext_peek_github(repo: String) -> Result<PeekResult, String> {
    let normalized = normalize_owner_repo(&repo)?;

    // Resolve only the release *tag* first - cheap, no asset download.
    let tag = resolve_latest_tag(&normalized).await?;

    // Fast path: read `manifest.json` (and the icon) straight from the repo
    // tree at the release tag via raw.githubusercontent.com. The review dialog
    // only needs the manifest + icon; downloading the entire release zip -
    // which bundles per-platform sidecar binaries and is routinely tens of MB
    // - merely to render a preview is what left the "Install" button sitting
    // on a spinner for a long time (and, with the post-confirm install
    // re-downloading the same zip, made "Update" stall on a slow link). The
    // preview is advisory (the dialog says as much); the real install below
    // re-validates the actual zip and is what grants permissions. Falls back
    // to a full download when the manifest is not at the repo root (404) or
    // raw content is unreachable.
    if let Ok(peek) = peek_github_via_raw(&normalized, &tag).await {
        return Ok(peek);
    }

    // Fallback: download the release asset and read the manifest from inside.
    let (_tag, asset_url) = resolve_latest_release(&normalized).await?;
    let bytes = http_get_bytes(&asset_url).await?;
    super::install::peek_bytes(&bytes, &format!("github:{normalized}"))
}

/// Build a [`PeekResult`] by reading `manifest.json` (and the manifest's
/// declared icon) directly from `raw.githubusercontent.com` at `tag`, without
/// downloading the release zip. Errors when the manifest is absent at the repo
/// root or unparseable, so the caller can fall back to the full-zip peek.
async fn peek_github_via_raw(owner_repo: &str, tag: &str) -> Result<PeekResult, String> {
    use base64::Engine as _;

    // Git refs are already constrained (no spaces, no `..`), but bail to the
    // full-zip fallback rather than splice an unexpected character straight
    // into a raw.githubusercontent.com path. The fallback reads the real zip
    // and works regardless of how the tag is shaped.
    if !is_simple_git_ref(tag) {
        return Err("release tag is not a simple ref".into());
    }

    let manifest_bytes =
        raw_content_bytes(owner_repo, tag, "manifest.json", MAX_PEEK_MANIFEST_BYTES).await?;
    let manifest_text = String::from_utf8(manifest_bytes)
        .map_err(|e| format!("manifest.json is not valid UTF-8: {e}"))?;
    let manifest = Manifest::parse(&manifest_text)?;

    // Best-effort icon. A miss just yields the letter-avatar fallback in the
    // dialog, the same as the full-zip peek path.
    let (icon_base64, icon_rel_path) = match manifest.icon.as_deref() {
        Some(icon_rel) if !icon_rel.is_empty() => {
            match raw_content_bytes(owner_repo, tag, icon_rel, MAX_PEEK_ICON_BYTES).await {
                Ok(bytes) => (
                    Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
                    Some(icon_rel.to_string()),
                ),
                Err(_) => (None, None),
            }
        }
        _ => (None, None),
    };

    Ok(PeekResult {
        manifest,
        icon_base64,
        icon_rel_path,
        source: format!("github:{owner_repo}"),
    })
}

/// Conservative check that a tag is safe to splice into a raw-content URL
/// path segment. On reject the caller falls back to the full-zip peek.
fn is_simple_git_ref(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/'))
}

#[tauri::command]
pub async fn ext_install_from_github(
    state: tauri::State<'_, ExtensionsState>,
    app: tauri::AppHandle,
    repo: String,
    // See `ext_install_from_zip`. For an update with no newly-requested
    // permissions (the dialog was skipped), the caller passes the extension's
    // already-approved set, so a release zip cannot silently widen the grant.
    approved_permissions: Option<Vec<String>>,
) -> Result<ListEntry, String> {
    // Accept "owner/repo" or a full URL like "https://github.com/owner/repo".
    let normalized = normalize_owner_repo(&repo)?;
    let (_tag, asset_url) = resolve_latest_release(&normalized).await?;
    let bytes = http_get_bytes(&asset_url).await?;
    install_and_return(
        state,
        &app,
        &bytes,
        &format!("github:{normalized}"),
        approved_permissions,
    )
    .await
}

async fn install_and_return(
    state: tauri::State<'_, ExtensionsState>,
    app: &tauri::AppHandle,
    zip_bytes: &[u8],
    source: &str,
    approved_permissions: Option<Vec<String>>,
) -> Result<ListEntry, String> {
    // Authoritative consent gate. The install-review dialog's manifest preview
    // may be read from raw.githubusercontent.com (so the "Install" button
    // appears without downloading the whole release zip). The bytes installed
    // here are the real release asset; re-read its manifest and refuse if it
    // requests any permission the user did not approve in the dialog. Without
    // this, a release whose packaged manifest declares more permissions than
    // its source tree could silently widen an extension's grant on update.
    if let Some(approved) = approved_permissions.as_deref() {
        let preview = super::install::peek_bytes(zip_bytes, source)?;
        let unapproved: Vec<&str> = preview
            .manifest
            .permissions
            .iter()
            .filter(|p| !approved.iter().any(|a| a == *p))
            .map(|p| p.as_str())
            .collect();
        if !unapproved.is_empty() {
            return Err(format!(
                "This package requests {} permission(s) you didn't approve: {}. \
                 The published package may differ from what the review dialog \
                 showed; re-open the install dialog to review and approve them.",
                unapproved.len(),
                unapproved.join(", ")
            ));
        }
    }

    // Lock around install so two concurrent calls do not trample the state
    // file. Held only across the install body; dropped before returning.
    let _g = state
        .write_lock
        .lock()
        .map_err(|_| "extensions state lock poisoned".to_string())?;
    let root = extensions_root(app)?;
    let st_path = state_path(app)?;
    let outcome = install_from_bytes(&root, &st_path, zip_bytes, source)?;
    let dest = root.join(&outcome.manifest.id);
    Ok(ListEntry {
        id: outcome.manifest.id.clone(),
        enabled: outcome.entry.enabled,
        source: outcome.entry.source.clone(),
        installed_at_ms: outcome.entry.installed_at_ms,
        version: outcome.entry.version.clone(),
        fingerprint: outcome.entry.fingerprint.clone(),
        approved_permissions: outcome.entry.approved_permissions.clone(),
        root: dest.to_string_lossy().to_string(),
        latest_version: outcome.entry.latest_version.clone(),
        last_checked_at_ms: outcome.entry.last_checked_at_ms,
        manifest: outcome.manifest,
    })
}

/// Hit the GitHub release feed for an installed extension and record the
/// latest version plus whether it is strictly newer. Only works for sources
/// shaped `github:<owner>/<repo>`; local zip installs return early with
/// `has_update=false` and no latest version.
///
/// The result is persisted so the UI can show the badge across restarts
/// without re-checking.
#[tauri::command]
pub async fn ext_check_update(
    state: tauri::State<'_, ExtensionsState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<UpdateCheckResult, String> {
    super::manifest::validate_id(&id)?;
    // Snapshot the entry under the lock, then drop before the network call.
    // Re-acquire below to persist. Without the split, unrelated install/
    // uninstall would have to wait for the GitHub round-trip.
    let (current_version, source) = {
        let _g = state
            .write_lock
            .lock()
            .map_err(|_| "extensions state lock poisoned".to_string())?;
        let st = super::state::load(&state_path(&app)?);
        let entry = st
            .entries
            .get(&id)
            .ok_or_else(|| format!("extension not installed: {id}"))?;
        (entry.version.clone(), entry.source.clone())
    };

    let owner_repo = match source.strip_prefix("github:") {
        Some(s) => s.to_string(),
        None => {
            // Non-github source: report "no update info" but bump the
            // last-checked timestamp so the UI stops nagging.
            let now = super::state::now_ms();
            let _g = state
                .write_lock
                .lock()
                .map_err(|_| "extensions state lock poisoned".to_string())?;
            let st_path = state_path(&app)?;
            let mut st = super::state::load(&st_path);
            if let Some(entry) = st.entries.get_mut(&id) {
                entry.last_checked_at_ms = Some(now);
                super::state::save(&st_path, &st)?;
            }
            return Ok(UpdateCheckResult {
                id,
                current_version,
                latest_version: None,
                has_update: false,
                last_checked_at_ms: now,
                source,
            });
        }
    };

    let latest_raw = resolve_latest_tag(&owner_repo).await?;
    let latest_clean = strip_v_prefix(&latest_raw);
    let has_update = compare_versions(&current_version, &latest_clean) == std::cmp::Ordering::Less;
    let now = super::state::now_ms();

    // Re-acquire the lock just to persist the result.
    {
        let _g = state
            .write_lock
            .lock()
            .map_err(|_| "extensions state lock poisoned".to_string())?;
        let st_path = state_path(&app)?;
        let mut st = super::state::load(&st_path);
        if let Some(entry) = st.entries.get_mut(&id) {
            entry.latest_version = Some(latest_clean.clone());
            entry.last_checked_at_ms = Some(now);
            super::state::save(&st_path, &st)?;
        }
    }

    Ok(UpdateCheckResult {
        id,
        current_version,
        latest_version: Some(latest_clean),
        has_update,
        last_checked_at_ms: now,
        source,
    })
}

#[tauri::command]
pub async fn ext_enable(
    state: tauri::State<'_, ExtensionsState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    set_enabled(state, app, id, true).await
}

#[tauri::command]
pub async fn ext_disable(
    state: tauri::State<'_, ExtensionsState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    set_enabled(state, app, id, false).await
}

async fn set_enabled(
    state: tauri::State<'_, ExtensionsState>,
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    super::manifest::validate_id(&id)?;
    let _g = state
        .write_lock
        .lock()
        .map_err(|_| "extensions state lock poisoned".to_string())?;
    let st_path = state_path(&app)?;
    let mut st = load_state(&st_path);
    let entry = st
        .entries
        .entry(id.clone())
        .or_insert_with(|| ExtensionEntry {
            enabled,
            source: "local".into(),
            installed_at_ms: super::state::now_ms(),
            version: String::new(),
            fingerprint: String::new(),
            approved_permissions: Vec::new(),
            latest_version: None,
            last_checked_at_ms: None,
        });
    entry.enabled = enabled;
    save_state(&st_path, &st)?;
    Ok(())
}

#[tauri::command]
pub async fn ext_uninstall(
    state: tauri::State<'_, ExtensionsState>,
    app: tauri::AppHandle,
    id: String,
) -> Result<(), String> {
    super::manifest::validate_id(&id)?;
    let _g = state
        .write_lock
        .lock()
        .map_err(|_| "extensions state lock poisoned".to_string())?;
    let root = extensions_root(&app)?;
    let dir = root.join(&id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove {id}: {e}"))?;
    }
    let st_path = state_path(&app)?;
    let mut st: ExtensionsStateFile = load_state(&st_path);
    st.entries.remove(&id);
    save_state(&st_path, &st)?;
    Ok(())
}

/// Default branch + HEAD commit SHA of a public repo, resolved off github.com's
/// git smart-HTTP (not the REST API), so it carries no 60 req/h rate limit. Used
/// by the skills installer's lightweight update check.
#[derive(Debug, Serialize, Clone)]
pub struct RepoHead {
    pub branch: String,
    pub sha: String,
}

#[tauri::command]
pub async fn github_head_sha(owner: String, repo: String) -> Result<RepoHead, String> {
    let owner_repo = super::github::normalize_owner_repo(&format!("{owner}/{repo}"))?;
    let (o, r) = owner_repo
        .split_once('/')
        .ok_or_else(|| "expected owner/repo".to_string())?;
    let (branch, sha) = super::github::resolve_head(o, r).await?;
    Ok(RepoHead { branch, sha })
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoTextFile {
    pub path: String,
    pub content: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct RepoTextFiles {
    pub branch: String,
    pub sha: String,
    pub files: Vec<RepoTextFile>,
}

/// Every small text file in a public repo, fetched via codeload (no REST API,
/// no 60 req/h cap, no token). The skills installer scans the returned set for
/// `SKILL.md` files and their bundled siblings, replacing the per-file GitHub
/// API + raw fetches it used to make.
#[tauri::command]
pub async fn github_repo_text_files(owner: String, repo: String) -> Result<RepoTextFiles, String> {
    let owner_repo = super::github::normalize_owner_repo(&format!("{owner}/{repo}"))?;
    let (o, r) = owner_repo
        .split_once('/')
        .ok_or_else(|| "expected owner/repo".to_string())?;
    let (branch, sha, files) = super::github::fetch_repo_text_files(o, r).await?;
    Ok(RepoTextFiles {
        branch,
        sha,
        files: files
            .into_iter()
            .map(|(path, content)| RepoTextFile { path, content })
            .collect(),
    })
}
