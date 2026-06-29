// `pub` so the `tedi-cli` workspace member's stub binary
// (src-tauri/tedi-cli/src/main.rs) can reach `cli::help_text()` and the
// version constants - keeps the help text single-sourced between the GUI
// binary and the launcher.
pub mod modules;

/// Version string this crate was compiled against. Re-exposed so the
/// `tedi-cli` launcher (which has its own `CARGO_PKG_VERSION` for the
/// `tedi-cli` package) can print the GUI crate's version instead and
/// stay in sync without a duplicate version constant.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

use modules::{
    cli, cli_ext, cli_theme, cli_update, extensions, format, fs, git, mcp, net, preview, pty,
    pty_daemon, secrets, shell, ssh,
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

#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    let url_path = match tab.as_deref() {
        Some(t) if !t.is_empty() => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    if let Some(window) = app.get_webview_window("settings") {
        // Re-center over the main window so reopening follows the user
        // across displays.
        if let Some(main) = app.get_webview_window("main") {
            if let (Ok(main_pos), Ok(main_size), Ok(settings_size)) = (
                main.outer_position(),
                main.outer_size(),
                window.outer_size(),
            ) {
                let x = main_pos.x + (main_size.width as i32 - settings_size.width as i32) / 2;
                let y = main_pos.y + (main_size.height as i32 - settings_size.height as i32) / 2;
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(t) = tab.as_deref().filter(|s| !s.is_empty()) {
            // emit() serializes via JSON, so no string-escape footgun.
            // Frontend listens via Tauri event API.
            let _ = window.emit(crate::modules::events::SETTINGS_TAB, t);
        }
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(880.0, 620.0)
        .min_inner_size(600.0, 480.0)
        .resizable(true)
        .visible(false);

    // Owner-window relationship: keeps settings z-ordered above main without
    // pinning it above other apps (#33). On Windows the OS auto-hides owned
    // windows when the owner minimizes, so settings follows main into the
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
    // when main is on a secondary display, which makes settings jump screens.
    // Re-center over main so it follows the user.
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(main_pos), Ok(main_size), Ok(settings_size)) = (
            main.outer_position(),
            main.outer_size(),
            window.outer_size(),
        ) {
            let x = main_pos.x + (main_size.width as i32 - settings_size.width as i32) / 2;
            let y = main_pos.y + (main_size.height as i32 - settings_size.height as i32) / 2;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    let _ = window;
    Ok(())
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

    // Second-invocation forwarding: when `tedi <path>` runs while an instance
    // is already up, the new process forwards its argv and exits. Desktop-only
    // (the plugin does not build for android/ios). Skipped in debug builds so
    // `pnpm tauri dev` can run alongside an installed release.
    #[cfg(all(desktop, not(debug_assertions)))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
        let cwd_path = std::path::PathBuf::from(&cwd);
        let update_requested = cli::update_requested_in(argv.iter().map(|s| s.as_str()));
        let target = cli::parse(argv, &cwd_path);
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            if let Some(t) = target {
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
            // Strip Windows 11 DWM rounded corners so the app reads as square.
            if let Some(window) = app.get_webview_window("main") {
                disable_windows_corner_rounding(&window);
                // Clamp borderless maximize to the work area + restore the
                // taskbar minimize affordance (see fn docs).
                apply_windows_frame_fixes(&window);
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
                .with_denylist(&["settings"])
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
            git::commands::git_status,
            git::commands::git_ignored,
            git::commands::git_file_head,
            git::commands::git_file_at,
            git::commands::git_discard_file,
            git::commands::git_discard_all,
            git::commands::git_commit,
            git::commands::git_push,
            git::commands::git_diff_full,
            git::commands::git_log,
            git::commands::git_commit_detail,
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
            preview::preview_embed_update,
            preview::preview_embed_navigate,
            preview::preview_embed_dispatch,
            preview::preview_embed_read,
            preview::preview_embed_act,
            preview::preview_embed_screenshot,
            preview::preview_embed_set_bg,
            preview::preview_embed_close,
            preview::preview_resolve_favicon,
            cli::cli_initial_target,
            cli::cli_take_initial_update_request,
            cli::cli_install_path_shim,
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            secrets::secrets_get_all,
            net::http_ping,
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
            ssh::ssh_list_sessions,
            ssh::ssh_attach,
            ssh::sftp::ssh_sftp_home,
            ssh::sftp::ssh_sftp_read_dir,
            ssh::sftp::ssh_sftp_stat,
            ssh::sftp::ssh_sftp_read_file,
            ssh::sftp::ssh_sftp_write_file,
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
        ])
        .on_window_event(|window, event| {
            // Mirror main-window minimize/restore onto the settings child.
            // Owner-window semantics handle this on Windows; the explicit
            // mirroring below covers Linux/macOS and decoration-less
            // transparent windows where the OS auto-mirror is unreliable.
            let label = window.label();
            if label != "main" && label != "settings" {
                return;
            }
            let app = window.app_handle().clone();
            match event {
                // On Windows, minimize arrives as a Resized event (Tauri 2 has
                // no Minimized variant). Sample the state and mirror it.
                tauri::WindowEvent::Resized(_) if label == "main" => {
                    let Some(main) = app.get_webview_window("main") else {
                        return;
                    };
                    let Some(settings) = app.get_webview_window("settings") else {
                        return;
                    };
                    let minimized = main.is_minimized().unwrap_or(false);
                    if minimized {
                        let _ = settings.minimize();
                    } else if settings.is_minimized().unwrap_or(false) {
                        let _ = settings.unminimize();
                        let _ = settings.show();
                    }
                }
                tauri::WindowEvent::CloseRequested { .. } if label == "main" => {
                    if let Some(settings) = app.get_webview_window("settings") {
                        let _ = settings.close();
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
