mod modules;

use modules::{fs, git, net, pty, secrets, shell, ssh};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_window_state::StateFlags;

/// Windows 11 paints an 8 px DWM corner radius on every top-level window by
/// default - even with `decorations: false` and `transparent: true`. The webview
/// content underneath is square, so the OS-level rounding shows up as a tiny
/// transparent halo at each corner. Force DWMWCP_DONOTROUND so the OS leaves
/// the corners sharp and our CSS border is the sole frame the user sees.
#[cfg(target_os = "windows")]
fn disable_windows_corner_rounding(window: &tauri::WebviewWindow) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };

    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as HWND;
    let pref: u32 = DWMWCP_DONOTROUND as u32;
    // SAFETY: hwnd is a valid window handle owned by Tauri for the lifetime of
    // this call; pref is a stack value passed by pointer with its correct size.
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

#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    let url_path = match tab.as_deref() {
        Some(t) if !t.is_empty() => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    if let Some(window) = app.get_webview_window("settings") {
        // Re-center over the main window's monitor so re-opening after the user
        // moved the main window to another display follows it across.
        if let Some(main) = app.get_webview_window("main") {
            if let (Ok(main_pos), Ok(main_size), Ok(settings_size)) = (
                main.outer_position(),
                main.outer_size(),
                window.outer_size(),
            ) {
                let x = main_pos.x
                    + (main_size.width as i32 - settings_size.width as i32) / 2;
                let y = main_pos.y
                    + (main_size.height as i32 - settings_size.height as i32) / 2;
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if let Some(t) = tab.as_deref().filter(|s| !s.is_empty()) {
            // emit() serializes via JSON - no string-escape footgun, unlike
            // eval() with format!(). Frontend listens via Tauri event API.
            let _ = window.emit("tedi:settings-tab", t);
        }
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(720.0, 520.0)
        .min_inner_size(720.0, 520.0)
        .max_inner_size(720.0, 520.0)
        .resizable(false)
        .visible(false);

    // Owner-window relationship: keeps settings z-ordered above main without
    // pinning it above other apps (#33), and on Windows the OS hides owned
    // windows automatically when the owner minimizes - so settings follows
    // main into the taskbar instead of floating on the desktop.
    if let Some(main) = app.get_webview_window("main") {
        builder = builder.parent(&main).map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // On Linux/Windows we render our own titlebar, so drop native chrome
    // and make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    let window = builder.build().map_err(|e| e.to_string())?;

    // Some Linux compositors (GNOME/Mutter with CSD-by-default) ignore the
    // builder-time decorations flag - re-assert it after realize.
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }
    disable_windows_corner_rounding(&window);

    // Tauri's default placement lands at the primary monitor's center even when
    // the main window is on a secondary display, which makes the settings window
    // appear to "jump screens". Re-center it over the main window so it follows
    // wherever the user is actually working.
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(main_pos), Ok(main_size), Ok(settings_size)) = (
            main.outer_position(),
            main.outer_size(),
            window.outer_size(),
        ) {
            let x = main_pos.x
                + (main_size.width as i32 - settings_size.width as i32) / 2;
            let y = main_pos.y
                + (main_size.height as i32 - settings_size.height as i32) / 2;
            let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    let _ = window;
    Ok(())
}

// WebKitGTK's DMA-BUF (hardware) renderer fails to create an EGL display on
// wlroots compositors (#105), NVIDIA's proprietary driver, and minimal sessions
// (#126). It's fine and faster on Mesa-backed GNOME/KDE/COSMIC, so only fall
// back to the safe path where trouble is likely. Override:
//   WEBKIT_DISABLE_DMABUF_RENDERER=1  force safe path   =0  force hardware path
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
    #[cfg(target_os = "linux")]
    configure_linux_rendering();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_process::init());

    // Updater is desktop-only (no mobile target wired in this fork either, but
    // the plugin itself refuses to compile on android/ios).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_updater::Builder::new().build());

    builder
        .setup(|app| {
            // Strip Windows 11's DWM rounded corners from the main window so
            // the app reads as fully square (matches the CSS).
            if let Some(window) = app.get_webview_window("main") {
                disable_windows_corner_rounding(&window);
            }
            Ok(())
        })
        // Skip restoring VISIBLE - frontend calls window.show() after first
        // paint so the user never sees a transparent window-shadow flash on
        // Windows/Linux.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
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
        .manage(pty::PtyState::default())
        .manage(shell::ShellState::default())
        .manage(secrets::SecretsState::default())
        .manage(ssh::SshState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_write_file,
            fs::file::fs_stat,
            fs::mutate::fs_create_file,
            fs::mutate::fs_create_dir,
            fs::mutate::fs_rename,
            fs::mutate::fs_delete,
            fs::search::fs_search,
            fs::grep::fs_grep,
            fs::grep::fs_glob,
            git::commands::git_status,
            git::commands::git_file_head,
            git::commands::git_discard_file,
            git::commands::git_discard_all,
            shell::shell_run_command,
            shell::shell_session_open,
            shell::shell_session_run,
            shell::shell_session_close,
            shell::shell_bg_spawn,
            shell::shell_bg_logs,
            shell::shell_bg_kill,
            shell::shell_bg_list,
            open_settings_window,
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            secrets::secrets_get_all,
            net::http_ping,
            ssh::ssh_open,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_close,
        ])
        .on_window_event(|window, event| {
            // Mirror main-window visibility onto the settings child so it
            // tracks main's minimize/restore and doesn't linger on the
            // desktop when the user switches apps. Owner-window semantics
            // (set via `.parent(&main)`) handle most of this for us on
            // Windows, but the explicit mirroring below covers Linux/macOS
            // and the decorationless-transparent-window edge cases where
            // the OS auto-mirror doesn't fire reliably.
            let label = window.label();
            if label != "main" && label != "settings" {
                return;
            }
            let app = window.app_handle().clone();
            match event {
                // On Windows, minimize is reported as a Resized event (no
                // dedicated Minimized variant in Tauri 2). Sample the state
                // and mirror it onto settings.
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
                tauri::WindowEvent::Focused(focused) => {
                    let Some(settings) = app.get_webview_window("settings") else {
                        return;
                    };
                    if *focused {
                        // Either window regained focus - bring settings back.
                        if !settings.is_visible().unwrap_or(true) {
                            let _ = settings.show();
                        }
                    } else {
                        // Defer the check: when focus moves between our own
                        // windows, Focused(false) on one fires before
                        // Focused(true) on the other. Sample focus after the
                        // event queue settles.
                        let app = app.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(120));
                            let main_focused = app
                                .get_webview_window("main")
                                .and_then(|w| w.is_focused().ok())
                                .unwrap_or(false);
                            let settings_focused = app
                                .get_webview_window("settings")
                                .and_then(|w| w.is_focused().ok())
                                .unwrap_or(false);
                            // Only hide if main is still active in the
                            // background (not minimized) - otherwise leave
                            // the OS-driven minimize chain alone.
                            let main_minimized = app
                                .get_webview_window("main")
                                .and_then(|w| w.is_minimized().ok())
                                .unwrap_or(false);
                            if !main_focused && !settings_focused && !main_minimized {
                                if let Some(settings) = app.get_webview_window("settings") {
                                    let _ = settings.hide();
                                }
                            }
                        });
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
