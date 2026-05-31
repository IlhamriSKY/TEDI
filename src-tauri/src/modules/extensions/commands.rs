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

use super::install::{install_from_bytes, resolve_asset};
use super::manifest::Manifest;
use super::state::{load as load_state, save as save_state, ExtensionEntry, ExtensionsStateFile};

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

/// Read-only preview of an extension package. The pre-install dialog calls
/// `ext_peek_*` to populate icon, name, and permissions without writing the
/// package to disk. `ext_install_from_*` commits the install once the user
/// confirms.
#[derive(Debug, Serialize, Clone)]
pub struct PeekResult {
    pub manifest: Manifest,
    /// Base64-encoded icon bytes when the manifest declares `icon` and the
    /// file is present. Frontend builds a `data:` URL for the dialog `<img>`.
    pub icon_base64: Option<String>,
    pub icon_rel_path: Option<String>,
    /// Same shape as `ListEntry.source` (`local:<path>` or `github:<o/r>`).
    /// Echoed so the dialog can label where the install came from.
    pub source: String,
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

#[tauri::command]
pub async fn ext_list(app: tauri::AppHandle) -> Result<Vec<ListEntry>, String> {
    let root = extensions_root(&app)?;
    let state = load_state(&state_path(&app)?);
    let mut out: Vec<ListEntry> = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| format!("read root: {e}"))? {
        let entry = entry.map_err(|e| format!("entry: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // Skip staging/trash dirs left behind on crash or replace. Swept by
        // `sweep_stale_staging`; not real extensions.
        if path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.starts_with(".staging-") || n.starts_with(".trash-"))
            .unwrap_or(false)
        {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let manifest_text = match fs::read_to_string(&manifest_path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let Ok(manifest) = Manifest::parse(&manifest_text) else {
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

/// 50 MiB; mirrors `install::MAX_INSTALL_BYTES`. Duplicated so we can refuse
/// a giant local file before allocating its contents into memory.
const MAX_DOWNLOAD_BYTES: u64 = 50 * 1024 * 1024;

#[tauri::command]
pub async fn ext_install_from_zip(
    state: tauri::State<'_, ExtensionsState>,
    app: tauri::AppHandle,
    zip_path: String,
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
    install_and_return(state, &app, &bytes, &format!("local:{zip_path}")).await
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

#[tauri::command]
pub async fn ext_peek_github(repo: String) -> Result<PeekResult, String> {
    let normalized = normalize_owner_repo(&repo)?;
    let (_tag, asset_url) = resolve_latest_release(&normalized).await?;
    let bytes = http_get_bytes(&asset_url).await?;
    super::install::peek_bytes(&bytes, &format!("github:{normalized}"))
}

#[tauri::command]
pub async fn ext_install_from_github(
    state: tauri::State<'_, ExtensionsState>,
    app: tauri::AppHandle,
    repo: String,
) -> Result<ListEntry, String> {
    // Accept "owner/repo" or a full URL like "https://github.com/owner/repo".
    let normalized = normalize_owner_repo(&repo)?;
    let (_tag, asset_url) = resolve_latest_release(&normalized).await?;
    let bytes = http_get_bytes(&asset_url).await?;
    install_and_return(state, &app, &bytes, &format!("github:{normalized}")).await
}

async fn install_and_return(
    state: tauri::State<'_, ExtensionsState>,
    app: &tauri::AppHandle,
    zip_bytes: &[u8],
    source: &str,
) -> Result<ListEntry, String> {
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

pub(crate) fn strip_v_prefix(tag: &str) -> String {
    tag.trim_start_matches(['v', 'V']).to_string()
}

/// Lenient version compare. Splits both sides on any non-digit, parses each
/// segment as u32 (`0` on parse failure), and compares lexicographically.
/// Missing trailing segments count as `0`. Pre-release suffixes are ignored
/// beyond their digits: `1.0.0` and `1.0.0-beta` compare equal, which
/// avoids a false "update available" on the same major-minor-patch.
pub(crate) fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    fn parts(s: &str) -> Vec<u32> {
        s.split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    }
    let pa = parts(a);
    let pb = parts(b);
    let len = pa.len().max(pb.len()).max(1);
    for i in 0..len {
        let av = pa.get(i).copied().unwrap_or(0);
        let bv = pb.get(i).copied().unwrap_or(0);
        match av.cmp(&bv) {
            std::cmp::Ordering::Equal => continue,
            other => return other,
        }
    }
    std::cmp::Ordering::Equal
}

/// True iff `host` satisfies the `engines.tedi` constraint. Supports the
/// shapes extensions in this project actually use: empty / `*` (any),
/// `">=X.Y.Z"`, `">X.Y.Z"`, `"<=X.Y.Z"`, `"<X.Y.Z"`, `"=X.Y.Z"`, and plain
/// `"X.Y.Z"` (exact). Comparison uses [`compare_versions`] so `v` prefixes
/// and trailing pre-release tags behave the same way the rest of the host
/// already expects.
pub(crate) fn satisfies(constraint: &str, host: &str) -> bool {
    let c = constraint.trim();
    if c.is_empty() || c == "*" {
        return true;
    }
    let host = strip_v_prefix(host);
    let (op, rest) = if let Some(r) = c.strip_prefix(">=") {
        (">=", r)
    } else if let Some(r) = c.strip_prefix("<=") {
        ("<=", r)
    } else if let Some(r) = c.strip_prefix('>') {
        (">", r)
    } else if let Some(r) = c.strip_prefix('<') {
        ("<", r)
    } else if let Some(r) = c.strip_prefix('=') {
        ("=", r)
    } else {
        ("=", c)
    };
    let target = strip_v_prefix(rest.trim());
    let ord = compare_versions(&host, &target);
    match op {
        ">=" => ord != std::cmp::Ordering::Less,
        ">" => ord == std::cmp::Ordering::Greater,
        "<=" => ord != std::cmp::Ordering::Greater,
        "<" => ord == std::cmp::Ordering::Less,
        _ => ord == std::cmp::Ordering::Equal,
    }
}

pub(crate) fn pick_release_tag(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    v.get("tag_name")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
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

// ---------- HTTP helpers ----------

pub(crate) async fn http_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    http_get_bytes_with_progress(url, |_done, _total| {}).await
}

/// Streaming variant of [`http_get_bytes`] that reports cumulative bytes
/// received via `on_progress`. The closure runs on the network thread on
/// every chunk read - keep it cheap (typical implementation: send through
/// an `mpsc` channel). `bytes_total` is `Some(content_length)` when the
/// server advertised one, `None` otherwise.
pub(crate) async fn http_get_bytes_with_progress<F: FnMut(u64, Option<u64>)>(
    url: &str,
    mut on_progress: F,
) -> Result<Vec<u8>, String> {
    // `connect_timeout` fails fast on unreachable hosts so an offline user
    // gets an error in 15s instead of reqwest's default tens-of-seconds
    // stall. `timeout` caps the whole request: long enough for a 50 MiB
    // asset on a slow link, short enough that a stalled stream gives up.
    let client = reqwest::Client::builder()
        .user_agent("TEDI-Extensions/1.0")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut resp = client
        .get(url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GET {url}: HTTP {}", resp.status()));
    }
    // Trust an honest content-length first so we bail early when the server
    // advertises a multi-GB body. Servers that omit or lie still hit the
    // running-total check below.
    let total = resp.content_length();
    if let Some(len) = total {
        if len > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "download too large: {} bytes (cap {})",
                len, MAX_DOWNLOAD_BYTES
            ));
        }
    }
    // Initial tick lets the UI render "0 / N" before the first chunk lands.
    on_progress(0, total);
    // Stream chunks so a misreporting server cannot push past the cap.
    // Stop when the body ends or the running total tips over.
    let mut bytes = Vec::with_capacity(64 * 1024);
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read body: {e}"))? {
        if bytes.len() as u64 + chunk.len() as u64 > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "download exceeded cap mid-stream ({} bytes)",
                MAX_DOWNLOAD_BYTES
            ));
        }
        bytes.extend_from_slice(&chunk);
        on_progress(bytes.len() as u64, total);
    }
    Ok(bytes)
}

pub(crate) async fn http_get_text(url: &str) -> Result<String, String> {
    // Small JSON bodies, so a short total timeout is fine. Same connect cap
    // as `http_get_bytes` so a network outage surfaces consistently.
    let client = reqwest::Client::builder()
        .user_agent("TEDI-Extensions/1.0")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut req = client
        .get(url)
        .header("Accept", "application/vnd.github+json");
    // Optional auth: a personal access token in TEDI_GITHUB_TOKEN lifts the
    // anonymous 60 req/h cap to 5000 req/h. Read on every call so a user
    // can drop a token in without restarting TEDI. Only the api.github.com
    // host gets the header; arbitrary URLs do not, in case a redirect ever
    // points elsewhere.
    if url.contains("api.github.com") {
        if let Ok(tok) = std::env::var("TEDI_GITHUB_TOKEN") {
            let tok = tok.trim();
            if !tok.is_empty() {
                req = req.header("Authorization", format!("Bearer {tok}"));
            }
        }
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        // Surface rate-limit hits with an actionable hint. The raw JSON
        // body's message would otherwise be hidden inside a generic HTTP
        // 403 toast and the user would have no idea what to do.
        let body = resp.text().await.unwrap_or_default();
        if status == reqwest::StatusCode::FORBIDDEN
            && (body.contains("rate limit") || body.contains("API rate"))
        {
            return Err(
                "GitHub API rate limit reached (60 requests/hour for unauthenticated \
                 access). Set the TEDI_GITHUB_TOKEN environment variable to a personal \
                 access token to raise the cap to 5000 requests/hour, or wait until the \
                 limit window resets (typically within the hour)."
                    .to_string(),
            );
        }
        return Err(format!("GET {url}: HTTP {status}"));
    }
    // Cap the body so a compromised/MITM'd endpoint can't stream an unbounded
    // response into memory (the sibling byte path caps via MAX_DOWNLOAD_BYTES;
    // this text path previously buffered without limit). Manifests / release
    // JSON are tiny, so a few MiB is generous.
    const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
    if let Some(len) = resp.content_length() {
        if len as usize > MAX_TEXT_BYTES {
            return Err(format!("response body too large: {len} bytes (cap {MAX_TEXT_BYTES})"));
        }
    }
    let mut resp = resp;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read body: {e}"))? {
        if buf.len() + chunk.len() > MAX_TEXT_BYTES {
            return Err(format!("response body exceeds cap ({MAX_TEXT_BYTES} bytes)"));
        }
        buf.extend_from_slice(&chunk);
    }
    String::from_utf8(buf).map_err(|e| format!("response body not valid UTF-8: {e}"))
}

/// Resolve `(tag, zip_url)` for the latest release of `owner_repo`. Tries
/// the GitHub REST API first - richer metadata, but anonymous requests are
/// rate limited to 60/hour per IP - and falls back to two unauthenticated
/// public endpoints when the API returns 403 / rate-limited:
///
///   1. `GET https://github.com/<owner>/<repo>/releases/latest` (302 to
///      `.../releases/tag/<tag>`) gives the tag without needing the API.
///   2. `GET https://github.com/<owner>/<repo>/releases/expanded_assets/<tag>`
///      returns an HTML fragment (the same one the release page loads via
///      AJAX when "Assets" is expanded) listing every download link.
///
/// Both fallbacks are stable HTML/redirect surfaces - changes since 2020
/// have been backward compatible.
async fn resolve_latest_release(owner_repo: &str) -> Result<(String, String), String> {
    let api = format!("https://api.github.com/repos/{owner_repo}/releases/latest");
    match http_get_text(&api).await {
        Ok(json) => {
            let tag = pick_release_tag(&json)
                .ok_or_else(|| "could not read tag_name from GitHub response".to_string())?;
            let url = pick_release_zip(&json)
                .ok_or_else(|| "no .zip asset in latest release".to_string())?;
            return Ok((tag, url));
        }
        Err(e) if is_rate_limited_err(&e) => {
            // fall through to the unauthenticated path
        }
        Err(e) => return Err(e),
    }
    let tag = latest_tag_via_redirect(owner_repo).await?;
    let url = pick_zip_via_html(owner_repo, &tag).await?;
    Ok((tag, url))
}

/// Tag-only variant of [`resolve_latest_release`] for the update-check
/// path, which never downloads anything and so does not need the asset URL.
async fn resolve_latest_tag(owner_repo: &str) -> Result<String, String> {
    let api = format!("https://api.github.com/repos/{owner_repo}/releases/latest");
    match http_get_text(&api).await {
        Ok(json) => {
            return pick_release_tag(&json)
                .ok_or_else(|| "could not read tag_name from GitHub response".to_string());
        }
        Err(e) if is_rate_limited_err(&e) => {}
        Err(e) => return Err(e),
    }
    latest_tag_via_redirect(owner_repo).await
}

fn is_rate_limited_err(err: &str) -> bool {
    err.contains("rate limit") || err.contains("HTTP 403")
}

/// Discover the latest release tag by following GitHub's public 302 from
/// `/<owner>/<repo>/releases/latest` to `/<owner>/<repo>/releases/tag/<tag>`.
/// Redirects are disabled so we can read the `Location` header directly;
/// the path's final segment is the tag we want.
async fn latest_tag_via_redirect(owner_repo: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("TEDI-Extensions/1.0")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let url = format!("https://github.com/{owner_repo}/releases/latest");
    let resp = client
        .head(&url)
        .send()
        .await
        .map_err(|e| format!("HEAD {url}: {e}"))?;
    if !resp.status().is_redirection() {
        return Err(format!(
            "expected 302 from {url}, got HTTP {}",
            resp.status()
        ));
    }
    let loc = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "missing Location header on /releases/latest".to_string())?;
    let tag = loc
        .rsplit('/')
        .next()
        .filter(|t| !t.is_empty())
        .ok_or_else(|| format!("malformed Location header: {loc}"))?;
    Ok(tag.to_string())
}

/// Pick the first `.zip` download link from the `expanded_assets` HTML
/// fragment GitHub serves for a release. The fragment is stable enough
/// to scan with naive string ops: every asset is rendered as
/// `<a href="/owner/repo/releases/download/<tag>/<name>.zip">`. We split
/// on `"`, accept the first token shaped like a download path that ends
/// in `.zip` (case-insensitive). Matching ignores owner/repo case because
/// GitHub canonicalises the case in HTML even when the user typed it
/// differently.
async fn pick_zip_via_html(owner_repo: &str, tag: &str) -> Result<String, String> {
    let url = format!("https://github.com/{owner_repo}/releases/expanded_assets/{tag}");
    let client = reqwest::Client::builder()
        .user_agent("TEDI-Extensions/1.0")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("GET {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GET {url}: HTTP {}", resp.status()));
    }
    let html = resp.text().await.map_err(|e| format!("read body: {e}"))?;
    for tok in html.split('"') {
        if tok.starts_with('/')
            && tok.contains("/releases/download/")
            && tok.to_ascii_lowercase().ends_with(".zip")
        {
            return Ok(format!("https://github.com{tok}"));
        }
    }
    Err(format!("no .zip asset link in expanded_assets for {tag}"))
}

pub(crate) fn normalize_owner_repo(input: &str) -> Result<String, String> {
    let trimmed = input.trim().trim_end_matches('/');
    let candidate = if let Some(rest) = trimmed.strip_prefix("https://github.com/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("http://github.com/") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("github.com/") {
        rest
    } else {
        trimmed
    };
    // Drop a trailing `.git` if present.
    let candidate = candidate.trim_end_matches(".git");
    let parts: Vec<&str> = candidate.split('/').collect();
    if parts.len() < 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err("expected owner/repo format".into());
    }
    let owner = parts[0];
    let repo = parts[1];
    let safe = |s: &str| {
        s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !safe(owner) || !safe(repo) {
        return Err("owner/repo contains unsupported characters".into());
    }
    Ok(format!("{owner}/{repo}"))
}

/// Pick the first `.zip` asset from a GitHub release JSON.
pub(crate) fn pick_release_zip(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let assets = v.get("assets")?.as_array()?;
    for a in assets {
        let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("");
        if name.to_lowercase().ends_with(".zip") {
            if let Some(url) = a.get("browser_download_url").and_then(|x| x.as_str()) {
                return Some(url.to_string());
            }
        }
    }
    // Fall back to the source zipball (tagged commit) if no asset matches.
    v.get("zipball_url")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}
