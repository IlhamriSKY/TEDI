// `pub` so the `tedi-cli` workspace member's stub binary
// (src-tauri/tedi-cli/src/main.rs) can reach `cli::help_text()` and the
// version constants - keeps the help text single-sourced between the GUI
// binary and the launcher.
// Process-wide allocator (GUI + the `--pty-daemon` sidecar share this binary).
// The default Windows system heap holds onto freed commit when a workload is
// bursty and fragmented - which is exactly the host process's job of buffering
// heavy PTY output (large base64 chunks) on its way to the webview. A single
// flood (a dev server, an AI CLI redrawing, a big build) inflates the commit to
// several GB and the heap never gives it back, so the process "stays at ~1 GB"
// long after the burst (a high-watermark, not a live leak: trimming the working
// set drops resident pages to a few MB while the committed bytes stay put).
// mimalloc purges freed segments back to the OS on a timer, so the watermark
// recedes once the burst ends.
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

/// How often [`purge_allocator`] runs. Long enough that the sweep is free in
/// aggregate, short enough that a burst is handed back while the user is still
/// in the same sitting.
const ALLOCATOR_PURGE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Hand freed-but-still-committed pages back to the OS.
///
/// Swapping the system heap for mimalloc (v0.3.76) was supposed to make the
/// commit recede on its own, and measurement says it does not: on a normal
/// working session the GUI host went 1.1 GB at 3 min, 7.0 GB at 20 min and
/// 15.8 GB at 64 min, while its working set stayed under 6 GB and dropped to
/// 24 MB under `EmptyWorkingSet` without climbing back. So the bulk of it was
/// committed, freed, untouched, and still charged against the system commit
/// limit, which was already at 32.8 of 44.1 GB. mimalloc only purges a segment
/// that happens to fall entirely free, and a bursty producer (the PTY -> webview
/// path buffers large base64 chunks) strands committed pages across many
/// partly-used segments, so the process commit only ever ratchets up.
///
/// `mi_collect(true)` forces the sweep that the timer-driven purge misses.
/// `libmimalloc-sys` at this version exposes no `mi_option_purge_delay`
/// constant, so this is the available lever; see the test at the bottom of this
/// file for the measured before/after.
pub fn purge_allocator() {
    // SAFETY: `mi_collect` takes no pointers, is documented thread-safe, and is
    // a no-op when there is nothing to reclaim.
    unsafe { libmimalloc_sys::mi_collect(true) };
}

/// Run [`purge_allocator`] on a timer, off the UI thread. Deliberately its own
/// thread rather than a Tauri async task: the sweep walks the heap, and the one
/// thing it must never do is share a thread with anything that draws.
fn spawn_allocator_purge_thread() {
    let _ = std::thread::Builder::new()
        .name("tedi-alloc-purge".into())
        .spawn(|| loop {
            std::thread::sleep(ALLOCATOR_PURGE_INTERVAL);
            purge_allocator();
        });
}

pub mod modules;

/// Version string this crate was compiled against. Re-exposed so the
/// `tedi-cli` launcher (which has its own `CARGO_PKG_VERSION` for the
/// `tedi-cli` package) can print the GUI crate's version instead and
/// stay in sync without a duplicate version constant.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

use modules::{
    backup, cli, cli_ext, cli_theme, cli_update, clipboard, extensions, format, fs, git, mcp, net,
    preview, pty, pty_daemon, secrets, shell, ssh,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

/// Force square corners on Windows 11. DWM paints an 8 px corner radius on
/// every top-level window even with `decorations: false` and `transparent: true`,
/// which leaves a transparent halo over our square webview. DWMWCP_DONOTROUND
/// keeps the OS corners sharp so the CSS border is the only frame.
#[cfg(target_os = "windows")]
fn disable_windows_corner_rounding(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as HWND;
    let pref: u32 = DWMWCP_DONOTROUND as u32;
    // SAFETY: hwnd is a valid window handle owned by Tauri for this call;
    // pref is a stack value passed by pointer with its size.
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &pref as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[cfg(not(target_os = "windows"))]
fn disable_windows_corner_rounding(_window: &tauri::WebviewWindow) {}

/// Make a borderless (`decorations: false`) window behave like a normal app on
/// Windows. Two defects come from dropping the native frame:
///
///   1. **Maximize covers the taskbar.** Windows only auto-clamps a maximized
///      window to the monitor *work area* when it carries a standard frame
///      (`WS_THICKFRAME` + `WS_CAPTION`). A borderless window instead fills the
///      whole monitor, so it runs off the bottom over the taskbar - and an
///      OS-level window screenshot then faithfully captures a window that
///      genuinely extends to the bottom of the screen.
///   2. **Taskbar button can't minimize.** Without `WS_MINIMIZEBOX`, clicking
///      the app's taskbar button does not toggle minimize the way every other
///      window does (only the in-app control works).
///
/// Both are fixed without re-adding any visible chrome (`WS_CAPTION` /
/// `WS_SYSMENU` stay off, so no title bar or system buttons are painted):
///   - re-add `WS_MINIMIZEBOX | WS_MAXIMIZEBOX` so the taskbar button and Aero
///     Snap work, and
///   - subclass the window proc to clamp `WM_GETMINMAXINFO`'s maximized rect to
///     the current monitor's work area. The original proc is called first so
///     TAO's `min_inner_size` enforcement (also delivered via this message) is
///     preserved; only the maximized position/size are overridden.
#[cfg(target_os = "windows")]
fn apply_windows_frame_fixes(window: &tauri::WebviewWindow) {
    use std::sync::atomic::{AtomicIsize, Ordering};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, GetWindowLongPtrW, SetWindowLongPtrW, GWLP_WNDPROC,
        GWL_STYLE, MINMAXINFO, WM_GETMINMAXINFO, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
    };

    // Single main window, so one slot for the original proc is enough.
    static PREV_WNDPROC: AtomicIsize = AtomicIsize::new(0);

    unsafe extern "system" fn wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        let prev = PREV_WNDPROC.load(Ordering::Relaxed);
        let call_prev = |hwnd, msg, wparam, lparam| {
            if prev != 0 {
                let prev_proc: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT =
                    std::mem::transmute(prev);
                CallWindowProcW(Some(prev_proc), hwnd, msg, wparam, lparam)
            } else {
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
        };

        if msg == WM_GETMINMAXINFO {
            // Let the original proc fill defaults first (TAO enforces the
            // window's minimum size here), then clamp the maximized rect.
            let result = call_prev(hwnd, msg, wparam, lparam);
            let h_monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut mi: MONITORINFO = std::mem::zeroed();
            mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            if GetMonitorInfoW(h_monitor, &mut mi) != 0 {
                let work: RECT = mi.rcWork;
                let mon: RECT = mi.rcMonitor;
                let info = &mut *(lparam as *mut MINMAXINFO);
                // ptMaxPosition is relative to the monitor origin.
                info.ptMaxPosition.x = work.left - mon.left;
                info.ptMaxPosition.y = work.top - mon.top;
                info.ptMaxSize.x = work.right - work.left;
                info.ptMaxSize.y = work.bottom - work.top;
            }
            return result;
        }

        call_prev(hwnd, msg, wparam, lparam)
    }

    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as HWND;

    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        let new_style = style | (WS_MINIMIZEBOX as isize) | (WS_MAXIMIZEBOX as isize);
        if new_style != style {
            SetWindowLongPtrW(hwnd, GWL_STYLE, new_style);
        }

        // Install the subclass once; re-running would chain it onto itself.
        if PREV_WNDPROC.load(Ordering::Relaxed) == 0 {
            let prev = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, wndproc as *const () as isize);
            PREV_WNDPROC.store(prev, Ordering::Relaxed);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_windows_frame_fixes(_window: &tauri::WebviewWindow) {}

/// Disable WebView2 "browser accelerator keys" on the MAIN webview. By default
/// WebView2 treats Ctrl+W (close window), Ctrl+N/T, Ctrl+P, Ctrl+R/F5, etc. as
/// browser shortcuts and acts on them BEFORE web content can cancel them with
/// `preventDefault` - so Ctrl+W closed the whole window (quitting the app)
/// instead of running the app's own close-tab shortcut. TEDI is an app shell,
/// not a browser, so the app's keyboard handlers should own those combos. The
/// in-app browser child webview is a separate webview and keeps its own defaults.
#[cfg(target_os = "windows")]
fn disable_browser_accelerator_keys(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows::core::Interface;
    let _ = window.with_webview(|platform| unsafe {
        let Ok(core) = platform.controller().CoreWebView2() else {
            return;
        };
        let Ok(settings) = core.Settings() else {
            return;
        };
        let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() else {
            return;
        };
        let _ = settings3.SetAreBrowserAcceleratorKeysEnabled(false);
    });
}

#[cfg(not(target_os = "windows"))]
fn disable_browser_accelerator_keys(_window: &tauri::WebviewWindow) {}

#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    let url_path = match tab.as_deref() {
        Some(t) if !t.is_empty() => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    // Freshly built windows carry the tab in `url_path`; a revealed existing
    // window won't re-read the URL, so it gets the tab pushed via event.
    if open_or_reveal_child(
        &app,
        "settings",
        url_path,
        "Settings",
        (880.0, 620.0),
        (600.0, 480.0),
    )?
    .is_none()
    {
        if let Some(t) = tab.as_deref().filter(|s| !s.is_empty()) {
            if let Some(window) = app.get_webview_window("settings") {
                // emit() serializes via JSON, so no string-escape footgun.
                let _ = window.emit(crate::modules::events::SETTINGS_TAB, t);
            }
        }
    }
    Ok(())
}

/// Center a child window over the main window (so it follows the user across
/// monitors instead of landing on the primary display). No-op if either
/// window's geometry can't be read. Shared by the Settings and Debug windows.
fn recenter_over_main(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(main_pos), Ok(main_size), Ok(win_size)) = (
            main.outer_position(),
            main.outer_size(),
            window.outer_size(),
        ) {
            let x = main_pos.x + (main_size.width as i32 - win_size.width as i32) / 2;
            let y = main_pos.y + (main_size.height as i32 - win_size.height as i32) / 2;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
}

/// Open (or reveal) the Debug-requests window. A separate native window that
/// mirrors the main window's in-memory debug captures over Tauri events (see
/// src/modules/ai/store/debugBridge.ts). Same owner-window chrome as Settings.
#[tauri::command]
async fn open_debug_window(app: tauri::AppHandle) -> Result<(), String> {
    open_or_reveal_child(
        &app,
        "debug",
        "debug.html".to_string(),
        "Debug",
        (980.0, 680.0),
        (460.0, 360.0),
    )?;
    Ok(())
}

/// Open (or reveal) an always-on-top floating window that hosts a single pane
/// (a live terminal mirror or a file editor). Labeled `float-<leafId>` so each
/// leaf reveals its own window instead of duplicating. Unlike Settings/Debug it
/// is NOT owner-parented - it floats above other apps (YouTube-PiP style) and
/// carries the leaf params in its URL for the float-window React app.
#[tauri::command]
async fn open_float_window(
    app: tauri::AppHandle,
    leaf_id: i64,
    params: String,
    title: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let label = format!("float-{leaf_id}");
    if let Some(window) = app.get_webview_window(&label) {
        // Bring an existing float back to the front. `set_focus` alone often
        // does nothing visible on Windows for a window that's already
        // always-on-top (it's already topmost) or is subject to the foreground
        // lock; re-asserting TOPMOST forces a z-order raise, and unminimize
        // restores it from the taskbar. Order matters: restore, show, raise, focus.
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        return Ok(());
    }

    let url = format!("float.html?p={params}");
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(320.0, 200.0)
        .resizable(true)
        .always_on_top(true)
        .visible(false);

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    let window = builder.build().map_err(|e| e.to_string())?;

    // Authoritative "float closed / docked back" signal for the main window: the
    // float's own BYE event can be lost when its webview is torn down mid-emit,
    // so notify from Rust on the window's Destroyed event instead. The main
    // window's floatHost matches the label back to the leaf and restores it.
    {
        let app_for_event = app.clone();
        let label_for_event = label.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let _ = app_for_event.emit("tedi://float-destroyed", &label_for_event);
            }
        });
    }

    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }
    disable_windows_corner_rounding(&window);
    recenter_over_main(&app, &window);
    Ok(())
}

/// Open (or reveal) an owner-parented child window with our custom chrome.
/// Returns `Ok(None)` when an existing window was revealed, `Ok(Some(window))`
/// when a new one was built. Shared by the Settings and Debug windows.
fn open_or_reveal_child(
    app: &tauri::AppHandle,
    label: &str,
    url: String,
    title: &str,
    size: (f64, f64),
    min_size: (f64, f64),
) -> Result<Option<tauri::WebviewWindow>, String> {
    if let Some(window) = app.get_webview_window(label) {
        // Re-center over the main window so reopening follows the user
        // across displays.
        recenter_over_main(app, &window);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(None);
    }

    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(min_size.0, min_size.1)
        .resizable(true)
        .visible(false);

    // Owner-window relationship: keeps the child z-ordered above main without
    // pinning it above other apps (#33). On Windows the OS auto-hides owned
    // windows when the owner minimizes, so the child follows main into the
    // taskbar instead of floating on the desktop.
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // Linux/Windows render our own titlebar, so drop native chrome and
    // make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    let window = builder.build().map_err(|e| e.to_string())?;

    // Some Linux compositors (GNOME/Mutter with CSD-by-default) ignore the
    // builder-time decorations flag, so re-assert it after realize.
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }
    disable_windows_corner_rounding(&window);

    // Tauri's default placement lands at the primary monitor's center even
    // when main is on a secondary display; re-center over main so it follows
    // the user.
    recenter_over_main(app, &window);
    Ok(Some(window))
}

// WebKitGTK's DMA-BUF renderer fails to create an EGL display on wlroots
// compositors (#105), NVIDIA's proprietary driver, and minimal sessions (#126).
// It works on Mesa-backed GNOME/KDE/COSMIC, so only fall back where trouble is
// likely. Override with WEBKIT_DISABLE_DMABUF_RENDERER=1 (safe) or =0 (hardware).
#[cfg(target_os = "linux")]
fn configure_linux_rendering() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
        return;
    }

    let wayland = std::env::var("XDG_SESSION_TYPE")
        .map(|v| v.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || std::env::var_os("WAYLAND_DISPLAY").is_some();
    if !wayland {
        return;
    }

    match wayland_dmabuf_fallback_reason() {
        Some(reason) => {
            eprintln!(
                "tedi: Wayland session, {reason}; disabling WebKitGTK DMA-BUF renderer \
                 (override: WEBKIT_DISABLE_DMABUF_RENDERER=0)"
            );
            unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") };
        }
        None => eprintln!(
            "tedi: Wayland session on a known-good compositor; keeping WebKitGTK DMA-BUF renderer \
             (set WEBKIT_DISABLE_DMABUF_RENDERER=1 if the window stays blank)"
        ),
    }
}

#[cfg(target_os = "linux")]
fn wayland_dmabuf_fallback_reason() -> Option<&'static str> {
    if has_nvidia_gpu() {
        return Some("NVIDIA proprietary driver detected");
    }
    let desktop = std::env::var("XDG_CURRENT_DESKTOP")
        .or_else(|_| std::env::var("XDG_SESSION_DESKTOP"))
        .unwrap_or_default()
        .to_lowercase();
    const KNOWN_GOOD: [&str; 6] = ["gnome", "kde", "plasma", "cosmic", "unity", "pantheon"];
    if !desktop.is_empty() && KNOWN_GOOD.iter().any(|d| desktop.contains(d)) {
        return None;
    }
    if desktop.is_empty() {
        Some("compositor not advertised (XDG_CURRENT_DESKTOP unset)")
    } else {
        Some("wlroots / unrecognised compositor")
    }
}

#[cfg(target_os = "linux")]
fn has_nvidia_gpu() -> bool {
    std::path::Path::new("/dev/nvidia0").exists()
        || matches!(
            std::env::var("__GLX_VENDOR_LIBRARY_NAME").as_deref(),
            Ok("nvidia")
        )
        || matches!(
            std::env::var("__NV_PRIME_RENDER_OFFLOAD").as_deref(),
            Ok("1")
        )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `tedi --version` / `tedi --help`: print and exit without GUI boot.
    cli::handle_version_help_and_exit();

    // `tedi ext ...` / `tedi --extension ...`: run install/list/update/
    // uninstall headlessly against the same `<app_data_dir>/extensions/`
    // directory the GUI uses, then exit.
    cli_ext::handle_extension_command_and_exit();

    // `tedi theme ...`: list / set / configure the custom theme + wallpaper
    // by writing directly to `tedi-settings.json`. Returns without acting
    // when the `theme` subcommand is absent.
    cli_theme::handle_theme_command_and_exit();

    // `tedi --update` / `-u`: fetch latest.json, verify the bundle's minisign
    // signature, install in place per platform, exit. Returns without acting
    // when the flag is absent.
    cli_update::handle_update_command_and_exit();

    // `TEDIApp --pty-daemon`: run the sidecar PTY daemon forever and exit.
    // Spawned detached by the GUI on first launch. Returns immediately when
    // the flag is absent so normal startup proceeds. See `pty_daemon::mod`.
    pty_daemon::handle_pty_daemon_command_and_exit();

    // Resolve `tedi .` / `tedi <path>` against the launch cwd before any
    // later code can shift the working directory.
    cli::capture_startup();

    #[cfg(target_os = "linux")]
    configure_linux_rendering();

    // Windows: apply the embedded-browser WebView2 flags at the process
    // environment level BEFORE any webview is created, so the main window and
    // every preview child are built with the SAME additional args. A per-child
    // override (different from the main webview's) renders the child BLANK on
    // Windows - tauri-apps/tauri#13092.
    #[cfg(target_os = "windows")]
    preview::apply_webview2_browser_args_env();

    let builder = tauri::Builder::default().plugin(tauri_plugin_process::init());

    // Automation surface, on the SAME switch as the debug port itself. The
    // frontend's `window.__tedi` (command registry + terminal buffer reads, see
    // `scripts/director/`) keys off this flag, so one env var turns on both
    // halves and neither exists without it - in a dev build or a released one.
    //
    // It has to be an initialization script rather than an `eval` after launch:
    // the main window is declared in `tauri.conf.json`, and the modules that
    // read the flag run as the page's first scripts. This runs before them.
    //
    // A plugin's init script reaches every webview the app creates, so during an
    // automation session a previewed third-party page sees the flag too. It is a
    // bare boolean carrying no capability, and the session already has a
    // DevTools port open, so that is a fair trade for not racing the page.
    let builder = match std::env::var("TEDI_DEBUG_PORT") {
        // Both type parameters spelled out: `C` (the plugin's own config, which
        // this one does not have) is otherwise unconstrained and will not fall
        // back to its default, so inference fails with a `DeserializeOwned` note
        // that reads as if the script were the problem.
        Ok(port) if port.trim().parse::<u16>().is_ok() => builder.plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("tedi-automation")
                .js_init_script("window.__TEDI_AUTOMATION__ = true;")
                .build(),
        ),
        _ => builder,
    };

    // Second-invocation forwarding: when `tedi <path>` runs while an instance
    // is already up, the new process forwards its argv and exits. Desktop-only
    // (the plugin does not build for android/ios). Skipped in debug builds so
    // `pnpm tauri dev` can run alongside an installed release.
    #[cfg(all(desktop, not(debug_assertions)))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        let cwd_path = std::path::PathBuf::from(&cwd);
        let update_requested = cli::update_requested_in(argv.iter().map(|s| s.as_str()));
        // Read before `parse` takes ownership of argv.
        let command = cli::command_requested_in(argv.iter().map(|s| s.as_str()));
        let target = cli::parse(argv, &cwd_path);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            // A command wins over a target rather than firing both: the `cmd`
            // verb is itself the first positional, so `tedi cmd tab.new` would
            // otherwise ALSO open a folder named `cmd` if one sat in the cwd.
            if let Some(id) = command {
                let _ = window.emit(crate::modules::events::RUN_COMMAND, id);
            } else if let Some(t) = target {
                let _ = window.emit(crate::modules::events::OPEN_CLI_TARGET, t);
            }
            if update_requested {
                let _ = window.emit(crate::modules::events::TRIGGER_UPDATE, ());
            }
        }
    }));

    // Custom URI scheme that proxies http(s) URLs and strips X-Frame-Options
    // / CSP frame-ancestors so the preview pane can embed sites that would
    // otherwise refuse to render in an iframe.
    let builder = preview::register(builder);

    // Updater is desktop-only; the plugin does not compile on android/ios.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            // Keep the process commit from ratcheting up across a long session.
            spawn_allocator_purge_thread();
            // Strip Windows 11 DWM rounded corners so the app reads as square.
            if let Some(window) = app.get_webview_window("main") {
                disable_windows_corner_rounding(&window);
                // Clamp borderless maximize to the work area + restore the
                // taskbar minimize affordance (see fn docs).
                apply_windows_frame_fixes(&window);
                // Stop WebView2 from hijacking Ctrl+W/Ctrl+P/Ctrl+R/etc. as
                // browser shortcuts so the app's own handlers run (Ctrl+W must
                // close the active tab, not the whole window).
                disable_browser_accelerator_keys(&window);
                // A session saved while maximized may have been restored before
                // the work-area clamp was installed, leaving it over the taskbar.
                // Re-assert maximize now - the window is still hidden (the
                // frontend calls show() after first paint), so there's no flicker.
                #[cfg(target_os = "windows")]
                if window.is_maximized().unwrap_or(false) {
                    let _ = window.unmaximize();
                    let _ = window.maximize();
                }
            }
            // macOS: the default app menu binds Cmd+W to "Close Window", and
            // that native accelerator fires before the webview's JS handler - so
            // Cmd+W closed the whole window (quitting the app) instead of the
            // active tab. Rebuild a standard menu that keeps the App/Edit/Window
            // items (so copy/paste/quit and the system shortcuts still work) but
            // OMITS Close Window, leaving Cmd+W for the app's own close-tab
            // shortcut. Windows/Linux have no such menu accelerator (Windows is
            // handled by disable_browser_accelerator_keys; Linux's WebKitGTK does
            // not bind Cmd/Ctrl+W), so this is macOS-only.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{MenuBuilder, SubmenuBuilder};
                let h = app.handle();
                let app_menu = SubmenuBuilder::new(h, "TEDI")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()?;
                let edit_menu = SubmenuBuilder::new(h, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;
                let window_menu = SubmenuBuilder::new(h, "Window")
                    .minimize()
                    .maximize()
                    .separator()
                    .fullscreen()
                    .build()?;
                let menu = MenuBuilder::new(h)
                    .items(&[&app_menu, &edit_menu, &window_menu])
                    .build()?;
                h.set_menu(menu)?;
            }
            // Heal a stale `~/.local/bin/tedi` shim after an update that moved
            // the binary (macOS .app relocation, AppImage filename change).
            // No-op on Windows; the NSIS hook handles upgrades there.
            cli::refresh_shim_if_present();
            Ok(())
        })
        // Skip restoring VISIBLE; the frontend calls window.show() after first
        // paint so the user never sees a transparent window-shadow flash on
        // Windows/Linux.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .with_denylist(&["settings", "debug"])
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty::PtyState::new())
        .manage(shell::ShellState::default())
        .manage(secrets::SecretsState::default())
        .manage(ssh::SshState::default())
        .manage(extensions::ExtensionsState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_attach,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_list_sessions,
            pty::pty_kill_all,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_read_file_portion,
            fs::file::fs_canonicalize,
            fs::file::fs_write_file,
            fs::mutate::fs_create_file,
            fs::mutate::fs_create_dir,
            fs::mutate::fs_rename,
            fs::mutate::fs_copy,
            fs::mutate::fs_delete,
            fs::search::fs_search,
            fs::grep::fs_grep,
            fs::grep::fs_glob,
            fs::grep::fs_grep_replace,
            fs::grep::fs_replace_in_file,
            git::commands::git_status,
            git::commands::git_ignored,
            git::commands::git_file_head,
            git::commands::git_file_at,
            git::commands::git_run,
            git::commands::git_diff_full,
            git::commands::git_log,
            git::commands::git_commit_detail,
            git::gh::gh_run,
            pty::path_probe::terminal_probe_path,
            shell::shell_run_command,
            shell::shell_session_open,
            shell::shell_session_run,
            shell::shell_session_close,
            shell::shell_bg_spawn,
            shell::shell_bg_spawn_direct,
            shell::shell_bg_logs,
            shell::shell_bg_kill,
            shell::shell_bg_remove,
            shell::shell_bg_list,
            format::fmt_run_external,
            open_settings_window,
            open_debug_window,
            open_float_window,
            preview::preview_embed_update,
            preview::preview_embed_navigate,
            preview::preview_embed_dispatch,
            preview::preview_embed_read,
            preview::preview_embed_console,
            preview::preview_embed_act,
            preview::preview_embed_screenshot,
            preview::preview_embed_set_bg,
            preview::preview_embed_zoom,
            preview::preview_embed_zoom_get,
            preview::preview_embed_url,
            preview::preview_embed_reparent,
            preview::preview_embed_loaded_exts,
            preview::preview_embed_close,
            preview::preview_resolve_favicon,
            preview::browser_ext_list,
            preview::browser_ext_install,
            preview::browser_ext_install_file,
            preview::browser_ext_set_enabled,
            preview::browser_ext_remove,
            cli::cli_initial_target,
            cli::cli_classify_path,
            cli::cli_take_initial_update_request,
            cli::cli_install_path_shim,
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            secrets::secrets_get_all,
            backup::backup_seal,
            backup::backup_open,
            clipboard::clipboard_read_text,
            net::http_ping,
            net::port_is_open,
            net::http_stream,
            net::http_abort,
            mcp::mcp_spawn,
            mcp::mcp_write,
            mcp::mcp_kill,
            ssh::ssh_open,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_close,
            ssh::ssh_confirm_host_key,
            ssh::ssh_agent_keys,
            ssh::ssh_forward_open,
            ssh::ssh_list_sessions,
            ssh::ssh_attach,
            ssh::ssh_git_status,
            ssh::ssh_git,
            ssh::sftp::ssh_sftp_home,
            ssh::sftp::ssh_sftp_read_dir,
            ssh::sftp::ssh_sftp_read_file,
            ssh::sftp::ssh_sftp_write_file,
            ssh::sftp::ssh_sftp_upload,
            ssh::sftp::ssh_sftp_create_file,
            ssh::sftp::ssh_sftp_create_dir,
            ssh::sftp::ssh_sftp_rename,
            ssh::sftp::ssh_sftp_delete,
            extensions::commands::ext_list,
            extensions::commands::ext_read_manifest,
            extensions::commands::ext_read_asset,
            extensions::commands::ext_read_asset_bytes,
            extensions::commands::ext_install_from_zip,
            extensions::commands::ext_install_from_github,
            extensions::commands::ext_peek_zip,
            extensions::commands::ext_peek_github,
            extensions::commands::ext_check_update,
            extensions::commands::ext_enable,
            extensions::commands::ext_disable,
            extensions::commands::ext_uninstall,
            extensions::commands::github_head_sha,
            extensions::commands::github_repo_text_files,
        ])
        .on_window_event(|window, event| {
            // Mirror main-window minimize/restore onto the settings child.
            // Owner-window semantics handle this on Windows; the explicit
            // mirroring below covers Linux/macOS and decoration-less
            // transparent windows where the OS auto-mirror is unreliable.
            // Only the main window's events drive the mirroring onto its
            // children (settings + debug); ignore the children's own events.
            let label = window.label();
            if label != "main" {
                return;
            }
            let app = window.app_handle().clone();
            const CHILDREN: [&str; 2] = ["settings", "debug"];
            match event {
                // On Windows, minimize arrives as a Resized event (Tauri 2 has
                // no Minimized variant). Sample the state and mirror it.
                tauri::WindowEvent::Resized(_) => {
                    let Some(main) = app.get_webview_window("main") else {
                        return;
                    };
                    let minimized = main.is_minimized().unwrap_or(false);
                    for child in CHILDREN {
                        let Some(w) = app.get_webview_window(child) else {
                            continue;
                        };
                        if minimized {
                            let _ = w.minimize();
                        } else if w.is_minimized().unwrap_or(false) {
                            let _ = w.unminimize();
                            let _ = w.show();
                        }
                    }
                }
                // Destroyed, not CloseRequested: the GUI can veto its own close
                // (the quit prompt), and taking the settings/debug windows down
                // on a close the user then cancels would be wrong.
                tauri::WindowEvent::Destroyed => {
                    for child in CHILDREN {
                        if let Some(w) = app.get_webview_window(child) {
                            let _ = w.close();
                        }
                    }
                }
                _ => {}
            }
        })
        // `build` + `run` rather than `run(context)` so the run loop can see
        // `RunEvent::Opened` - macOS Launch Services' "Open With > TEDI" and
        // drag-onto-Dock delivery. Every other platform routes the same open
        // through argv (`cli::capture_startup`) or single-instance forwarding.
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                cli::handle_opened_urls(_app, urls);
            }
        });
}

// Test module last: clippy's `items_after_test_module`.
#[cfg(all(test, target_os = "windows"))]
mod allocator_tests {
    use super::purge_allocator;

    /// Bytes this process has committed privately, i.e. what it charges against
    /// the system commit limit. Deliberately NOT the working set: the whole
    /// point of the bug is that the working set looks fine while the commit
    /// climbs into double-digit GB.
    fn committed_private_bytes() -> usize {
        use windows::Win32::System::Memory::{
            VirtualQuery, MEMORY_BASIC_INFORMATION, MEM_COMMIT, MEM_PRIVATE,
        };
        let stride = std::mem::size_of::<MEMORY_BASIC_INFORMATION>();
        let mut addr: usize = 0;
        let mut total: usize = 0;
        loop {
            let mut mbi = MEMORY_BASIC_INFORMATION::default();
            // SAFETY: querying our own address space; `mbi` is a live, correctly
            // sized buffer. A zero return means the walk ran off the top.
            let read = unsafe { VirtualQuery(Some(addr as *const _), &mut mbi, stride) };
            if read == 0 {
                break;
            }
            if mbi.State == MEM_COMMIT && mbi.Type == MEM_PRIVATE {
                total += mbi.RegionSize;
            }
            let next = mbi.BaseAddress as usize + mbi.RegionSize;
            if next <= addr {
                break; // no forward progress; refuse to spin
            }
            addr = next;
        }
        total
    }

    const CHUNK: usize = 1024 * 1024;

    /// Allocate `chunks` MiB, touch every page, then drop it all. `vec![_; _]`
    /// memsets, so this is committed AND resident, exactly like a base64 chunk
    /// on its way to the webview.
    fn burst_and_free(chunks: usize) {
        let held: Vec<Vec<u8>> = (0..chunks).map(|_| vec![7u8; CHUNK]).collect();
        std::hint::black_box(&held);
    }

    /// The regression guard for "TEDI gets heavy and then stops responding after
    /// a long session". Both halves are needed and they assert different things.
    ///
    /// Deliberately ONE test function rather than two: each phase reads the
    /// process-wide commit, and `cargo test` runs test functions in parallel, so
    /// two allocator tests would measure each other's bursts and flake.
    #[test]
    fn freed_memory_goes_back_to_the_os_and_does_not_ratchet() {
        // Phase 1: a single burst must not stay charged to the process. Measured
        // without the fix, the allocator returned NOTHING: 1090 MiB of a 1090 MiB
        // burst was still committed afterwards.
        let base = committed_private_bytes();
        let held: Vec<Vec<u8>> = (0..1024).map(|_| vec![7u8; CHUNK]).collect();
        let peak = committed_private_bytes();
        drop(held);
        purge_allocator();
        let after = committed_private_bytes();

        let grew = peak.saturating_sub(base);
        let kept = after.saturating_sub(base);
        assert!(
            grew > 512 * 1024 * 1024,
            "burst did not register: base={base} peak={peak} (grew {grew})"
        );
        assert!(
            kept * 4 < grew,
            "allocator kept {} MiB of the {} MiB burst after purge_allocator()",
            kept / 1024 / 1024,
            grew / 1024 / 1024
        );

        // Phase 2: the actual complaint is not that one burst is expensive, it is
        // that an hour of them never comes back down. Repeated cycles must land
        // in the same place instead of drifting upward, which is the "long
        // session stays flat" property in miniature.
        let mut marks = Vec::new();
        for _ in 0..3 {
            burst_and_free(256);
            purge_allocator();
            marks.push(committed_private_bytes());
        }
        let drift = marks.last().unwrap().saturating_sub(marks[0]);
        assert!(
            drift < 64 * 1024 * 1024,
            "commit drifted up {} MiB across three burst cycles: {:?} MiB",
            drift / 1024 / 1024,
            marks.iter().map(|m| m / 1024 / 1024).collect::<Vec<_>>()
        );
    }
}

#[cfg(test)]
mod ui_thread_guard {
    use std::collections::BTreeSet;
    use std::path::Path;

    /// Sync `#[tauri::command]`s that are allowed to exist, each because it does
    /// no blocking work: in-memory registry reads, an atomic flag, or a
    /// fire-and-forget frame onto an already-open pipe.
    ///
    /// `pty_write` / `pty_resize` / `pty_close` are here ON PURPOSE and must stay
    /// sync: they write one small frame and do not await the reply, and moving
    /// them to `spawn_blocking` would let keystrokes transpose. See
    /// `PtyClient::send_oneway`.
    const ALLOWED_SYNC_COMMANDS: &[&str] = &[
        "cli_classify_path",
        "cli_initial_target",
        "cli_install_path_shim",
        "cli_take_initial_update_request",
        "http_abort",
        "pty_close",
        "pty_resize",
        "pty_write",
        "shell_bg_kill",
        "shell_bg_list",
        "shell_bg_logs",
        "shell_bg_remove",
        "shell_session_close",
        "shell_session_open",
        "ssh_confirm_host_key",
    ];

    fn rs_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                rs_files(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs") {
                out.push(p);
            }
        }
    }

    /// Names of every `#[tauri::command]` declared as `pub fn` rather than
    /// `pub async fn`. A `BTreeSet` because `#[cfg]`-gated commands are declared
    /// once per platform and would otherwise count twice.
    fn sync_command_names() -> BTreeSet<String> {
        let mut files = Vec::new();
        rs_files(
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        let mut found = BTreeSet::new();
        for path in files {
            let Ok(src) = std::fs::read_to_string(&path) else {
                continue;
            };
            let lines: Vec<&str> = src.lines().collect();
            for (i, line) in lines.iter().enumerate() {
                if line.trim() != "#[tauri::command]" {
                    continue;
                }
                // Attribute macros may sit between the marker and the fn, and a
                // long signature can push `pub fn` a few lines down.
                for probe in lines.iter().skip(i + 1).take(8) {
                    let t = probe.trim_start();
                    if t.starts_with("pub async fn ") {
                        break;
                    }
                    if let Some(rest) = t.strip_prefix("pub fn ") {
                        let name = rest.split('(').next().unwrap_or("").trim();
                        if !name.is_empty() {
                            found.insert(name.to_string());
                        }
                        break;
                    }
                }
            }
        }
        found
    }

    /// On Windows a sync `#[tauri::command]` runs on the WebView2 UI thread, so
    /// blocking inside one freezes the whole window. That has shipped THREE
    /// times: git decorations (v0.3.50), `pty_write` (v0.3.98), and `fs_read_dir`
    /// on the lock-screen resume path. Each time the fix was to move that one
    /// command off the thread, and each time the next one was added without
    /// anybody noticing the rule.
    ///
    /// So the list is pinned. A new sync command fails here, which is the point:
    /// adding one should be a deliberate act with a reason, and the default for
    /// anything touching the filesystem, a subprocess, a socket or a pipe is
    /// `pub async fn` plus `spawn_blocking`.
    #[test]
    fn no_new_sync_tauri_commands() {
        let found = sync_command_names();
        let allowed: BTreeSet<String> = ALLOWED_SYNC_COMMANDS
            .iter()
            .map(|s| s.to_string())
            .collect();

        let added: Vec<&String> = found.difference(&allowed).collect();
        assert!(
            added.is_empty(),
            "new sync #[tauri::command]s found: {added:?}\n\
             On Windows these run on the WebView2 UI thread and will freeze the \
             window if they block. Make them `pub async fn` + \
             `tauri::async_runtime::spawn_blocking`, or add them to \
             ALLOWED_SYNC_COMMANDS with a reason why they cannot block."
        );

        // The other direction matters too: a command that got fixed should be
        // struck off, so the list keeps describing reality instead of rotting.
        let stale: Vec<&String> = allowed.difference(&found).collect();
        assert!(
            stale.is_empty(),
            "ALLOWED_SYNC_COMMANDS lists commands that are no longer sync: {stale:?}\n\
             Remove them from the list."
        );
    }
}
