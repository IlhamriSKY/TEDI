//! Browser panes: a `wry` webview per pane, placed by the host.
//!
//! WHAT A PANE IS. A Tauri child webview, which is
//! [`wry`](https://github.com/tauri-apps/wry): WebView2 on Windows, WKWebView on
//! macOS, WebKitGTK on Linux. The same surface the TEDI shell itself is drawn
//! with. Nothing is downloaded and no second process runs, so a pane's page
//! lives exactly as long as the pane.
//!
//! WHY CORE OWNS THIS AT ALL, given the browser is an extension: only Rust can
//! call `Window::add_child`. These six commands are the smallest thing core has
//! to provide, and `tedi.browser` drives them through `ctx.invoke`.
//!
//! WHAT A CHILD WEBVIEW COSTS, stated plainly, because the whole design is
//! shaped around it: it is a native child window, so it composites ABOVE
//! everything the app paints, on every platform, by design. wry raises it to the
//! top of the z-order once at creation and never touches z again. So anything
//! the app draws over a browser pane - a menu, a dialog, a canvas window
//! stacked on top - has to be cut OUT of the webview rather than drawn over it.
//! That is what `holes` is, and it is why [`browser_place`] takes bounds and
//! holes in one call: a region is fixed in the window's own coordinates and does
//! not follow a resize, so the two must be recomputed together or a grown pane
//! stays clipped to its old shape.
//!
//! THE SECURITY QUESTION, and its first answer was WRONG. Tauri injects its IPC
//! bootstrap, invoke key included, into every webview it creates, and defines it
//! so no script can take it away again: a page in a browser pane really does
//! hold `window.__TAURI_INTERNALS__.invoke`. Three things stand between that page
//! and the app:
//!
//!   1. **Every app command refuses a pane by LABEL** ([`refuse_browser_panes`],
//!      wrapped around the whole `invoke_handler`). This is the boundary.
//!      Capabilities were believed to be, and are not: with no app ACL manifest,
//!      Tauri checks an app command against them only for a REMOTE origin
//!      (`tauri-2.11.5/src/webview/mod.rs:1823`), and a page can reach a local
//!      one. On Windows `http://tedi-frame.localhost` is local, because
//!      `tedi-frame` is a registered scheme, and that proxy serves any page's
//!      HTML - so a site could frame itself through it and call
//!      `shell_run_command`.
//!   2. **Capabilities are scoped by WEBVIEW label** (`capabilities/*.json` list
//!      `webviews`, not `windows`). That is what refuses PLUGIN commands, which
//!      Tauri checks whatever the origin, and `browser-*` matches no capability.
//!      A capability listing `windows` would reach every webview of the window,
//!      pane included.
//!   3. **The pane's IPC is cut at the engine** ([`harden`]), before it
//!      navigates anywhere. The one command Tauri exempts from EVERY check,
//!      `plugin:__TAURI_CHANNEL__|fetch`, reads large channel payloads (terminal
//!      output, SSH, a scrollback replay) out of one app-wide queue by
//!      sequential id, so without the cut any page could race the app for them.
//!      Only WebView2 offers that cut, which is why panes are Windows only
//!      ([`create`]).
//!
//! [`guard_url`] is a fourth and lesser layer: it keeps a pane from RENDERING
//! one of the app's own origins and keeps everything but http(s) out of an
//! agent's reach. It sees top-level navigations only, so it could never have
//! covered an iframe on its own.

mod cdp;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Webview labels this module mints: `browser-<pane id>`.
const LABEL_PREFIX: &str = "browser-";

/// Every URI scheme the app registers. On Windows each is served at
/// `http://<scheme>.localhost`, and Tauri counts every such host as a LOCAL
/// origin. `asset` is not enabled today; it is listed so that turning it on
/// cannot quietly open a local origin to a pane.
const APP_SCHEMES: [&str; 4] = ["tauri", "ipc", "asset", crate::modules::preview::SCHEME];

const NOT_ON_THIS_PLATFORM: &str = "browser panes are Windows only in this version: \
     WKWebView and WebKitGTK offer no way to cut a page off from TEDI's IPC";

/// Whether this run's panes have browser extensions on. Decided by the FIRST
/// pane and kept for every pane after it.
///
/// It is a WebView2 ENVIRONMENT option and every pane shares one profile
/// directory, and WebView2 refuses to build a webview whose environment options
/// differ from one already running on that directory. Deciding it per pane, from
/// what the folder held at that moment, made "drop an extension in, open another
/// pane" fail to create the pane while the first was still up. So an extension
/// added while TEDI runs loads after a restart.
static EXTENSIONS_ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Whether a webview label is a browser pane's.
pub fn is_pane_label(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

/// Wrap the app's `invoke_handler` so that no app command answers a browser pane.
///
/// THE ONE PLACE EVERY APP COMMAND PASSES THROUGH, which is why the check lives
/// here rather than in each of them. A pane's page has no business calling any:
/// the extension that drives a pane runs in the MAIN webview and reaches the page
/// through the host (`browser_cdp`), never from inside it. See the module header
/// for why capabilities could not do this.
pub fn refuse_browser_panes<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if is_pane_label(invoke.message.webview_ref().label()) {
            invoke
                .resolver
                .reject("TEDI's commands are not available to a page in a browser pane");
            return true;
        }
        handler(invoke)
    }
}

/// The dev server's url, and only in a dev run.
///
/// `build.dev_url` is compiled into EVERY build, release included, so reading it
/// unconditionally refused `http://localhost:1420` in the shipped app: nobody's
/// TEDI lives there, and it is the default port of every other Tauri project a
/// user might be building.
fn dev_server(app: &tauri::AppHandle) -> Option<url::Url> {
    if tauri::is_dev() {
        app.config().build.dev_url.clone()
    } else {
        None
    }
}

/// A rectangle in the coordinates Tauri's `set_bounds` speaks for a child
/// webview: PHYSICAL pixels, relative to the parent window's client area.
///
/// Physical rather than logical because that is the one space both halves agree
/// on. The frontend measures in CSS pixels and multiplies by
/// `devicePixelRatio`; converting on this side would mean re-deriving a scale
/// factor the caller already knows exactly, and being wrong about it on a 125%
/// display misplaces the page by a quarter of the pane.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct BrowserRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// One open browser pane, as the agent and the tab strip see it.
#[derive(Serialize, Clone, Debug)]
pub struct BrowserPane {
    pub pane_id: String,
    pub url: String,
}

/// The webview label for a pane, and the check that makes it safe to build one.
///
/// The caller names its own panes: this module is driven by the browser
/// extension, which mints a stable key per pane and needs the same key to reach
/// the same webview after a restart. That key becomes a Tauri webview LABEL, and
/// a label is not a free-form string - it addresses a webview and ends up in a
/// URL - so anything outside a conservative alphabet is refused here rather than
/// sanitised into a different pane's label.
fn label_of(pane_id: &str) -> Result<String, String> {
    let ok = !pane_id.is_empty()
        && pane_id.len() <= 64
        && pane_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if !ok {
        return Err("pane id must be 1-64 chars of [A-Za-z0-9_-]".to_string());
    }
    Ok(format!("{LABEL_PREFIX}{pane_id}"))
}

/// Where this browser keeps its profile and its unpacked extensions.
///
/// A DEDICATED PROFILE, NOT THE APP'S. On Windows, enabling browser extensions
/// is an ENVIRONMENT-level switch, and Tauri's own documentation requires
/// webviews that differ on it to use different data directories. Sharing the
/// app's directory would therefore either fail or drag the app's own webview
/// into the extension environment - and the app's webview is the one holding
/// Tauri IPC, which is the last place an installed extension should be able to
/// reach. Keeping cookies and logins out of the app's store is the second
/// reason and would have been enough on its own.
fn data_dirs(app: &tauri::AppHandle) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let base = app.path().app_data_dir().ok()?.join("browser");
    Some((base.join("profile"), base.join("extensions")))
}

/// Unpacked extension folders to hand the webview, or `None` when there are
/// none worth handing.
///
/// EMPTY MEANS NONE, AND THAT MATTERS. wry passes every direct child of the
/// path to `AddBrowserExtension` with no filter of its own, so a stray file
/// would be offered to WebView2 as an extension. Worse, naming the path at all
/// flips the webview onto the extension environment; doing that for a directory
/// with nothing in it pays the whole cost for no extension. So the directory
/// counts only if it holds at least one folder with a `manifest.json`.
fn unpacked_extensions(dir: &std::path::Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        e.file_type().map(|t| t.is_dir()).unwrap_or(false)
            && e.path().join("manifest.json").is_file()
    })
}

/// Why a url cannot be opened in a browser pane, or `None` when it is fine.
///
/// NOT THE BOUNDARY, though it once said it was: a navigation guard sees only
/// top-level navigations, so an iframe walks straight past it. What actually
/// refuses a page is in the module header. This keeps a pane from RENDERING one
/// of the app's own origins and keeps everything but http(s) out of an address
/// bar and an agent's reach.
///
/// `about:blank` is allowed because it is what a blank pane is. `data:` is NOT,
/// even though its origin is opaque and reaches no IPC: it is a page the caller
/// authors in full, which is a phishing surface an address bar should not
/// accept, and nothing here needs it.
fn guard_url(url: &str, dev: Option<&url::Url>) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() || trimmed == "about:blank" {
        return None;
    }
    let Ok(parsed) = url::Url::parse(trimmed) else {
        return Some(format!("not a url: {trimmed}"));
    };
    match parsed.scheme() {
        "http" | "https" => {}
        other => {
            return Some(format!(
                "refused: only http(s) can be opened here, got {other}:"
            ))
        }
    }
    // The app's own origins, in every shape they take. On Windows each scheme the
    // app registers is served at `http://<scheme>.localhost` and Tauri counts
    // every such host as LOCAL: `tauri` is the app itself, and `tedi-frame` is the
    // preview proxy, which serves ANY page's HTML under that local origin.
    // Elsewhere they are schemes of their own, refused by the http(s) test above.
    // The dev server is the last one, and only in a dev run (`dev_server`).
    // TRAILING DOTS COME OFF FIRST. `tauri.localhost.` is the same host in DNS
    // and the `url` crate keeps the dot verbatim, so without this the comparison
    // below misses it, one keystroke from a bypass.
    let host = parsed
        .host_str()
        .unwrap_or("")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let app_host = host
        .strip_suffix(".localhost")
        .and_then(|rest| rest.rsplit('.').next())
        .is_some_and(|scheme| APP_SCHEMES.contains(&scheme));
    if app_host {
        return Some("refused: that is one of TEDI's own origins".to_string());
    }
    if let Some(dev) = dev {
        if dev
            .host_str()
            .map(|h| h.eq_ignore_ascii_case(host.as_str()))
            == Some(true)
            && dev.port_or_known_default() == parsed.port_or_known_default()
        {
            return Some("refused: that is TEDI's own dev server".to_string());
        }
    }
    None
}

/// Create the pane's webview if it is not there yet, then put it where the pane
/// says, cut the holes the pane asks for, and show or hide it.
///
/// ONE COMMAND RATHER THAN FOUR, because the four are not independent. Bounds
/// and holes must move together (a window region does not follow a resize), and
/// visibility has to be applied after both or a pane that just came back on
/// screen flashes at its old size. The frontend calls this from a placement
/// loop, so it is also the hot path: everything it does is idempotent and cheap
/// when nothing moved.
#[tauri::command]
pub async fn browser_place(
    app: tauri::AppHandle,
    window: tauri::Window,
    pane_id: String,
    url: String,
    bounds: BrowserRect,
    holes: Vec<BrowserRect>,
    visible: bool,
) -> Result<(), String> {
    let label = label_of(&pane_id)?;

    let webview = match app.get_webview(&label) {
        Some(existing) => existing,
        None => {
            // GUARDED HERE, NOT AT THE TOP, and that placement is the whole
            // point. `url` is used ONLY to create the webview; every later call
            // carries the page's CURRENT address so the caller has something to
            // pass, and a page legitimately ends up on `blob:` or an engine
            // error page. Refusing the whole placement for that froze the pane
            // at its last rectangle while it went on compositing over the app.
            if let Some(reason) = guard_url(&url, dev_server(&app).as_ref()) {
                return Err(reason);
            }
            create(&app, &window, &label, &url).await?
        }
    };

    // POSITION BEFORE VISIBILITY. A webview that is being shown again was left
    // wherever it was when it was hidden, and showing it first paints one frame
    // at the stale rectangle - which on a tab switch is the previous tab's pane.
    webview
        .set_bounds(tauri::Rect {
            position: tauri::PhysicalPosition::new(bounds.x, bounds.y).into(),
            size: tauri::PhysicalSize::new(bounds.width.max(1), bounds.height.max(1)).into(),
        })
        .map_err(|e| format!("could not place the browser pane: {e}"))?;

    clip(&webview, bounds, &holes);

    if visible {
        webview.show().map_err(|e| e.to_string())?;
    } else {
        webview.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Take a pane off the app: WebView2's browser keys, and both of Tauri's IPC
/// routes.
///
/// THE KEYS. WebView2 treats Ctrl+W, Ctrl+N, Ctrl+P, Ctrl+R and F5 as BROWSER
/// shortcuts and acts on them before web content can cancel them. `lib.rs`
/// already turns that off for the app's own webview, and the reason recorded
/// there is exact: Ctrl+W closed the whole window. `ICoreWebView2Settings` is
/// per-CoreWebView2, so that fix does not reach a pane, and a pane is the one
/// place a user is MOST likely to press Ctrl+W, because it looks like a browser.
/// Ctrl+R and F5 are worth losing too: reload belongs to the pane's own toolbar
/// button, which goes through CDP and keeps the pane's state consistent.
///
/// THE IPC, which is the part that matters. Tauri hands every webview its
/// bootstrap and invoke key and defines both so no script can remove them, so
/// the routes are cut underneath instead:
///  - the custom-protocol filters wry registered are removed (its own spelling,
///    `<http>://<scheme>.*`), so `http://ipc.localhost/...` is an ordinary
///    request to a loopback port instead of a call into the host, and no
///    registered scheme host can lend a page a local origin;
///  - web messages are switched off, the postMessage route Tauri falls back to
///    when that fetch fails.
///
/// Each failure is ignored on its own: a filter wry never registered (the
/// `https` spelling, a scheme this build does not have) is simply not there.
#[cfg(target_os = "windows")]
fn harden(webview: &tauri::Webview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Settings3, ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
    };
    use windows::core::{Interface, HSTRING};
    let _ = webview.with_webview(|platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        if let Ok(settings) = core.Settings() {
            let _ = settings.SetIsWebMessageEnabled(false);
            if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
            }
        }
        // The same fork wry takes when it ADDS them: a filter added with request
        // source kinds only comes off the same way.
        let core22 = core.cast::<ICoreWebView2_22>().ok();
        for scheme in APP_SCHEMES {
            for http in ["http", "https"] {
                let filter = HSTRING::from(format!("{http}://{scheme}.*"));
                let _ = match &core22 {
                    Some(core22) => core22.RemoveWebResourceRequestedFilterWithRequestSourceKinds(
                        &filter,
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                        COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                    ),
                    None => core.RemoveWebResourceRequestedFilter(
                        &filter,
                        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    ),
                };
            }
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn harden(_webview: &tauri::Webview) {}

/// Build the child webview for a pane.
///
/// Split out because it runs once per pane and the placement path runs sixty
/// times a second; folding it inline would put a builder, a profile lookup and
/// an extension scan on the hot path for a branch that is almost never taken.
///
/// WINDOWS ONLY, deliberately. The one answer to the channel-data command in
/// the module header is cutting a pane's IPC out at the engine, and only
/// WebView2 offers that cut. On WKWebView and WebKitGTK a hostile page would get
/// a shot at every large stream the app has, so there is no pane there until
/// they can be cut off too. `cfg!` rather than `#[cfg]` so the whole path still
/// compiles, and is linted, on every target.
async fn create(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    label: &str,
    url: &str,
) -> Result<tauri::Webview, String> {
    if !cfg!(target_os = "windows") {
        return Err(NOT_ON_THIS_PLATFORM.to_string());
    }
    let first = match url.trim() {
        "" | "about:blank" => None,
        target => Some(url::Url::parse(target).map_err(|e| format!("not a url: {e}"))?),
    };
    // Cloned into the handler: it outlives this function and cannot borrow the
    // app's config.
    let dev_url = dev_server(app);
    let blank = url::Url::parse("about:blank").map_err(|e| e.to_string())?;

    // BORN BLANK, and the page follows once `harden` has run. A pane created
    // straight onto its page could run that page's scripts before the cut
    // landed, which is exactly the window a hostile page needs.
    let mut builder = tauri::webview::WebviewBuilder::new(label, tauri::WebviewUrl::External(blank))
        // EVERY NAVIGATION, not just the two commands. A link click, a
        // `location.href =`, a redirect: none of them pass through
        // `browser_navigate`, and the module header's whole security argument
        // rests on a browsed page never having a LOCAL origin. Guarding only the
        // entry points would leave one redirect between a page and the app's own
        // command surface.
        .on_navigation(move |url| guard_url(url.as_str(), dev_url.as_ref()).is_none())
        // NOT FOCUSED ON CREATE. wry's default is to move focus into a webview
        // the moment it exists, which for a pane opened behind the user - by the
        // agent, or by restoring a workspace - takes the keyboard out of
        // whatever they were typing into.
        .focused(false)
        // The DevTools Protocol is what the whole agent surface rides on
        // (`cdp.rs`). Asking for devtools explicitly keeps that available in a
        // release build rather than only where debug assertions are on.
        .devtools(true)
        // Off unless the profile held an unpacked extension when this run's
        // first pane opened; see `unpacked_extensions` and `EXTENSIONS_ON`.
        .browser_extensions_enabled(false)
        .zoom_hotkeys_enabled(true);

    if let Some((profile, extensions)) = data_dirs(app) {
        let _ = std::fs::create_dir_all(&profile);
        // MADE EVEN THOUGH IT MAY STAY EMPTY, because it is the one thing here
        // a user is asked to find by hand. The README tells them to drop an
        // unpacked extension into this path; if nothing ever creates it they
        // are typing a path from a document into a file manager and cannot tell
        // a wrong guess from an extension that failed to load - and a failed
        // load is silent, since wry hands WebView2 every entry with a
        // completion handler that discards the result.
        let _ = std::fs::create_dir_all(&extensions);
        builder = builder.data_directory(profile);
        if *EXTENSIONS_ON.get_or_init(|| unpacked_extensions(&extensions)) {
            builder = builder
                .browser_extensions_enabled(true)
                .extensions_path(extensions);
        }
    }

    // `add_child` hops to the main thread and BLOCKS on the answer, which is why
    // every caller of this is an async command: Tauri documents the same call
    // as deadlocking from a synchronous command or an event handler.
    let webview = window
        .add_child(
            builder,
            tauri::PhysicalPosition::new(0, 0),
            tauri::PhysicalSize::new(1u32, 1u32),
        )
        .map_err(|e| format!("could not create the browser pane: {e}"))?;
    // Both of these queue onto the main thread, in this order, so the page
    // cannot begin loading ahead of the cut.
    harden(&webview);
    if let Some(first) = first {
        webview
            .navigate(first)
            .map_err(|e| format!("could not open the page: {e}"))?;
    }
    Ok(webview)
}

/// Cut `holes` out of the pane's webview so what the app draws over it is
/// visible AND clickable, with the page still live underneath.
///
/// Windows only, and the fallback is the caller's: everywhere else there is no
/// window region, so the frontend hides the whole webview while an overlay
/// covers it. That is worse and it is the only lever those platforms have.
#[cfg(target_os = "windows")]
fn clip(webview: &tauri::Webview, bounds: BrowserRect, holes: &[BrowserRect]) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_DIFF,
    };

    let holes: Vec<BrowserRect> = holes.to_vec();
    let _ = webview.with_webview(move |platform| unsafe {
        let mut hwnd = HWND::default();
        // wry keeps no HWND accessor, so the controller's parent window IS the
        // container it created. This is the same route wry itself takes
        // internally, and the only supported one.
        if platform.controller().ParentWindow(&mut hwnd).is_err() || hwnd.is_invalid() {
            return;
        }
        if holes.is_empty() {
            // A NULL region means no clip at all, which is both cheaper than a
            // full-size one and what "the pane is whole" actually means.
            SetWindowRgn(hwnd, None, true);
            return;
        }
        let whole = CreateRectRgn(0, 0, bounds.width.max(1), bounds.height.max(1));
        for h in &holes {
            let hole = CreateRectRgn(h.x, h.y, h.x + h.width, h.y + h.height);
            CombineRgn(Some(whole), Some(whole), Some(hole), RGN_DIFF);
            let _ = DeleteObject(hole.into());
        }
        // The SYSTEM OWNS the region once this succeeds, so it must not be
        // deleted here - and must be deleted if it does not.
        if SetWindowRgn(hwnd, Some(whole), true) == 0 {
            let _ = DeleteObject(whole.into());
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn clip(_webview: &tauri::Webview, _bounds: BrowserRect, _holes: &[BrowserRect]) {}

/// Close a pane's webview. Silent when there is none: a pane can be torn down
/// before it ever created one, and reporting that as an error would make every
/// caller handle a case that is not a failure.
#[tauri::command]
pub async fn browser_close(app: tauri::AppHandle, pane_id: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label_of(&pane_id)?) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Navigate a pane that already exists.
///
/// Separate from [`browser_place`] because that one is called from a placement
/// loop and must not re-navigate sixty times a second; the url it carries is
/// only ever used for the FIRST creation.
#[tauri::command]
pub async fn browser_navigate(
    app: tauri::AppHandle,
    pane_id: String,
    url: String,
) -> Result<(), String> {
    if let Some(reason) = guard_url(&url, dev_server(&app).as_ref()) {
        return Err(reason);
    }
    let webview = app
        .get_webview(&label_of(&pane_id)?)
        .ok_or_else(|| "no open browser pane with that id".to_string())?;
    let parsed = url::Url::parse(url.trim()).map_err(|e| format!("not a url: {e}"))?;
    webview.navigate(parsed).map_err(|e| e.to_string())
}

/// Every open browser pane, with the address each one is actually on.
///
/// THE ADDRESS IS THE POINT, and it is why this exists on every platform rather
/// than only where the DevTools Protocol does: the frontend otherwise reads
/// `location.href` out of the page over CDP, which WKWebView and WebKitGTK do
/// not have. Without this the address bar there could not follow a link click
/// and a restored pane could not come back on the page it was left on.
#[tauri::command]
pub async fn browser_list(app: tauri::AppHandle) -> Result<Vec<BrowserPane>, String> {
    let mut out = Vec::new();
    for (label, webview) in app.webviews() {
        let Some(pane_id) = label.strip_prefix(LABEL_PREFIX) else {
            continue;
        };
        out.push(BrowserPane {
            pane_id: pane_id.to_string(),
            url: webview.url().map(|u| u.to_string()).unwrap_or_default(),
        });
    }
    out.sort_by(|a, b| a.pane_id.cmp(&b.pane_id));
    Ok(out)
}

/// Scale a pane's page, for the canvas view on platforms with no DevTools
/// Protocol.
///
/// TWO WAYS TO SHRINK A PAGE, and this is the lesser one. Where CDP exists the
/// pane pins `Emulation.setDeviceMetricsOverride`, which keeps the CSS viewport
/// at the pane's own logical size and changes only the rasterisation scale - so
/// a canvas-zoomed page is pixel-for-pixel the page you would see at 100%, just
/// smaller, and a responsive site never crosses a breakpoint because of a zoom
/// gesture.
///
/// `set_zoom` is browser zoom: the CSS viewport really does get wider as the
/// factor drops, so a responsive site may re-lay-out. That is a visible
/// difference and it is still far better than the alternative on macOS and
/// Linux, which is a webview placed at the on-screen box laying the page out for
/// a 360px viewport and handing back a phone layout.
///
/// Works on all three platforms (macOS 11+ / iOS 14+ per Tauri), which is the
/// whole reason it is here.
#[tauri::command]
pub async fn browser_zoom(
    app: tauri::AppHandle,
    pane_id: String,
    factor: f64,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label_of(&pane_id)?)
        .ok_or_else(|| "no open browser pane with that id".to_string())?;
    // Clamped rather than trusted: the caller derives this from a CSS transform
    // and a zero or a negative would be a blank pane with no error anywhere.
    let factor = factor.clamp(0.1, 5.0);
    webview.set_zoom(factor).map_err(|e| e.to_string())
}

/// One DevTools Protocol call against a pane. See `cdp.rs` for why this is the
/// whole agent surface rather than a command per verb.
#[tauri::command]
pub async fn browser_cdp(
    app: tauri::AppHandle,
    pane_id: String,
    method: String,
    params: Option<String>,
) -> Result<String, String> {
    cdp::call(
        &app,
        &label_of(&pane_id)?,
        &method,
        params.as_deref().unwrap_or("{}"),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{guard_url, is_pane_label, label_of};

    #[test]
    fn every_registered_scheme_host_is_refused() {
        // Tauri counts `http://<scheme>.localhost` as a LOCAL origin for every
        // scheme the app registers, and the proxy scheme serves any page's HTML.
        assert!(guard_url("http://tedi-frame.localhost/?u=aHR0cHM6Ly94", None).is_some());
        assert!(guard_url("http://ipc.localhost/pty_list_sessions", None).is_some());
        assert!(guard_url("http://x.tedi-frame.localhost./", None).is_some());
        // A dev server on a `.localhost` name of its own is somebody else's.
        assert!(guard_url("http://app.localhost:5173/", None).is_none());
        assert!(guard_url("http://localhost:3000/", None).is_none());
    }

    #[test]
    fn a_pane_is_told_apart_by_its_label_alone() {
        assert!(is_pane_label(&label_of("b1").unwrap()));
        assert!(!is_pane_label("main"));
        assert!(!is_pane_label("settings"));
        assert!(!is_pane_label("float-3"));
    }

    #[test]
    fn a_pane_id_may_not_smuggle_anything_into_a_webview_label() {
        assert!(label_of("b1").is_ok());
        assert!(label_of("").is_err());
        assert!(label_of("a/b").is_err());
        assert!(label_of("a b").is_err());
        assert!(label_of(&"x".repeat(65)).is_err());
    }

    #[test]
    fn the_apps_own_origin_is_refused() {
        // The one check that is not hygiene: a local origin resolves the app's
        // capabilities for real, so a page there would hold the command surface.
        assert!(guard_url("http://tauri.localhost/index.html", None).is_some());
        assert!(guard_url("https://tauri.localhost", None).is_some());
        // Same host in DNS, and the `url` crate hands the dot straight through.
        assert!(guard_url("http://tauri.localhost./index.html", None).is_some());
        assert!(guard_url("http://TAURI.LOCALHOST./", None).is_some());
        // A different host that merely starts the same way is somebody else.
        assert!(guard_url("https://tauri.localhost.example.com", None).is_none());
        // And the dev server, which is where a dev build serves the REAL app.
        let dev = url::Url::parse("http://localhost:1420").unwrap();
        assert!(guard_url("http://localhost:1420/index.html", Some(&dev)).is_some());
        // A different port on the same host is somebody else's dev server.
        assert!(guard_url("http://localhost:3000", Some(&dev)).is_none());
    }

    #[test]
    fn only_http_is_allowed_and_blank_pages_are_not_urls() {
        assert!(guard_url("file:///C:/Windows/win.ini", None).is_some());
        assert!(guard_url("javascript:alert(1)", None).is_some());
        assert!(guard_url("about:blank", None).is_none());
        // `data:` is refused: an opaque origin reaches no IPC, but a page the
        // caller authors in full is a phishing surface, and nothing needs it.
        assert!(guard_url("data:text/html,<h1>hi</h1>", None).is_some());
        assert!(guard_url("", None).is_none());
        assert!(guard_url("https://example.com", None).is_none());
    }
}
