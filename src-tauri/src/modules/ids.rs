//! Single source of truth for the app's bundle identifier and the
//! per-user data paths derived from it without an `AppHandle`.
//!
//! [`BUNDLE_ID`] MUST match the `identifier` field in `tauri.conf.json`
//! (and the `.dev` override in `tauri.dev.conf.json`). Tauri 2's
//! `app_data_dir` returns `<dirs::data_dir()>/<identifier>` on every desktop
//! platform, so the no-`AppHandle` callers here (the CLI surfaces and the
//! pty daemon, which boot before Tauri builds an `AppHandle`) reproduce the
//! same path. Debug builds use the `.dev` suffix so `pnpm tauri dev` reads
//! and writes a separate data dir from an installed release.

use std::path::PathBuf;

/// Bundle id from `tauri.conf.json`. Keep in sync with the `identifier`
/// field there. Debug builds switch to the `.dev` suffix so dev runs land
/// in a separate data dir from installed releases.
#[cfg(debug_assertions)]
pub const BUNDLE_ID: &str = "id.ilhamrisky.tedi.dev";
#[cfg(not(debug_assertions))]
pub const BUNDLE_ID: &str = "id.ilhamrisky.tedi";

/// Per-user app-data directory: `<dirs::data_dir()>/<BUNDLE_ID>`. `None`
/// only when the OS data dir cannot be resolved (very rare). Does NOT create
/// the directory.
pub fn app_data_dir() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join(BUNDLE_ID))
}

/// Extensions root: `<app_data_dir()>/extensions`. Does NOT create the
/// directory; callers that need it to exist run `create_dir_all` themselves.
pub fn extensions_root() -> Option<PathBuf> {
    app_data_dir().map(|d| d.join("extensions"))
}

/// The `tauri-plugin-store` settings file. Name it here, not per caller.
pub const SETTINGS_FILE: &str = "tedi-settings.json";

/// Where the settings file may be, in search order.
///
/// Both roots are CHECKED rather than picked. `tauri-plugin-store` resolves a
/// bare filename against the app CONFIG dir, which on Windows and macOS is the
/// same folder as the data dir but on Linux is not (`~/.config` vs
/// `~/.local/share`). A reader that assumes the data dir therefore finds
/// nothing on Linux, silently, and reports the setting as unset rather than as
/// unreadable - which is how "Additional PATH" and `tedi theme` both came to
/// read a file the GUI does not write there.
pub fn settings_candidates() -> Vec<PathBuf> {
    [dirs::config_dir(), dirs::data_dir()]
        .into_iter()
        .flatten()
        .map(|d| d.join(BUNDLE_ID).join(SETTINGS_FILE))
        .collect()
}

/// The settings file to READ, or `None` when neither candidate exists. Writers
/// want [`settings_write_target`] instead.
pub fn settings_file() -> Option<PathBuf> {
    settings_candidates().into_iter().find(|p| p.exists())
}

/// The settings file to WRITE. The existing one when there is one, so an edit
/// lands where the GUI reads; otherwise the config dir, which is where the
/// plugin would create it.
pub fn settings_write_target() -> Option<PathBuf> {
    settings_file().or_else(|| settings_candidates().into_iter().next())
}
