//! Persisted state: which extensions are installed/enabled, where they came
//! from, and when. Stored alongside the extensions folder so it survives a
//! single-extension uninstall.
//!
//! File: `<app_data_dir>/extensions/state.json`.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ExtensionsStateFile {
    #[serde(default)]
    pub entries: BTreeMap<String, ExtensionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtensionEntry {
    /// `true` = activate on next boot.
    pub enabled: bool,
    /// Origin recorded at install time. Two forms in this build:
    ///   - `local:<path>` (installed via `.zip` file picker)
    ///   - `github:<owner>/<repo>` (installed via GitHub release fetch)
    ///
    /// Only `github:` sources can be checked for updates automatically.
    pub source: String,
    /// `Date.now()`-style ms epoch.
    pub installed_at_ms: i64,
    /// Last-known manifest version. Refreshed on every install/update so the
    /// settings UI can decide whether to re-prompt for permissions.
    pub version: String,
    /// SHA-256 of the extension folder contents at install. Used as a stable
    /// fingerprint surfaced in the install-review dialog. Not a trust anchor.
    pub fingerprint: String,
    /// Permissions the user approved at install time. Permission set changes
    /// in a later version => re-prompt.
    #[serde(default)]
    pub approved_permissions: Vec<String>,
    /// Latest version observed on the upstream release feed. `None` until
    /// the user (or a future scheduled job) runs `ext_check_update`.
    /// Surfaced as an "Update available" badge in Settings -> Extensions
    /// when it's strictly greater than `version` (semver-ish compare).
    #[serde(default)]
    pub latest_version: Option<String>,
    /// `Date.now()`-style ms epoch of the most recent successful update check.
    /// Lets the UI grey-out the button briefly and show "checked X ago".
    #[serde(default)]
    pub last_checked_at_ms: Option<i64>,
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn load(state_path: &Path) -> ExtensionsStateFile {
    let Ok(bytes) = fs::read(state_path) else {
        return ExtensionsStateFile::default();
    };
    serde_json::from_slice(&bytes).unwrap_or_default()
}

pub fn save(state_path: &Path, state: &ExtensionsStateFile) -> Result<(), String> {
    if let Some(parent) = state_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir state: {e}"))?;
    }
    let body = serde_json::to_vec_pretty(state).map_err(|e| format!("ser state: {e}"))?;
    // Write-and-rename so a crash mid-write can't leave a partially
    // truncated state.json behind. `load()` falls back to defaults on
    // parse failure, which means a torn write would silently wipe every
    // user's enabled flags - worth the extra syscall to avoid.
    let tmp = state_path.with_extension("json.tmp");
    fs::write(&tmp, body).map_err(|e| format!("write state tmp: {e}"))?;
    fs::rename(&tmp, state_path).map_err(|e| {
        // Best-effort cleanup; on Windows a leftover .tmp would just sit
        // next to state.json until the next save overwrites it.
        let _ = fs::remove_file(&tmp);
        format!("commit state: {e}")
    })?;
    Ok(())
}
