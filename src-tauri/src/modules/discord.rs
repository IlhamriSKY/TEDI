//! Discord Rich Presence integration.
//!
//! The frontend drives presence via three commands:
//!   - `discord_rpc_connect`: connects (or no-ops if already connected).
//!   - `discord_rpc_update`: pushes a new activity payload.
//!   - `discord_rpc_disconnect`: drops the client.
//!
//! All state lives behind a single Mutex inside `DiscordState`. The IPC
//! client is created lazily on the first `connect` call so a closed Discord
//! desktop app doesn't block app startup.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use discord_rich_presence::{
    activity::{Activity, Assets, Timestamps},
    DiscordIpc, DiscordIpcClient,
};
use serde::Deserialize;

/// Discord application ID owned by the TEDI project. Hard-coded - the
/// presence card art (large/small image keys) is uploaded against this ID
/// in the Discord Developer Portal, so swapping IDs would break icons.
const DISCORD_APP_ID: &str = "1506303762418110505";

/// Asset key for the large image. Must exist in the Developer Portal under
/// "Rich Presence → Art Assets". Falls back gracefully (no icon) if missing.
const LARGE_IMAGE_KEY: &str = "tedi_logo";
const LARGE_IMAGE_TEXT: &str = "TEDI - Terminal Environment & Development Infrastructure";

pub struct DiscordState {
    inner: Mutex<Option<DiscordIpcClient>>,
    /// Unix-ms timestamp captured on first successful connect. Used as the
    /// activity start time so the Discord card shows elapsed-since-launch
    /// rather than elapsed-since-last-update (which would reset on every
    /// workspace or file change).
    started_at_ms: Mutex<Option<i64>>,
}

impl Default for DiscordState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(None),
            started_at_ms: Mutex::new(None),
        }
    }
}

#[derive(Debug, Deserialize, Default)]
pub struct DiscordActivityPayload {
    /// Top line on the Discord card. Empty string clears the field.
    #[serde(default)]
    pub details: String,
    /// Second line on the Discord card. Empty string clears the field.
    #[serde(default)]
    pub state: String,
}

/// Recover from a poisoned mutex by taking the inner guard anyway. The
/// Discord state has no invariants beyond "the client exists or doesn't" -
/// dropping a half-initialized client on the next operation is fine, and
/// we'd rather keep working than refuse forever after one panic.
fn unpoison<'a, T>(
    result: Result<MutexGuard<'a, T>, PoisonError<MutexGuard<'a, T>>>,
) -> MutexGuard<'a, T> {
    result.unwrap_or_else(|p| p.into_inner())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Truncate a UTF-8 string to at most `max_chars` Unicode scalar values.
/// Discord measures field length in code points, not bytes - so a naive
/// byte-level slice would corrupt multi-byte chars at the cut point.
fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    s.chars().take(max_chars).collect()
}

#[tauri::command]
pub fn discord_rpc_connect(state: tauri::State<'_, DiscordState>) -> Result<(), String> {
    let mut guard = unpoison(state.inner.lock());
    if guard.is_some() {
        return Ok(());
    }
    let mut client = DiscordIpcClient::new(DISCORD_APP_ID).map_err(|e| e.to_string())?;
    // Connect can fail when Discord isn't running - surface as an error so
    // the frontend can quietly retry later.
    client.connect().map_err(|e| e.to_string())?;
    *guard = Some(client);
    let mut started = unpoison(state.started_at_ms.lock());
    if started.is_none() {
        *started = Some(now_ms());
    }
    Ok(())
}

#[tauri::command]
pub fn discord_rpc_update(
    state: tauri::State<'_, DiscordState>,
    payload: DiscordActivityPayload,
) -> Result<(), String> {
    let mut guard = unpoison(state.inner.lock());
    let Some(client) = guard.as_mut() else {
        return Err("not_connected".to_string());
    };

    let started = unpoison(state.started_at_ms.lock()).unwrap_or_else(now_ms);

    // Discord requires details/state to be 2-128 chars. Strings shorter
    // than 2 are dropped on Discord's end; strings longer than 128 cause
    // the whole activity update to be rejected. Clamp both sides so a
    // long file name (e.g. a deeply-nested fixture path) never silently
    // wipes the user's presence.
    let details_text = truncate_chars(&payload.details, 128);
    let state_text = truncate_chars(&payload.state, 128);

    let mut activity = Activity::new();
    if details_text.chars().count() >= 2 {
        activity = activity.details(&details_text);
    }
    if state_text.chars().count() >= 2 {
        activity = activity.state(&state_text);
    }
    activity = activity.timestamps(Timestamps::new().start(started / 1000));
    activity = activity.assets(
        Assets::new()
            .large_image(LARGE_IMAGE_KEY)
            .large_text(LARGE_IMAGE_TEXT),
    );

    // A broken pipe here means Discord was closed mid-session. Surfacing
    // the error lets the JS bridge drop its client and try to reconnect on
    // the next update.
    client.set_activity(activity).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn discord_rpc_disconnect(state: tauri::State<'_, DiscordState>) -> Result<(), String> {
    let mut guard = unpoison(state.inner.lock());
    if let Some(mut client) = guard.take() {
        // Best-effort: ignore errors - we're tearing down anyway.
        let _ = client.clear_activity();
        let _ = client.close();
    }
    Ok(())
}
