//! Downloads, shown in the toolbar instead of WebView2's own bubble, which draws over
//! the page and cannot follow the app's theme.
//!
//! The table lives on the main thread with the panes. A finished entry lets go of its
//! COM operation, since all that is left to do with it is read its last snapshot.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    BytesReceivedChangedEventHandler, DownloadStartingEventHandler, StateChangedEventHandler,
};
use windows::core::{Interface, BOOL};

use super::native::{on_main, read_string, Shared};
use super::{Download, PaneEvent};

/// Progress fires per chunk, and a row only needs to move a few times a second.
const PROGRESS_EVERY: Duration = Duration::from_millis(250);

struct Entry {
    operation: Option<ICoreWebView2DownloadOperation>,
    last: Download,
}

thread_local! {
    static DOWNLOADS: RefCell<BTreeMap<u64, Entry>> = RefCell::default();
    static LAST_ID: Cell<u64> = const { Cell::new(0) };
}

/// Time-based, so an id kept in the extension's storage cannot meet a new one after a
/// restart.
fn next_id() -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |t| t.as_millis() as u64);
    let id = now.max(LAST_ID.get() + 1);
    LAST_ID.set(id);
    id
}

fn is_finished(state: &str) -> bool {
    matches!(state, "done" | "failed" | "cancelled")
}

fn snapshot(id: u64, operation: &ICoreWebView2DownloadOperation) -> Download {
    let (mut received, mut total) = (0_i64, 0_i64);
    let mut state = COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS;
    let mut reason = COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_NONE;
    let mut can_resume = BOOL::default();
    unsafe {
        let _ = operation.BytesReceived(&mut received);
        let _ = operation.TotalBytesToReceive(&mut total);
        let _ = operation.State(&mut state);
        let _ = operation.InterruptReason(&mut reason);
        let _ = operation.CanResume(&mut can_resume);
    }
    let path = read_string(|p| unsafe { operation.ResultFilePath(p) });
    let name = path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or_default()
        .to_string();
    let state = if state == COREWEBVIEW2_DOWNLOAD_STATE_COMPLETED {
        "done"
    } else if state == COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS {
        "running"
    } else if reason == COREWEBVIEW2_DOWNLOAD_INTERRUPT_REASON_USER_CANCELED {
        "cancelled"
    } else if can_resume.as_bool() {
        "paused"
    } else {
        "failed"
    };
    Download {
        id,
        name,
        path,
        url: read_string(|p| unsafe { operation.Uri(p) }),
        received,
        total,
        state,
    }
}

/// Record what the operation says now, and tell the pane that started it.
fn publish(id: u64, shared: &Shared, started: bool) {
    let operation = DOWNLOADS.with_borrow(|all| all.get(&id).and_then(|e| e.operation.clone()));
    let Some(operation) = operation else { return };
    let download = snapshot(id, &operation);
    // Taken out rather than dropped under the borrow: a release can run COM code.
    let done_with = DOWNLOADS.with_borrow_mut(|all| {
        let entry = all.get_mut(&id)?;
        entry.last = download.clone();
        if is_finished(download.state) {
            entry.operation.take()
        } else {
            None
        }
    });
    drop(done_with);
    shared.send(PaneEvent::Download { download, started });
}

pub(super) fn observe(core: &ICoreWebView2, shared: &Rc<Shared>) -> windows::core::Result<()> {
    let Ok(core4) = core.cast::<ICoreWebView2_4>() else {
        return Ok(());
    };
    let s = shared.clone();
    let handler = DownloadStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let operation = unsafe {
            args.SetHandled(true)?;
            args.DownloadOperation()?
        };
        track(operation, &s)
    }));
    let mut token = 0_i64;
    unsafe { core4.add_DownloadStarting(&handler, &mut token) }
}

fn track(
    operation: ICoreWebView2DownloadOperation,
    shared: &Rc<Shared>,
) -> windows::core::Result<()> {
    let id = next_id();
    let last = snapshot(id, &operation);
    DOWNLOADS.with_borrow_mut(|all| {
        all.insert(
            id,
            Entry {
                operation: Some(operation.clone()),
                last,
            },
        )
    });
    let mut token = 0_i64;
    let s = shared.clone();
    let sent_at = Cell::new(Instant::now());
    let progress = BytesReceivedChangedEventHandler::create(Box::new(move |_, _| {
        if sent_at.get().elapsed() >= PROGRESS_EVERY {
            sent_at.set(Instant::now());
            publish(id, &s, false);
        }
        Ok(())
    }));
    unsafe { operation.add_BytesReceivedChanged(&progress, &mut token)? };
    let s = shared.clone();
    let state = StateChangedEventHandler::create(Box::new(move |_, _| {
        publish(id, &s, false);
        Ok(())
    }));
    unsafe { operation.add_StateChanged(&state, &mut token)? };
    publish(id, shared, true);
    Ok(())
}

pub async fn downloads(app: tauri::AppHandle) -> Result<Vec<Download>, String> {
    on_main(&app, || {
        DOWNLOADS.with_borrow(|all| all.values().map(|e| e.last.clone()).collect())
    })
    .await
}

pub async fn download_action(app: tauri::AppHandle, id: u64, action: String) -> Result<(), String> {
    on_main(&app, move || {
        let operation = DOWNLOADS.with_borrow(|all| all.get(&id).and_then(|e| e.operation.clone()));
        let Some(operation) = operation else {
            return Ok(());
        };
        unsafe {
            match action.as_str() {
                "pause" => operation.Pause(),
                "resume" => operation.Resume(),
                "cancel" => operation.Cancel(),
                _ => Ok(()),
            }
        }
        .map_err(|e| e.to_string())
    })
    .await?
}

/// Show a downloaded file in Explorer. Never opens it: running what a page handed over
/// is a step the user takes from there, with the OS's own warnings in the way.
pub async fn reveal_download(path: String) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    let file = std::path::Path::new(&path);
    if !file.is_absolute() || path.contains('"') || !file.exists() {
        return Err("That file is no longer there.".to_string());
    }
    std::process::Command::new("explorer")
        .raw_arg(format!("/select,\"{path}\""))
        .spawn()
        .map(drop)
        .map_err(|e| e.to_string())
}
