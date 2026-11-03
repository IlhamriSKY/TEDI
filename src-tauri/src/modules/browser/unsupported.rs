//! Every target but Windows: `native.rs`'s surface, refusing in one sentence.
//!
//! The panes themselves no longer need Windows for their safety (a raw webview
//! carries no Tauri IPC on any platform). What is missing is the rest of
//! `native.rs`, which is all WebView2 COM, and a build to test the WebKit one on.

use super::{BrowserPane, BrowserRect, PaneEvent};
use tauri::ipc::Channel;

const NOT_ON_THIS_PLATFORM: &str = "browser panes are Windows only in this version";

#[allow(clippy::too_many_arguments)]
pub async fn place(
    _app: tauri::AppHandle,
    _window: tauri::Window,
    _pane_id: String,
    _url: String,
    _bounds: BrowserRect,
    _holes: Vec<BrowserRect>,
    _visible: bool,
) -> Result<(), String> {
    Err(NOT_ON_THIS_PLATFORM.to_string())
}

pub async fn close(_app: tauri::AppHandle, _pane_id: String) -> Result<(), String> {
    Ok(())
}

pub async fn navigate(
    _app: tauri::AppHandle,
    _pane_id: String,
    _url: String,
) -> Result<(), String> {
    Err(NOT_ON_THIS_PLATFORM.to_string())
}

pub async fn list(_app: tauri::AppHandle) -> Result<Vec<BrowserPane>, String> {
    Ok(Vec::new())
}

pub async fn zoom(_app: tauri::AppHandle, _pane_id: String, _factor: f64) -> Result<(), String> {
    Err(NOT_ON_THIS_PLATFORM.to_string())
}

pub async fn cdp(
    _app: tauri::AppHandle,
    _pane_id: String,
    _method: String,
    _params: String,
) -> Result<String, String> {
    Err(NOT_ON_THIS_PLATFORM.to_string())
}

pub async fn watch(
    _app: tauri::AppHandle,
    _pane_id: String,
    _on_event: Channel<PaneEvent>,
) -> Result<(), String> {
    Err(NOT_ON_THIS_PLATFORM.to_string())
}

pub async fn find(
    _app: tauri::AppHandle,
    _pane_id: String,
    _query: Option<String>,
    _forward: bool,
) -> Result<bool, String> {
    Ok(false)
}

pub async fn focus(_app: tauri::AppHandle, _pane_id: String) -> Result<(), String> {
    Err(NOT_ON_THIS_PLATFORM.to_string())
}

pub async fn devtools(_app: tauri::AppHandle, _pane_id: String) -> Result<(), String> {
    Err(NOT_ON_THIS_PLATFORM.to_string())
}

pub fn set_blocker(
    _app: &tauri::AppHandle,
    _enabled: bool,
    _paused: Vec<String>,
    _hides: std::collections::HashMap<String, Vec<String>>,
) {
}

pub async fn blocked_count(_app: tauri::AppHandle, _pane_id: String) -> Result<u32, String> {
    Ok(0)
}
