//! The panes themselves: one raw `wry` child webview each, owned on the main thread.
//!
//! RAW, NOT A TAURI WEBVIEW, and that is the whole security model. `add_child`
//! would inject Tauri's IPC bootstrap and invoke key into the page and register the
//! app's custom protocols on it, and then everything would depend on cutting them
//! out again. A `wry::WebView` built here never has them: no bootstrap, no invoke
//! key, no protocol handler, and nothing in `app.webviews()`.
//!
//! THE MAIN THREAD OWNS EVERY PANE. A `wry::WebView` is `!Send`, so the table is a
//! thread-local and each command hops over with [`on_main`]. Panes are `Rc`s cloned
//! OUT of the table before any COM call: WebView2 calls can pump messages, and a
//! close that ran nested while the table stayed borrowed would panic, which under
//! `panic = "abort"` is the whole app.
//!
//! EVENTS, NOT POLLS. Everything the toolbar shows arrives from WebView2's own
//! events over one Channel per pane, so a pane nobody is touching does nothing.
//! The handlers capture `Shared` and never the webview: taking the core from the
//! `sender` argument is what keeps them from holding it alive in a cycle.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use tauri::ipc::Channel;
use tauri::Manager;
use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    take_pwstr, AcceleratorKeyPressedEventHandler, CallDevToolsProtocolMethodCompletedHandler,
    ContentLoadingEventHandler, DOMContentLoadedEventHandler,
    DevToolsProtocolEventReceivedEventHandler, DocumentTitleChangedEventHandler,
    FaviconChangedEventHandler, FindActiveMatchIndexChangedEventHandler,
    FindMatchCountChangedEventHandler, FindStartCompletedHandler, FocusChangedEventHandler,
    GetFaviconCompletedHandler, HistoryChangedEventHandler, LaunchingExternalUriSchemeEventHandler,
    NavigationCompletedEventHandler, NavigationStartingEventHandler,
    NewWindowRequestedEventHandler, ProcessFailedEventHandler, SourceChangedEventHandler,
    TrySuspendCompletedHandler,
};
use windows::core::{Interface, BOOL, HSTRING, PWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Gdi::{
    CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, VK_ADD, VK_CONTROL, VK_F12, VK_F3, VK_F5, VK_F6, VK_LEFT, VK_MENU, VK_NUMPAD0,
    VK_OEM_MINUS, VK_OEM_PLUS, VK_RIGHT, VK_SHIFT, VK_SUBTRACT,
};
use wry::{WebContext, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

use super::{blocker, cdp as cdp_bridge, BrowserPane, BrowserRect, PaneEvent};

/// How long a hidden pane stays warm before it is put to sleep. A page playing
/// audio or holding a capture refuses the suspend on its own.
const SUSPEND_AFTER: Duration = Duration::from_secs(5 * 60);
/// A renderer that dies again inside this window is a page that kills it, and
/// reloading it forever would burn the machine for nothing.
const CRASH_RELOAD_WINDOW: Duration = Duration::from_secs(30);
const LATE_SCAN_AFTER: Duration = Duration::from_millis(2500);
/// A favicon lands on the pane header and is persisted with the workspace.
const MAX_ICON_BYTES: usize = 64 * 1024;

/// What the event handlers need, and nothing that keeps the webview alive.
pub(super) struct Shared {
    sink: RefCell<Option<Channel<PaneEvent>>>,
    loading: Cell<bool>,
    icon: RefCell<String>,
    /// The page's address, read by the blocker on every request.
    top: RefCell<String>,
    /// What the blocker refused for this document, for the menu.
    blocked: Cell<u32>,
    /// The hide rules this document already has.
    applied: Rc<RefCell<HashSet<String>>>,
    last_crash_reload: Cell<Option<Instant>>,
}

impl Shared {
    pub(super) fn send(&self, event: PaneEvent) {
        // Cloned out so no borrow is held across the send: a nested `watch` swapping
        // the sink would otherwise panic, and a panic here is the whole app.
        let sink = self.sink.borrow().clone();
        if let Some(sink) = sink {
            let _ = sink.send(event);
        }
    }

    fn publish_state(&self, core: &ICoreWebView2) {
        let url = read_string(|p| unsafe { core.Source(p) });
        let title = read_string(|p| unsafe { core.DocumentTitle(p) });
        self.top.replace(url.clone());
        self.send(PaneEvent::State {
            url,
            title,
            loading: self.loading.get(),
        });
    }
}

struct FindSession {
    find: ICoreWebView2Find,
    environment: ICoreWebView2Environment15,
    query: String,
    tokens: [i64; 2],
}

impl Drop for FindSession {
    fn drop(&mut self) {
        unsafe {
            let _ = self.find.remove_MatchCountChanged(self.tokens[0]);
            let _ = self.find.remove_ActiveMatchIndexChanged(self.tokens[1]);
            let _ = self.find.Stop();
        }
    }
}

struct Pane {
    view: wry::WebView,
    shared: Rc<Shared>,
    visible: Cell<bool>,
    /// Bumped on every visibility change, so a suspend scheduled for a hide that
    /// has since been undone finds out and stands down.
    epoch: Cell<u64>,
    find: RefCell<Option<FindSession>>,
    _context: WebContext,
}

thread_local! {
    static PANES: RefCell<HashMap<String, Rc<Pane>>> = RefCell::default();
}

/// Serialises CREATES, across threads and across the message pump `build_as_child`
/// runs: two mounts sharing a pane id would otherwise both find nothing and build
/// two webviews for one key, and unlike a Tauri label nothing else refuses that.
static CREATING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn pane(pane_id: &str) -> Option<Rc<Pane>> {
    PANES.with_borrow(|panes| panes.get(pane_id).cloned())
}

/// Any live pane's core, which is how the profile is reached: there is one profile,
/// and WebView2 only hands it out through a webview.
pub(super) fn any_core() -> Option<ICoreWebView2> {
    let any = PANES.with_borrow(|panes| panes.values().next().cloned());
    any.map(|pane| pane.view.webview())
}

pub(super) fn pane_core(pane_id: &str) -> Option<ICoreWebView2> {
    pane(pane_id).map(|pane| pane.view.webview())
}

pub(super) fn pane_shared(pane_id: &str) -> Option<Rc<Shared>> {
    pane(pane_id).map(|pane| pane.shared.clone())
}

/// Run `f` on the main thread and hand back its answer.
pub(super) async fn on_main<T: Send + 'static>(
    app: &tauri::AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "the app is shutting down".to_string())
}

/// [`on_main`] with the pane looked up, and refused when it does not exist.
async fn with_pane<T: Send + 'static>(
    app: &tauri::AppHandle,
    pane_id: String,
    f: impl FnOnce(&Pane) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    on_main(app, move || {
        let pane = pane(&pane_id).ok_or_else(|| "no open browser pane with that id".to_string())?;
        f(&pane)
    })
    .await?
}

fn read_string(read: impl FnOnce(*mut PWSTR) -> windows::core::Result<()>) -> String {
    let mut value = PWSTR::null();
    if read(&mut value).is_err() || value.is_null() {
        return String::new();
    }
    take_pwstr(value)
}

// --- placing ---------------------------------------------------------------

pub async fn place(
    app: tauri::AppHandle,
    window: tauri::Window,
    pane_id: String,
    url: String,
    bounds: BrowserRect,
    holes: Vec<BrowserRect>,
    visible: bool,
) -> Result<(), String> {
    let id = pane_id.clone();
    let exists = on_main(&app, move || pane(&id).is_some()).await?;
    if !exists {
        let _creating = CREATING.lock().await;
        let (handle, id) = (app.clone(), pane_id.clone());
        on_main(&app, move || {
            if pane(&id).is_some() {
                return Ok(());
            }
            // GUARDED HERE, NOT ON EVERY PLACEMENT. `url` is only used to create
            // the webview; later calls carry the page's live address so the caller
            // has something to pass, and that is legitimately `blob:` or an engine
            // error page sometimes. Refusing the placement for that froze a pane
            // at its last rectangle.
            if let Some(reason) = super::guard_url(&url, super::dev_server(&handle).as_ref()) {
                return Err(reason);
            }
            create(&handle, &window, &id, &url)
        })
        .await??;
    }
    let (handle, id) = (app.clone(), pane_id.clone());
    with_pane(&app, pane_id, move |pane| {
        apply_placement(&handle, &id, pane, bounds, &holes, visible)
    })
    .await
}

/// POSITION BEFORE VISIBILITY: a pane coming back was left wherever it was, and
/// showing it first paints a frame at the stale rectangle, which on a tab switch is
/// the previous tab's pane. A hidden pane is not moved at all, so hiding it never
/// resizes the page under whatever it was doing.
fn apply_placement(
    app: &tauri::AppHandle,
    pane_id: &str,
    pane: &Pane,
    bounds: BrowserRect,
    holes: &[BrowserRect],
    visible: bool,
) -> Result<(), String> {
    if visible {
        pane.view
            .set_bounds(wry::Rect {
                position: wry::dpi::PhysicalPosition::new(bounds.x, bounds.y).into(),
                size: wry::dpi::PhysicalSize::new(bounds.width.max(1), bounds.height.max(1)).into(),
            })
            .map_err(|e| format!("could not place the browser pane: {e}"))?;
        clip(pane, bounds, holes);
    }
    if pane.visible.replace(visible) == visible {
        return Ok(());
    }
    let core = pane.view.webview();
    let epoch = pane.epoch.get() + 1;
    pane.epoch.set(epoch);
    if visible {
        let _ = unsafe { core.cast::<ICoreWebView2_3>().map(|c| c.Resume()) };
        set_memory_level(&core, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL);
    } else {
        set_memory_level(&core, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
    }
    pane.view.set_visible(visible).map_err(|e| e.to_string())?;
    if !visible {
        schedule_suspend(app.clone(), pane_id.to_string(), epoch);
    }
    Ok(())
}

/// Hidden pages drop their tiles at once.
fn set_memory_level(core: &ICoreWebView2, level: COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL) {
    if let Ok(core19) = core.cast::<ICoreWebView2_19>() {
        let _ = unsafe { core19.SetMemoryUsageTargetLevel(level) };
    }
}

/// Hidden AND idle pages are suspended. Lossless, and the renderer's working set is
/// most of what a pane costs.
fn schedule_suspend(app: tauri::AppHandle, pane_id: String, epoch: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SUSPEND_AFTER).await;
        let _ = on_main(&app, move || {
            let Some(pane) = pane(&pane_id) else { return };
            if pane.epoch.get() != epoch || pane.visible.get() {
                return;
            }
            if let Ok(core3) = pane.view.webview().cast::<ICoreWebView2_3>() {
                let done = TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
                let _ = unsafe { core3.TrySuspend(&done) };
            }
        })
        .await;
    });
}

/// Cut `holes` out of the pane's webview, so what the app draws over it is visible
/// and clickable with the page still live underneath.
fn clip(pane: &Pane, bounds: BrowserRect, holes: &[BrowserRect]) {
    let mut hwnd = HWND::default();
    unsafe {
        // wry keeps no HWND accessor; the controller's parent IS its container.
        if pane.view.controller().ParentWindow(&mut hwnd).is_err() || hwnd.is_invalid() {
            return;
        }
        if holes.is_empty() {
            SetWindowRgn(hwnd, None, true);
            return;
        }
        let whole = CreateRectRgn(0, 0, bounds.width.max(1), bounds.height.max(1));
        for h in holes {
            let hole = CreateRectRgn(h.x, h.y, h.x + h.width, h.y + h.height);
            CombineRgn(Some(whole), Some(whole), Some(hole), RGN_DIFF);
            let _ = DeleteObject(hole.into());
        }
        // The SYSTEM owns the region once this succeeds, and only then.
        if SetWindowRgn(hwnd, Some(whole), true) == 0 {
            let _ = DeleteObject(whole.into());
        }
    }
}

// --- creating --------------------------------------------------------------

/// Build a pane's webview. Born on `about:blank` with `first` loaded after the
/// handlers are in, so no page runs before them; the blank entry also keeps a page
/// from calling `window.close()`, which Chromium only allows at a history length of
/// one and which stock wry answers by destroying the HWND.
fn create(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    pane_id: &str,
    url: &str,
) -> Result<(), String> {
    let first = match url.trim() {
        "" | "about:blank" => None,
        target => Some(target.to_string()),
    };
    let dev_url = super::dev_server(app);
    let dirs = super::data_dirs(app);

    let mut context = WebContext::new(dirs.as_ref().map(|(profile, _)| profile.clone()));
    let builder = WebViewBuilder::new_with_web_context(&mut context)
        // ALWAYS ON, because it is fixed per environment for the life of the run: an
        // extension installed from a pane has to load in that pane, with no restart.
        .with_browser_extensions_enabled(true)
        .with_url("about:blank")
        // EVERY top-level navigation, not just the commands: a link click or a
        // redirect passes through neither.
        .with_navigation_handler(move |to| super::guard_url(&to, dev_url.as_ref()).is_none())
        // A pane opened behind the user (by the agent, by a restore) must not take
        // the keyboard out of whatever they are typing into.
        .with_focused(false)
        .with_visible(false)
        .with_devtools(true)
        .with_hotkeys_zoom(true);

    if let Some((profile, _)) = dirs {
        let _ = std::fs::create_dir_all(profile);
    }

    let view = builder
        .build_as_child(window)
        .map_err(|e| format!("could not create the browser pane: {e}"))?;

    let shared = Rc::new(Shared {
        sink: RefCell::default(),
        loading: Cell::new(false),
        icon: RefCell::default(),
        top: RefCell::default(),
        blocked: Cell::new(0),
        applied: Rc::default(),
        last_crash_reload: Cell::new(None),
    });
    let core = view.webview();
    harden(&core);
    observe(app, pane_id, &view, &core, &shared).map_err(|e| e.to_string())?;
    let top = shared.clone();
    let count = shared.clone();
    blocker::attach(
        &core,
        &view.environment(),
        move || top.top.borrow().clone(),
        move || count.blocked.set(count.blocked.get().saturating_add(1)),
    );
    super::extensions::reconcile_once(app, &core);

    if let Some(first) = first {
        view.load_url(&first)
            .map_err(|e| format!("could not open the page: {e}"))?;
    }
    PANES.with_borrow_mut(|panes| {
        panes.insert(
            pane_id.to_string(),
            Rc::new(Pane {
                view,
                shared,
                visible: Cell::new(false),
                epoch: Cell::new(0),
                find: RefCell::default(),
                _context: context,
            }),
        );
    });
    Ok(())
}

/// WebView2's browser keys come off because the pane owns them (`classify_key`):
/// Ctrl+W acting on its own closed all of TEDI. Web messages and host objects come
/// off because nothing here uses them, so a later handler cannot quietly become a
/// bridge.
fn harden(core: &ICoreWebView2) {
    unsafe {
        let Ok(settings) = core.Settings() else {
            return;
        };
        let _ = settings.SetIsWebMessageEnabled(false);
        let _ = settings.SetAreHostObjectsAllowed(false);
        if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    }
}

/// Every WebView2 event the pane listens to. Removed by `controller.Close()` when
/// the pane drops, which also releases what they captured.
fn observe(
    app: &tauri::AppHandle,
    pane_id: &str,
    view: &wry::WebView,
    core: &ICoreWebView2,
    shared: &Rc<Shared>,
) -> windows::core::Result<()> {
    let mut token = 0_i64;

    // SourceChanged covers full navigations, fragments and the History API.
    let s = shared.clone();
    let handler = SourceChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(core) = sender {
            s.publish_state(&core);
        }
        Ok(())
    }));
    unsafe { core.add_SourceChanged(&handler, &mut token)? };

    let s = shared.clone();
    let handler = DocumentTitleChangedEventHandler::create(Box::new(move |sender, _| {
        if let Some(core) = sender {
            s.publish_state(&core);
        }
        Ok(())
    }));
    unsafe { core.add_DocumentTitleChanged(&handler, &mut token)? };

    let s = shared.clone();
    let handler = NavigationStartingEventHandler::create(Box::new(move |sender, _| {
        s.loading.set(true);
        s.blocked.set(0);
        if let Some(core) = sender {
            s.publish_state(&core);
        }
        Ok(())
    }));
    unsafe { core.add_NavigationStarting(&handler, &mut token)? };

    // Also fires for a cancelled or failed navigation, so loading cannot stick.
    let s = shared.clone();
    let late_app = app.clone();
    let late_id = pane_id.to_string();
    let handler = NavigationCompletedEventHandler::create(Box::new(move |sender, _| {
        s.loading.set(false);
        if let Some(core) = sender {
            s.publish_state(&core);
            blocker::scan_document(&core, s.top.borrow().clone(), s.applied.clone());
            scan_again_later(late_app.clone(), late_id.clone());
        }
        Ok(())
    }));
    unsafe { core.add_NavigationCompleted(&handler, &mut token)? };

    // Before the document's own content, so a site's known ad slots never show.
    let s = shared.clone();
    let handler = ContentLoadingEventHandler::create(Box::new(move |sender, _| {
        if let Some(core) = sender {
            let top = read_string(|p| unsafe { core.Source(p) });
            s.top.replace(top.clone());
            blocker::start_document(&core, &top, &mut s.applied.borrow_mut());
        }
        Ok(())
    }));
    unsafe { core.add_ContentLoading(&handler, &mut token)? };

    if let Ok(core2) = core.cast::<ICoreWebView2_2>() {
        let s = shared.clone();
        let handler = DOMContentLoadedEventHandler::create(Box::new(move |sender, _| {
            if let Some(core) = sender {
                blocker::scan_document(&core, s.top.borrow().clone(), s.applied.clone());
            }
            Ok(())
        }));
        unsafe { core2.add_DOMContentLoaded(&handler, &mut token)? };
    }

    // pushState can add an entry without moving the serialized source.
    let s = shared.clone();
    let handler = HistoryChangedEventHandler::create(Box::new(move |_, _| {
        s.send(PaneEvent::History);
        Ok(())
    }));
    unsafe { core.add_HistoryChanged(&handler, &mut token)? };

    if let Ok(core15) = core.cast::<ICoreWebView2_15>() {
        observe_favicon(&core15, shared)?;
    }

    // WITHOUT THIS EVERY `target="_blank"` LINK DID NOTHING: with no handler of its
    // own to call, stock wry answers `SetHandled(true)` and the request vanishes.
    // User-initiated only, or any page could open panes in a loop.
    //
    // shortcut: a new pane loads the url fresh, so `window.opener` is gone and a
    // popup-style OAuth flow cannot post back. Adopting the new window with
    // `SetNewWindow` would keep it.
    let s = shared.clone();
    let handler = NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        unsafe {
            args.SetHandled(true)?;
            let mut user = BOOL::default();
            args.IsUserInitiated(&mut user)?;
            if user.as_bool() {
                let url = read_string(|p| args.Uri(p));
                s.send(PaneEvent::NewWindow { url });
            }
        }
        Ok(())
    }));
    unsafe { core.add_NewWindowRequested(&handler, &mut token)? };

    // A page may not launch another application on its own. A click still gets
    // WebView2's own "open this app?" prompt, which is what a meeting link needs.
    if let Ok(core18) = core.cast::<ICoreWebView2_18>() {
        let handler = LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut user = BOOL::default();
            unsafe {
                args.IsUserInitiated(&mut user)?;
                if !user.as_bool() {
                    args.SetCancel(true)?;
                }
            }
            Ok(())
        }));
        unsafe { core18.add_LaunchingExternalUriScheme(&handler, &mut token)? };
    }

    observe_process_failure(app, pane_id, core, shared)?;
    observe_keys(app, view, shared)?;
    observe_log(core, shared)?;
    Ok(())
}

/// One more look a moment after the load, for what a page's script added.
fn scan_again_later(app: tauri::AppHandle, pane_id: String) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(LATE_SCAN_AFTER).await;
        let _ = on_main(&app, move || {
            let Some(pane) = pane(&pane_id) else { return };
            let top = pane.shared.top.borrow().clone();
            blocker::scan_document(&pane.view.webview(), top, pane.shared.applied.clone());
        })
        .await;
    });
}

fn observe_favicon(core: &ICoreWebView2_15, shared: &Rc<Shared>) -> windows::core::Result<()> {
    let s = shared.clone();
    let source = core.clone();
    let handler = FaviconChangedEventHandler::create(Box::new(move |_, _| {
        let uri = read_string(|p| unsafe { source.FaviconUri(p) });
        if uri.is_empty() {
            // Sent, so a page with no icon does not keep the previous site's.
            s.icon.borrow_mut().clear();
            s.send(PaneEvent::Icon {
                data: String::new(),
            });
            return Ok(());
        }
        let (s2, check) = (s.clone(), source.clone());
        let done = GetFaviconCompletedHandler::create(Box::new(move |result, stream| {
            // Fetched for a page since left: drop it.
            if read_string(|p| unsafe { check.FaviconUri(p) }) != uri {
                return Ok(());
            }
            let Some(png) = result
                .ok()
                .and(stream)
                .and_then(|stream| read_icon(&stream))
            else {
                return Ok(());
            };
            let data = format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(png)
            );
            s2.icon.replace(data.clone());
            s2.send(PaneEvent::Icon { data });
            Ok(())
        }));
        let _ = unsafe { source.GetFavicon(COREWEBVIEW2_FAVICON_IMAGE_FORMAT_PNG, &done) };
        Ok(())
    }));
    let mut token = 0_i64;
    unsafe { core.add_FaviconChanged(&handler, &mut token) }
}

fn read_icon(stream: &windows::Win32::System::Com::IStream) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 8192];
    loop {
        let mut read = 0_u32;
        let result = unsafe {
            stream.Read(
                chunk.as_mut_ptr().cast(),
                chunk.len() as u32,
                Some(&mut read),
            )
        };
        if result.is_err() {
            return None;
        }
        if read == 0 {
            return (!bytes.is_empty()).then_some(bytes);
        }
        if bytes.len() + read as usize > MAX_ICON_BYTES {
            return None;
        }
        bytes.extend_from_slice(&chunk[..read as usize]);
    }
}

fn observe_process_failure(
    app: &tauri::AppHandle,
    pane_id: &str,
    core: &ICoreWebView2,
    shared: &Rc<Shared>,
) -> windows::core::Result<()> {
    let s = shared.clone();
    let (app, pane_id) = (app.clone(), pane_id.to_string());
    let handler = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
        let Some(args) = args else { return Ok(()) };
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
        unsafe { args.ProcessFailedKind(&mut kind)? };
        if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
            let recent = s
                .last_crash_reload
                .get()
                .is_some_and(|at| at.elapsed() < CRASH_RELOAD_WINDOW);
            if !recent {
                s.last_crash_reload.set(Some(Instant::now()));
                if let Some(core) = sender {
                    let _ = unsafe { core.Reload() };
                }
            }
        } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
            // Nothing can bring this webview back, so it is dropped and the pane's
            // next placement builds a new one on its remembered page. Dropped from
            // a later turn: this callback belongs to the object being dropped.
            s.send(PaneEvent::Gone);
            let id = pane_id.clone();
            let _ = app.run_on_main_thread(move || {
                let gone = PANES.with_borrow_mut(|panes| panes.remove(&id));
                drop(gone);
            });
        }
        // An unresponsive page is the user's to give up on, and everything else
        // (subframe, GPU, utility) WebView2 brings back itself.
        Ok(())
    }));
    let mut token = 0_i64;
    unsafe { core.add_ProcessFailed(&handler, &mut token) }
}

/// What a key means to a focused pane, or `None` for "the page's".
///
/// THE ONLY PLACE THE HOST SEES KEYS AIMED AT THE PAGE, and WebView2 asks here
/// before the page does. Editing chords (Ctrl+C and friends) are left out on
/// purpose, and so is everything a site commonly binds for itself.
fn classify_key(vk: u32, ctrl: bool, shift: bool, alt: bool) -> Option<&'static str> {
    let is = |key: u16| vk == u32::from(key);
    let letter = |c: u8| vk == u32::from(c);
    let none = !ctrl && !shift && !alt;
    let ctrl_only = ctrl && !shift && !alt;
    let ctrl_shift = ctrl && shift && !alt;
    let alt_only = alt && !ctrl && !shift;
    match () {
        _ if (ctrl_only && letter(b'L')) || (none && is(VK_F6.0)) => Some("address"),
        _ if ctrl_only && letter(b'F') => Some("find"),
        _ if none && is(VK_F3.0) => Some("findNext"),
        _ if (ctrl_shift && letter(b'R')) || (ctrl_only && is(VK_F5.0)) => Some("hardReload"),
        _ if (ctrl_only && letter(b'R')) || (none && is(VK_F5.0)) => Some("reload"),
        _ if alt_only && is(VK_LEFT.0) => Some("back"),
        _ if alt_only && is(VK_RIGHT.0) => Some("forward"),
        // Shift is allowed through: `+` is Shift+= on most layouts.
        _ if ctrl && !alt && (is(VK_OEM_PLUS.0) || is(VK_ADD.0)) => Some("zoomIn"),
        _ if ctrl && !alt && (is(VK_OEM_MINUS.0) || is(VK_SUBTRACT.0)) => Some("zoomOut"),
        _ if ctrl_only && (letter(b'0') || is(VK_NUMPAD0.0)) => Some("zoomReset"),
        _ if (none && is(VK_F12.0)) || (ctrl_shift && letter(b'I')) => Some("devtools"),
        _ => None,
    }
}

fn observe_keys(
    app: &tauri::AppHandle,
    view: &wry::WebView,
    shared: &Rc<Shared>,
) -> windows::core::Result<()> {
    let s = shared.clone();
    let focus_app = app.clone();
    let app = app.clone();
    let handler = AcceleratorKeyPressedEventHandler::create(Box::new(move |controller, args| {
        let Some(args) = args else { return Ok(()) };
        let mut kind = COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN;
        let mut key = 0_u32;
        let mut lparam = 0_i32;
        unsafe {
            args.KeyEventKind(&mut kind)?;
            if kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN
                && kind != COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN
            {
                return Ok(());
            }
            args.VirtualKey(&mut key)?;
            args.KeyEventLParam(&mut lparam)?;
        }
        let down = |vk: u16| unsafe { (GetKeyState(i32::from(vk)) as u16 & 0x8000) != 0 };
        let Some(action) = classify_key(key, down(VK_CONTROL.0), down(VK_SHIFT.0), down(VK_MENU.0))
        else {
            return Ok(());
        };
        unsafe { args.SetHandled(true)? };
        // Holding the key must not repeat what its first press did.
        if lparam & (1 << 30) != 0 {
            return Ok(());
        }
        if action == "devtools" {
            if let Some(core) = controller.and_then(|c| unsafe { c.CoreWebView2() }.ok()) {
                let _ = unsafe { core.OpenDevToolsWindow() };
            }
            return Ok(());
        }
        // These two put the caret in the chrome, which is a different webview, and
        // an element's `.focus()` cannot pull OS focus across to it.
        if matches!(action, "address" | "find") {
            if let Some(main) = app.get_webview("main") {
                let _ = main.set_focus();
            }
        }
        s.send(PaneEvent::Key {
            action: action.to_string(),
        });
        Ok(())
    }));
    let mut token = 0_i64;
    let controller = view.controller();
    unsafe { controller.add_AcceleratorKeyPressed(&handler, &mut token)? };
    let focused = FocusChangedEventHandler::create(Box::new(move |_, _| {
        super::extensions::close_popup_soon(&focus_app);
        Ok(())
    }));
    unsafe { controller.add_GotFocus(&focused, &mut token) }
}

/// What only the DevTools channel hears: CSP violations, blocked and failed
/// requests. `console.js` can only see what the page's own script can, so a page
/// blank because its bundle 404'd used to report nothing at all.
fn observe_log(core: &ICoreWebView2, shared: &Rc<Shared>) -> windows::core::Result<()> {
    let s = shared.clone();
    let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let json = read_string(|p| unsafe { args.ParameterObjectAsJson(p) });
        if let Some((level, text)) = parse_log_entry(&json) {
            s.send(PaneEvent::Log { level, text });
        }
        Ok(())
    }));
    let name = HSTRING::from("Log.entryAdded");
    let receiver = unsafe { core.GetDevToolsProtocolEventReceiver(&name)? };
    let mut token = 0_i64;
    unsafe { receiver.add_DevToolsProtocolEventReceived(&handler, &mut token)? };
    let done = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
    unsafe {
        core.CallDevToolsProtocolMethod(&HSTRING::from("Log.enable"), &HSTRING::from("{}"), &done)
    }
}

/// `{entry:{level,text,url}}`, warnings and errors only: the rest is what Chromium
/// tells everyone about third-party cookies.
fn parse_log_entry(json: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let entry = value.get("entry")?;
    let level = entry.get("level")?.as_str()?;
    if level != "error" && level != "warning" {
        return None;
    }
    let text = entry.get("text")?.as_str()?;
    // Several per third-party script, and never why a page is broken.
    if text.starts_with("Tracking Prevention") {
        return None;
    }
    let text = match entry.get("url").and_then(|u| u.as_str()) {
        Some(url) if !url.is_empty() => format!("{text} ({url})"),
        _ => text.to_string(),
    };
    Some((
        if level == "warning" { "warn" } else { "error" }.to_string(),
        text,
    ))
}

// --- the rest of the surface -------------------------------------------------

pub async fn close(app: tauri::AppHandle, pane_id: String) -> Result<(), String> {
    on_main(&app, move || {
        // Dropped outside the borrow: closing a controller can pump messages.
        let gone = PANES.with_borrow_mut(|panes| panes.remove(&pane_id));
        drop(gone);
    })
    .await
}

pub async fn navigate(app: tauri::AppHandle, pane_id: String, url: String) -> Result<(), String> {
    with_pane(&app, pane_id, move |pane| {
        pane.view.load_url(url.trim()).map_err(|e| e.to_string())
    })
    .await
}

pub async fn list(app: tauri::AppHandle) -> Result<Vec<BrowserPane>, String> {
    on_main(&app, || {
        let all: Vec<(String, Rc<Pane>)> = PANES.with_borrow(|panes| {
            panes
                .iter()
                .map(|(id, pane)| (id.clone(), pane.clone()))
                .collect()
        });
        let mut out: Vec<BrowserPane> = all
            .into_iter()
            .map(|(pane_id, pane)| BrowserPane {
                pane_id,
                url: pane.view.url().unwrap_or_default(),
            })
            .collect();
        out.sort_by(|a, b| a.pane_id.cmp(&b.pane_id));
        out
    })
    .await
}

pub async fn zoom(app: tauri::AppHandle, pane_id: String, factor: f64) -> Result<(), String> {
    with_pane(&app, pane_id, move |pane| {
        // Clamped: the caller derives this from a CSS transform, and a zero would
        // be a blank pane with no error anywhere.
        pane.view
            .zoom(factor.clamp(0.1, 5.0))
            .map_err(|e| e.to_string())
    })
    .await
}

pub async fn cdp(
    app: tauri::AppHandle,
    pane_id: String,
    method: String,
    params: String,
) -> Result<String, String> {
    let (reply, rx) = cdp_bridge::reply();
    let name = method.clone();
    with_pane(&app, pane_id, move |pane| {
        let core = pane.view.webview();
        // An agent can drive a hidden pane, and a suspended one answers nothing.
        if let Ok(core3) = core.cast::<ICoreWebView2_3>() {
            let mut suspended = BOOL::default();
            if unsafe { core3.IsSuspended(&mut suspended) }.is_ok() && suspended.as_bool() {
                let _ = unsafe { core3.Resume() };
            }
        }
        cdp_bridge::send(&core, &name, &params, reply);
        Ok(())
    })
    .await?;
    cdp_bridge::wait(rx, &method).await
}

/// Subscribe a pane's events. Replaces whoever was listening, so a remount or an
/// extension reload takes over; answered with the current state, because whatever
/// happened before anyone listened is gone.
pub async fn watch(
    app: tauri::AppHandle,
    pane_id: String,
    on_event: Channel<PaneEvent>,
) -> Result<(), String> {
    with_pane(&app, pane_id, move |pane| {
        pane.shared.sink.replace(Some(on_event));
        pane.shared.publish_state(&pane.view.webview());
        pane.shared.send(PaneEvent::History);
        let icon = pane.shared.icon.borrow().clone();
        pane.shared.send(PaneEvent::Icon { data: icon });
        Ok(())
    })
    .await
}

/// One step of find-on-page, with WebView2's own dialog suppressed: the toolbar
/// draws the field, the engine highlights and counts across frames. `None` ends the
/// search. `false` when this runtime has no Find API, so the caller can fall back.
pub async fn find(
    app: tauri::AppHandle,
    pane_id: String,
    query: Option<String>,
    forward: bool,
) -> Result<bool, String> {
    with_pane(&app, pane_id, move |pane| {
        let Some(query) = query else {
            // Taken out before the drop: `Stop` can re-enter.
            let session = pane.find.borrow_mut().take();
            drop(session);
            return Ok(true);
        };
        Ok(find_step(pane, &query, forward).is_ok())
    })
    .await
}

fn find_step(pane: &Pane, query: &str, forward: bool) -> windows::core::Result<()> {
    if pane.find.borrow().is_none() {
        let session = open_find(&pane.view.webview(), &pane.shared)?;
        pane.find.replace(Some(session));
    }
    let (find, environment, repeat) = {
        let mut guard = pane.find.borrow_mut();
        let Some(session) = guard.as_mut() else {
            return Err(windows::core::Error::empty());
        };
        let repeat = session.query == query;
        if !repeat {
            session.query = query.to_string();
        }
        (session.find.clone(), session.environment.clone(), repeat)
    };
    unsafe {
        if repeat {
            return if forward {
                find.FindNext()
            } else {
                find.FindPrevious()
            };
        }
        let options = environment.CreateFindOptions()?;
        options.SetFindTerm(&HSTRING::from(query))?;
        options.SetIsCaseSensitive(false)?;
        options.SetShouldHighlightAllMatches(true)?;
        options.SetSuppressDefaultFindDialog(true)?;
        // Reported here too: the change events stay silent when the count did not
        // change, which is every search that finds nothing.
        let (s, done_find) = (pane.shared.clone(), find.clone());
        let done = FindStartCompletedHandler::create(Box::new(move |_| {
            s.send(find_state(&done_find));
            Ok(())
        }));
        find.Start(&options, &done)
    }
}

fn find_state(find: &ICoreWebView2Find) -> PaneEvent {
    let (mut matches, mut active) = (0_i32, -1_i32);
    unsafe {
        let _ = find.MatchCount(&mut matches);
        let _ = find.ActiveMatchIndex(&mut active);
    }
    PaneEvent::Find {
        matches: matches.max(0) as u32,
        // Already one-based, measured on a three-match page; -1 with nothing active.
        active: active.max(0) as u32,
    }
}

fn open_find(core: &ICoreWebView2, shared: &Rc<Shared>) -> windows::core::Result<FindSession> {
    let find = unsafe { core.cast::<ICoreWebView2_28>()?.Find()? };
    let environment = unsafe {
        core.cast::<ICoreWebView2_2>()?
            .Environment()?
            .cast::<ICoreWebView2Environment15>()?
    };
    let mut tokens = [0_i64; 2];
    let s = shared.clone();
    let counted = FindMatchCountChangedEventHandler::create(Box::new(move |find, _| {
        if let Some(find) = find {
            s.send(find_state(&find));
        }
        Ok(())
    }));
    let s = shared.clone();
    let moved = FindActiveMatchIndexChangedEventHandler::create(Box::new(move |find, _| {
        if let Some(find) = find {
            s.send(find_state(&find));
        }
        Ok(())
    }));
    unsafe {
        find.add_MatchCountChanged(&counted, &mut tokens[0])?;
        find.add_ActiveMatchIndexChanged(&moved, &mut tokens[1])?;
    }
    Ok(FindSession {
        find,
        environment,
        query: String::new(),
        tokens,
    })
}

/// Give the page the keyboard back, after the address bar or the find bar had it.
pub async fn focus(app: tauri::AppHandle, pane_id: String) -> Result<(), String> {
    with_pane(&app, pane_id, |pane| {
        pane.view.focus().map_err(|e| e.to_string())
    })
    .await
}

pub async fn devtools(app: tauri::AppHandle, pane_id: String) -> Result<(), String> {
    with_pane(&app, pane_id, |pane| {
        unsafe { pane.view.webview().OpenDevToolsWindow() }.map_err(|e| e.to_string())
    })
    .await
}

pub fn set_blocker(
    app: &tauri::AppHandle,
    enabled: bool,
    paused: Vec<String>,
    hides: HashMap<String, Vec<String>>,
) {
    blocker::set_rules(paused, hides);
    blocker::set_enabled(app, enabled);
}

/// How many requests the blocker refused for the page a pane is on.
pub async fn blocked_count(app: tauri::AppHandle, pane_id: String) -> Result<u32, String> {
    with_pane(&app, pane_id, |pane| Ok(pane.shared.blocked.get())).await
}

#[cfg(test)]
mod tests {
    use super::{classify_key, parse_log_entry};

    #[test]
    fn the_pane_takes_only_the_chords_it_means() {
        let ctrl = |c: u8| classify_key(u32::from(c), true, false, false);
        assert_eq!(ctrl(b'L'), Some("address"));
        assert_eq!(ctrl(b'F'), Some("find"));
        assert_eq!(ctrl(b'R'), Some("reload"));
        assert_eq!(
            classify_key(u32::from(b'R'), true, true, false),
            Some("hardReload")
        );
        assert_eq!(classify_key(0x74, false, false, false), Some("reload")); // F5
        assert_eq!(classify_key(0x74, true, false, false), Some("hardReload"));
        assert_eq!(classify_key(0x25, false, false, true), Some("back")); // Alt+Left
        assert_eq!(classify_key(0xBB, true, true, false), Some("zoomIn")); // Ctrl+Shift+=
        assert_eq!(classify_key(0x7B, false, false, false), Some("devtools")); // F12

        // Editing belongs to the page, and a bare letter is typing.
        for c in [b'C', b'V', b'X', b'A', b'Z'] {
            assert_eq!(ctrl(c), None);
        }
        assert_eq!(classify_key(u32::from(b'L'), false, false, false), None);
        assert_eq!(classify_key(0x25, false, false, false), None); // Left alone moves a caret
    }

    #[test]
    fn only_warnings_and_errors_reach_the_agent() {
        let entry = |level: &str| {
            format!(
                r#"{{"entry":{{"level":"{level}","text":"boom","url":"https://x.test/a.js"}}}}"#
            )
        };
        assert_eq!(
            parse_log_entry(&entry("error")),
            Some(("error".into(), "boom (https://x.test/a.js)".into()))
        );
        assert_eq!(
            parse_log_entry(&entry("warning")).map(|e| e.0),
            Some("warn".into())
        );
        assert_eq!(parse_log_entry(&entry("info")), None);
        assert_eq!(
            parse_log_entry(
                r#"{"entry":{"level":"warning","text":"Tracking Prevention blocked x"}}"#
            ),
            None
        );
        assert_eq!(parse_log_entry("not json"), None);
    }
}
