//! Browser panes: a raw `wry` webview per pane, placed by the host.
//!
//! WHAT A PANE IS. A native child webview on the same runtime the TEDI shell is
//! drawn with (WebView2), built straight with `wry` rather than through Tauri.
//! Nothing is downloaded and no second program runs, so a pane's page lives exactly
//! as long as the pane.
//!
//! WHY CORE OWNS THIS AT ALL, given the browser is an extension: only Rust can make
//! a child webview. These commands are the smallest thing core has to provide, and
//! `tedi.browser` drives them through `ctx.invoke`.
//!
//! WHAT A CHILD WEBVIEW COSTS, stated plainly, because the whole design is shaped
//! around it: it is a native child window, so it composites ABOVE everything the
//! app paints. wry raises it to the top of the z-order once at creation and never
//! touches z again. So anything the app draws over a browser pane - a menu, a
//! dialog, a canvas window stacked on top - has to be cut OUT of the webview rather
//! than drawn over it. That is what `holes` is, and it is why [`browser_place`]
//! takes bounds and holes in one call: a region is fixed in the window's own
//! coordinates and does not follow a resize.
//!
//! THE SECURITY QUESTION. A page in a pane must not reach the app, and the answer
//! is structural: a raw webview (`native.rs`) never receives Tauri's IPC bootstrap,
//! its invoke key or the app's custom protocols, so there is nothing for a page to
//! call. It also has no Tauri label, so no capability can name it.
//!
//! [`guard_url`] is a lesser layer: it keeps a pane from RENDERING one of the app's
//! own origins and keeps everything but http(s) out of an address bar and an
//! agent's reach. It sees top-level navigations only.

// `pub(crate)` for `mcp_devtools`, which drives the MAIN window the same way.
pub(crate) mod cdp;

#[cfg(target_os = "windows")]
mod blocker;
#[cfg(target_os = "windows")]
pub mod extensions;
#[cfg_attr(not(target_os = "windows"), path = "unsupported.rs")]
mod native;

use serde::{Deserialize, Serialize};
use tauri::Manager;

/// Every URI scheme the app registers. On Windows each is served at
/// `http://<scheme>.localhost` in the APP's own webviews, so a pane showing one of
/// those hosts would be showing something that looks like the app.
const APP_SCHEMES: [&str; 4] = ["tauri", "ipc", "asset", crate::modules::preview::SCHEME];

/// Extensions the profile holds, which are the only `chrome-extension:` hosts a pane
/// may show: an options page, a dashboard. Filled as the profile is read.
static INSTALLED: std::sync::Mutex<Option<std::collections::HashSet<String>>> =
    std::sync::Mutex::new(None);

fn is_installed(id: &str) -> bool {
    INSTALLED
        .lock()
        .is_ok_and(|set| set.as_ref().is_some_and(|set| set.contains(id)))
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn mark_installed(id: &str, installed: bool) {
    if let Ok(mut set) = INSTALLED.lock() {
        let set = set.get_or_insert_with(Default::default);
        if installed {
            set.insert(id.to_string());
        } else {
            set.remove(id);
        }
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

/// A rectangle in the coordinates a child webview's `set_bounds` speaks: PHYSICAL
/// pixels, relative to the parent window's client area.
///
/// Physical rather than logical because that is the one space both halves agree
/// on. The frontend measures in CSS pixels and multiplies by
/// `devicePixelRatio`; converting on this side would mean re-deriving a scale
/// factor the caller already knows exactly, and being wrong about it on a 125%
/// display misplaces the page by a quarter of the pane.
#[derive(Deserialize, Clone, Copy, Debug)]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
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

/// What a pane tells its toolbar, as it happens. See [`browser_watch`].
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub enum PaneEvent {
    /// The address, the title or whether it is loading moved.
    State {
        url: String,
        title: String,
        loading: bool,
    },
    /// The back/forward list changed.
    History,
    /// The page's icon as a `data:` url, empty when it has none.
    Icon { data: String },
    /// A user-initiated `target="_blank"`, `window.open` or "open in new window".
    NewWindow { url: String },
    /// A chord pressed while the page had focus, for the toolbar to act on.
    Key { action: String },
    /// Find-on-page counts. `active` is one-based, 0 for none.
    Find { matches: u32, active: u32 },
    /// A warning or error only the DevTools channel saw.
    Log { level: String, text: String },
    /// The webview's browser process died and the webview is gone with it.
    Gone,
}

/// Refuse a pane id that is not a short plain token. The extension mints it and it
/// comes back after a restart, so it is also a key in stored state.
fn check_id(pane_id: &str) -> Result<(), String> {
    let ok = !pane_id.is_empty()
        && pane_id.len() <= 64
        && pane_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(())
    } else {
        Err("pane id must be 1-64 chars of [A-Za-z0-9_-]".to_string())
    }
}

/// Where this browser keeps its profile and its unpacked extensions.
///
/// A DEDICATED PROFILE, NOT THE APP'S. On Windows, enabling browser extensions
/// is an ENVIRONMENT-level switch, and webviews that differ on it must use different
/// data directories. Sharing the app's directory would therefore either fail or drag
/// the app's own webview into the extension environment - and the app's webview is
/// the one holding Tauri IPC, which is the last place an installed extension should
/// be able to reach. Keeping cookies and logins out of the app's store is the second
/// reason and would have been enough on its own.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn data_dirs(app: &tauri::AppHandle) -> Option<(std::path::PathBuf, std::path::PathBuf)> {
    let base = app.path().app_data_dir().ok()?.join("browser");
    Some((base.join("profile"), base.join("extensions")))
}

/// Why a url cannot be opened in a browser pane, or `None` when it is fine.
///
/// `about:blank` is allowed because it is what a blank pane is. `data:` is NOT, even
/// though nothing about it reaches the app: it is a page the caller authors in full,
/// which is a phishing surface an address bar should not accept, and nothing here
/// needs it.
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
        "chrome-extension" if is_installed(parsed.host_str().unwrap_or("")) => return None,
        other => {
            return Some(format!(
                "refused: only http(s) can be opened here, got {other}:"
            ))
        }
    }
    // The app's own origins, in every shape they take. The dev server is the last
    // one, and only in a dev run (`dev_server`).
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
/// ONE COMMAND RATHER THAN FOUR, because the four are not independent. Bounds and
/// holes must move together (a window region does not follow a resize), and
/// visibility has to be applied after both or a pane that just came back on screen
/// flashes at its old size. The frontend calls this from a placement loop, so it is
/// also the hot path: an unchanged frame never gets here.
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
    check_id(&pane_id)?;
    native::place(app, window, pane_id, url, bounds, holes, visible).await
}

/// Close a pane's webview. Silent when there is none: a pane can be torn down
/// before it ever created one, and reporting that as an error would make every
/// caller handle a case that is not a failure.
#[tauri::command]
pub async fn browser_close(app: tauri::AppHandle, pane_id: String) -> Result<(), String> {
    check_id(&pane_id)?;
    native::close(app, pane_id).await
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
    check_id(&pane_id)?;
    if let Some(reason) = guard_url(&url, dev_server(&app).as_ref()) {
        return Err(reason);
    }
    url::Url::parse(url.trim()).map_err(|e| format!("not a url: {e}"))?;
    native::navigate(app, pane_id, url).await
}

/// Every open browser pane, with the address each one is actually on.
#[tauri::command]
pub async fn browser_list(app: tauri::AppHandle) -> Result<Vec<BrowserPane>, String> {
    native::list(app).await
}

/// Browser zoom, kept for a platform with no DevTools Protocol to pin the page's
/// metrics with. The lesser way to shrink a page: the CSS viewport really does get
/// wider as the factor drops, so a responsive site may re-lay-out.
#[tauri::command]
pub async fn browser_zoom(
    app: tauri::AppHandle,
    pane_id: String,
    factor: f64,
) -> Result<(), String> {
    check_id(&pane_id)?;
    native::zoom(app, pane_id, factor).await
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
    check_id(&pane_id)?;
    native::cdp(app, pane_id, method, params.unwrap_or_default()).await
}

/// Subscribe to a pane's [`PaneEvent`]s. The channel is how the toolbar stays
/// current without asking: a pane nobody is touching costs nothing.
#[tauri::command]
pub async fn browser_watch(
    app: tauri::AppHandle,
    pane_id: String,
    on_event: tauri::ipc::Channel<PaneEvent>,
) -> Result<(), String> {
    check_id(&pane_id)?;
    native::watch(app, pane_id, on_event).await
}

/// One step of find-on-page; counts come back as [`PaneEvent::Find`]. `query: None`
/// ends the search. Answers `false` when this runtime has no Find API.
#[tauri::command]
pub async fn browser_find(
    app: tauri::AppHandle,
    pane_id: String,
    query: Option<String>,
    forward: bool,
) -> Result<bool, String> {
    check_id(&pane_id)?;
    native::find(app, pane_id, query, forward).await
}

/// Hand the keyboard to the page, from the toolbar.
#[tauri::command]
pub async fn browser_focus(app: tauri::AppHandle, pane_id: String) -> Result<(), String> {
    check_id(&pane_id)?;
    native::focus(app, pane_id).await
}

/// Open DevTools for the pane's page.
#[tauri::command]
pub async fn browser_devtools(app: tauri::AppHandle, pane_id: String) -> Result<(), String> {
    check_id(&pane_id)?;
    native::devtools(app, pane_id).await
}

/// Set the ad and tracker blocker, for every pane: on or off, the sites it is paused
/// on, and what the person hid per site. The first time it goes on it reads or
/// downloads its lists (`blocker.rs`), in the background.
#[tauri::command]
pub async fn browser_blocker(
    app: tauri::AppHandle,
    enabled: bool,
    paused: Option<Vec<String>>,
    hides: Option<std::collections::HashMap<String, Vec<String>>>,
) -> Result<(), String> {
    native::set_blocker(
        &app,
        enabled,
        paused.unwrap_or_default(),
        hides.unwrap_or_default(),
    );
    Ok(())
}

/// How many requests the blocker refused for the page a pane is on.
#[tauri::command]
pub async fn browser_blocked_count(app: tauri::AppHandle, pane_id: String) -> Result<u32, String> {
    check_id(&pane_id)?;
    native::blocked_count(app, pane_id).await
}

#[cfg(test)]
mod tests {
    use super::{check_id, guard_url};

    #[test]
    fn every_registered_scheme_host_is_refused() {
        assert!(guard_url("http://tedi-frame.localhost/?u=aHR0cHM6Ly94", None).is_some());
        assert!(guard_url("http://ipc.localhost/pty_list_sessions", None).is_some());
        assert!(guard_url("http://x.tedi-frame.localhost./", None).is_some());
        // A dev server on a `.localhost` name of its own is somebody else's.
        assert!(guard_url("http://app.localhost:5173/", None).is_none());
        assert!(guard_url("http://localhost:3000/", None).is_none());
    }

    #[test]
    fn a_pane_id_is_a_short_plain_token() {
        assert!(check_id("b1").is_ok());
        assert!(check_id("").is_err());
        assert!(check_id("a/b").is_err());
        assert!(check_id("a b").is_err());
        assert!(check_id(&"x".repeat(65)).is_err());
    }

    #[test]
    fn the_apps_own_origin_is_refused() {
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
    fn an_extension_page_opens_only_for_an_installed_extension() {
        let id = "aaaabbbbccccddddeeeeffffgggghhhh";
        let url = format!("chrome-extension://{id}/options.html");
        assert!(guard_url(&url, None).is_some());
        super::mark_installed(id, true);
        assert!(guard_url(&url, None).is_none());
        // Installing one does not open the scheme.
        assert!(guard_url(
            "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/x",
            None
        )
        .is_some());
        super::mark_installed(id, false);
        assert!(guard_url(&url, None).is_some());
    }

    #[test]
    fn only_http_is_allowed_and_blank_pages_are_not_urls() {
        assert!(guard_url("file:///C:/Windows/win.ini", None).is_some());
        assert!(guard_url("javascript:alert(1)", None).is_some());
        assert!(guard_url("about:blank", None).is_none());
        // `data:` is refused: a page the caller authors in full is a phishing
        // surface, and nothing needs it.
        assert!(guard_url("data:text/html,<h1>hi</h1>", None).is_some());
        assert!(guard_url("", None).is_none());
        assert!(guard_url("https://example.com", None).is_none());
    }
}
