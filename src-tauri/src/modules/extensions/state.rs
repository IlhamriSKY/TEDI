//! Persisted state: which extensions are installed/enabled, where they came
//! from, and when. Stored alongside the extensions folder so it survives a
//! per-extension uninstall.
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
    /// `true` activates on next boot.
    pub enabled: bool,
    /// Origin recorded at install time. Two forms:
    ///   - `local:<path>` (`.zip` file picker)
    ///   - `github:<owner>/<repo>` (GitHub release fetch)
    ///
    /// Only `github:` sources support automatic update checks.
    pub source: String,
    /// `Date.now()`-style ms epoch.
    pub installed_at_ms: i64,
    /// Last-known manifest version. Refreshed on every install/update so the
    /// settings UI can decide whether to re-prompt for permissions.
    pub version: String,
    /// SHA-256 of the extension folder contents at install. Stable fingerprint
    /// surfaced in the install-review dialog. Not a trust anchor.
    pub fingerprint: String,
    /// Permissions the user approved at install time. A changed permission
    /// set in a later version triggers a re-prompt.
    #[serde(default)]
    pub approved_permissions: Vec<String>,
    /// Latest version observed on the upstream release feed. `None` until
    /// the user runs `ext_check_update`. Surfaced as an "Update available"
    /// badge in Settings -> Extensions when strictly greater than `version`.
    #[serde(default)]
    pub latest_version: Option<String>,
    /// `Date.now()`-style ms epoch of the most recent successful check.
    /// Lets the UI grey out the button briefly and show "checked X ago".
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
    // Write-and-rename so a crash mid-write cannot leave a truncated
    // state.json behind. `load()` falls back to defaults on parse failure,
    // so a torn write would silently wipe every user's enabled flags; worth
    // the extra syscall to avoid.
    crate::modules::fs::atomic::atomic_write(state_path, &body)
        .map_err(|e| format!("commit state: {e}"))?;
    Ok(())
}
