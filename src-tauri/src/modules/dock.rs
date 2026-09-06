//! Adopting another process's window as a child of ours.
//!
//! A pane can hold something the app does not draw: an extension may run a real
//! browser, and the only way to show a real browser at full speed, with a real
//! pointer and a real user agent, is to show its actual window. Placed on the
//! pane's rectangle from outside, that window is still a separate top-level
//! window - it carries its own title bar and taskbar button, it survives when the
//! app is minimised, and it spills over the app's edge when the pane is clipped.
//!
//! Reparenting removes the difference rather than hiding it. `SetParent` makes
//! the foreign window a `WS_CHILD` of ours, so the OS clips it to our client
//! area, moves it with us, minimises it with us and drops it from the taskbar and
//! Alt-Tab - the same treatment our own controls get, because it now is one.
//!
//! WHAT THIS DOES NOT BUY. A child window still composites ABOVE everything the
//! app paints itself, so a menu opened over the pane is behind it. That is a
//! property of native child windows, not of this module, and it is why the caller
//! hides the window rather than trying to draw over it.
//!
//! WINDOWS ONLY, DELIBERATELY. X11 could do the same through `XReparentWindow`,
//! but Wayland cannot and macOS has no cross-process window embedding at all. So
//! rather than three code paths with two of them half-working, every command here
//! fails on other platforms and the caller keeps placing the window from outside.
//! That path is what already works everywhere; this one is the improvement.
//!
//! COORDINATES ARE PHYSICAL PIXELS. `SetWindowPos` on a per-monitor-DPI-aware
//! process speaks device pixels, while a pane rectangle is CSS pixels. The caller
//! multiplies by `devicePixelRatio`, because only it knows the scale the pane was
//! measured at.

use serde::Deserialize;

/// A rectangle in physical pixels, relative to our window's client area.
#[derive(Deserialize, Clone, Copy, Debug)]
pub struct DockRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Take over the window currently titled `title` and make it our child.
///
/// FOUND BY TITLE, not by position. Position would be the obvious key - the
/// caller has just placed the window on the pane - but the caller places in DIPs
/// through the DevTools Protocol while `GetWindowRect` answers in device pixels,
/// so the two disagree on any scaled display and the search would silently miss.
/// A title the caller sets for this one call is exact at any scale.
///
/// Returns the adopted window handle, which the caller passes back to
/// [`dock_place_window`] and [`dock_release_window`].
#[tauri::command]
pub async fn dock_adopt_window(
    window: tauri::Window,
    title: String,
    client: DockRect,
) -> Result<u64, String> {
    imp::adopt(window, title, client).await
}

/// Move the adopted window, or hide it without giving it up.
///
/// Hiding is `SWP_HIDEWINDOW` rather than a move off-screen: a child window has
/// no off-screen to go to, since the OS clips it to our client area anyway.
#[tauri::command]
pub async fn dock_place_window(handle: u64, client: DockRect, visible: bool) -> Result<(), String> {
    imp::place(handle, client, visible).await
}

/// Cut holes in the adopted window so what the app draws over it shows through.
///
/// THE ONE THING REPARENTING CANNOT DO. A child window composites above
/// everything its parent paints, so on the canvas the browser covered every
/// window stacked over it, and no amount of z-ordering helps: below the webview
/// it would be invisible entirely, above it, it is opaque. A window REGION is
/// the escape - the OS simply does not draw the window where the region is not,
/// so the app's own pixels survive there.
///
/// `covers` are in the adopted window's own client coordinates, device pixels.
/// An empty list clears the clip and the window is whole again.
#[tauri::command]
pub async fn dock_clip_window(handle: u64, covers: Vec<DockRect>) -> Result<(), String> {
    imp::clip(handle, covers).await
}

/// Hand the window back: top-level again, with its frame restored.
///
/// Called when the pane goes away. Skipping it would leave a frameless child of a
/// window that is about to close, which the OS destroys along with us - fine for
/// a page we are closing anyway, and wrong for one the user still wants.
///
/// `visible` is what the caller wants the released window to be, and it defaults
/// to shown for the case this was written for: the pane is closing and the page
/// outlives it, so a window the user can still reach beats a frameless orphan.
/// A caller that is about to take the page over on another surface passes
/// `false`, because showing it first would put a real Chrome window on screen for
/// the length of the handover - which on a workspace view switch is the whole
/// visible artefact, not a detail.
#[tauri::command]
pub async fn dock_release_window(
    window: tauri::Window,
    handle: u64,
    visible: Option<bool>,
) -> Result<(), String> {
    imp::release(window, handle, visible.unwrap_or(true)).await
}

/// Give the adopted window under the cursor the keyboard, if that is what was
/// clicked.
///
/// NOT A COMMAND, because the extension that owns the window cannot see the
/// click: the adopted window covers the pane, so it swallows every mouse event
/// before the webview - and therefore the extension - hears about it. The one
/// place that does hear is our own window proc, which the OS sends
/// `WM_PARENTNOTIFY` for exactly this. See `lib.rs`.
pub fn focus_clicked_child(parent: isize) {
    imp::focus_clicked_child(parent);
}

#[cfg(target_os = "windows")]
mod imp {
    use super::DockRect;
    use std::sync::atomic::{AtomicIsize, Ordering};
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{
        GetLastError, SetLastError, HWND, LPARAM, NO_ERROR, POINT,
    };
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, ScreenToClient, SetWindowRgn, RGN_DIFF,
    };
    use windows_sys::Win32::System::Threading::AttachThreadInput;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::SetFocus;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        ChildWindowFromPointEx, EnumWindows, GetCursorPos, GetWindowLongPtrW, GetWindowRect,
        GetWindowTextW, GetWindowThreadProcessId, SetParent, SetWindowLongPtrW, SetWindowPos,
        CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, GWL_EXSTYLE, GWL_STYLE, HWND_TOP, SWP_FRAMECHANGED,
        SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
        WS_CAPTION, WS_CHILD, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
        WS_OVERLAPPEDWINDOW, WS_POPUP, WS_SYSMENU, WS_THICKFRAME, WS_VISIBLE,
    };

    /// How long to keep looking for the caption the caller just set. Generous
    /// because it is only ever paid once per pane, and a pane that silently
    /// falls back to an unadopted window is the worse outcome.
    const TITLE_WAIT: std::time::Duration = std::time::Duration::from_millis(2500);

    /// Gap between passes. A full `EnumWindows` is a few hundred cheap calls, so
    /// this is short enough to feel immediate and long enough not to spin.
    const TITLE_POLL: std::time::Duration = std::time::Duration::from_millis(40);

    /// Carries the search between `EnumWindows` and its callback. An atomic
    /// rather than a lock because the callback cannot return a value and cannot
    /// unwind: a panic across the FFI boundary would abort the process.
    struct Search {
        want: Vec<u16>,
        found: AtomicIsize,
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> i32 {
        let search = &*(lparam as *const Search);
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        // STARTS WITH, not equals. The caller names the window through the
        // page's `document.title`, and an ordinary browser window appends its
        // own product name to that - "<page> - Google Chrome". Demanding an
        // exact match finds nothing, every time, silently.
        if n > 0 && buf[..n as usize].starts_with(&search.want) {
            search.found.store(hwnd as isize, Ordering::Relaxed);
            return 0; // Stop: the marker is unique for this call.
        }
        1
    }

    /// The thread that owns a window, or 0 once it is gone.
    fn thread_of(hwnd: HWND) -> u32 {
        // SAFETY: a dead handle answers 0, which every caller reads as "gone".
        unsafe { GetWindowThreadProcessId(hwnd, std::ptr::null_mut()) }
    }

    /// Join or separate the input queues of two windows' threads.
    ///
    /// The cost of joining is real and worth stating: while attached, one thread
    /// that stops pumping messages blocks the other. It is accepted here because
    /// the alternative is an embedded browser nobody can type into, and because
    /// the pane detaches again the moment it lets the window go.
    fn attach(a: HWND, b: HWND, join: bool) {
        // SAFETY: both handles are live windows; a dead one makes the thread id
        // zero and `AttachThreadInput` a no-op.
        unsafe {
            let ta = GetWindowThreadProcessId(a, std::ptr::null_mut());
            let tb = GetWindowThreadProcessId(b, std::ptr::null_mut());
            if ta != 0 && tb != 0 && ta != tb {
                AttachThreadInput(ta, tb, if join { 1 } else { 0 });
            }
        }
    }

    /// Every window we currently hold, so the parent window proc can tell a
    /// click on one of them from a click on the app itself. A list because a
    /// second browser pane is a second adopted window, and both stay live.
    static ADOPTED: Mutex<Vec<isize>> = Mutex::new(Vec::new());

    /// Hand the keyboard to the adopted window under the cursor.
    ///
    /// TRIED AND REVERTED: posting `WM_NCACTIVATE` + `WM_ACTIVATE` here, and at
    /// adoption, to make Chrome believe the widget is ACTIVE - which is what its
    /// omnibox checks before it will show a caret or select its contents. It did
    /// not fix the address bar, and it broke the page: after a click, focus
    /// landed on the app's own webview instead of the browser, measured with
    /// `GetGUIThreadInfo`. A child window is not meant to be told it is active,
    /// and Chrome answers by handing activation back up the chain. Do not
    /// re-add it without a better lever.
    ///
    /// THE CLICK ARRIVES, THE FOCUS DOES NOT. A reparented window is sent the
    /// click by position, so the page reacts and the cursor changes - but focus
    /// stays wherever it was, on the webview the app draws itself, and every
    /// keystroke goes there instead. Chrome would take focus itself on a click
    /// and does not here, because as a `WS_CHILD` it never sees the activation
    /// that would prompt it. Measured, not assumed: clicking a docked page left
    /// `GetGUIThreadInfo().hwndFocus` on our own top-level window.
    ///
    /// Called from that window proc on `WM_PARENTNOTIFY`, so `SetFocus` runs on
    /// the thread that owns the parent - already joined to the thread of the child by
    /// [`attach`], which is the whole reason it can cross the process boundary.
    /// Without that join this is a silent no-op.
    ///
    /// The cursor is read fresh rather than taken from the message: for a mouse
    /// `WM_PARENTNOTIFY` the coordinates are packed into `lParam`, and which
    /// window they are relative to is the kind of detail that is wrong once and
    /// then wrong forever on a scaled display.
    pub fn focus_clicked_child(parent: isize) {
        // SAFETY: `parent` is our own live window, and every call below either
        // fails harmlessly on a dead handle or answers with a null one.
        unsafe {
            let mut pt = POINT { x: 0, y: 0 };
            if GetCursorPos(&mut pt) == 0 || ScreenToClient(parent as HWND, &mut pt) == 0 {
                return;
            }
            let child =
                ChildWindowFromPointEx(parent as HWND, pt, CWP_SKIPINVISIBLE | CWP_SKIPDISABLED);
            if child.is_null() {
                return;
            }
            // Only ours. The webview the app draws itself is a child too, and
            // focusing it from here would fight WebView2 for something it
            // already handles.
            //
            // NOTHING IS DEACTIVATED HERE, deliberately. Deactivating on a click
            // elsewhere in the app would mean the next click on the browser
            // arrives while it is inactive again - and the message that would
            // fix that cannot beat the click it is answering. An adopted window
            // therefore stays active for its whole life. The cost is cosmetic
            // and mostly invisible: Chrome shows a caret only when it also has
            // FOCUS, which it loses the moment the user clicks the app.
            let known = ADOPTED
                .lock()
                .map(|list| list.contains(&(child as isize)))
                .unwrap_or(false);
            if known {
                SetFocus(child);
            }
        }
    }

    /// Our own window, as a raw handle. Read on the calling thread because
    /// `hwnd()` only reads state Tauri already holds.
    fn parent_of(window: &tauri::Window) -> Result<isize, String> {
        window
            .hwnd()
            .map(|h| h.0 as isize)
            .map_err(|e| format!("no window handle: {e}"))
    }

    pub async fn adopt(
        window: tauri::Window,
        title: String,
        client: DockRect,
    ) -> Result<u64, String> {
        let parent = parent_of(&window)?;
        tokio::task::spawn_blocking(move || {
            let search = Search {
                want: title.encode_utf16().collect(),
                found: AtomicIsize::new(0),
            };
            // RETRIED, because the caller names the window by setting the page's
            // `document.title` and that reaches the OS window asynchronously: a
            // single pass runs before the new caption has been applied and finds
            // nothing every time. Polling is the only signal available - there is
            // no event for "another process finished renaming its window".
            let deadline = std::time::Instant::now() + TITLE_WAIT;
            let hwnd = loop {
                // SAFETY: `visit` only reads through the pointer, which outlives
                // the call because `EnumWindows` is synchronous.
                unsafe { EnumWindows(Some(visit), &search as *const Search as LPARAM) };
                let found = search.found.load(Ordering::Relaxed);
                if found != 0 {
                    break found;
                }
                if std::time::Instant::now() >= deadline {
                    return Err(format!("no window titled {title:?}"));
                }
                std::thread::sleep(TITLE_POLL);
            };

            // SAFETY: `hwnd` came from EnumWindows and is still valid; every call
            // below is a plain window-management call on it.
            unsafe {
                let hwnd = hwnd as HWND;
                // A child window may not carry a frame or a popup bit. Dropping
                // the frame here rather than after `SetParent` means the window
                // is never briefly drawn with a title bar inside the pane.
                let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
                let stripped = (style as u32
                    & !(WS_CAPTION
                        | WS_THICKFRAME
                        | WS_SYSMENU
                        | WS_MINIMIZEBOX
                        | WS_MAXIMIZEBOX
                        | WS_POPUP))
                    | WS_CHILD
                    | WS_VISIBLE;
                SetWindowLongPtrW(hwnd, GWL_STYLE, stripped as isize);

                // Belt and braces for the taskbar: WS_CHILD alone drops the
                // button, but a window that asked for one with WS_EX_APPWINDOW
                // keeps it until that is cleared too.
                let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
                SetWindowLongPtrW(
                    hwnd,
                    GWL_EXSTYLE,
                    ((ex & !WS_EX_APPWINDOW) | WS_EX_TOOLWINDOW) as isize,
                );

                // `SetParent` answers with the PREVIOUS parent, and a top-level
                // window has none - so success and failure both return null and
                // only the error code separates them. Clearing it first is the
                // documented way to ask.
                SetLastError(NO_ERROR);
                if SetParent(hwnd, parent as HWND).is_null() && GetLastError() != NO_ERROR {
                    return Err(format!("SetParent refused the window: {}", GetLastError()));
                }
                SetWindowPos(
                    hwnd,
                    HWND_TOP,
                    client.x,
                    client.y,
                    client.width.max(1),
                    client.height.max(1),
                    SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );

                // KEYBOARD DOES NOT FOLLOW THE MOUSE ACROSS A PROCESS BOUNDARY.
                // Reparenting alone gets clicks through - they are delivered by
                // position - but focus is per input queue, so the keystrokes went
                // on being routed by OUR queue, which has never heard of the
                // child. Typing simply did nothing. Attaching the two queues is
                // the documented remedy: focus becomes shared, and a click on the
                // page then owns the keyboard the way any other control would.
                attach(parent as HWND, hwnd, true);
                if let Ok(mut list) = ADOPTED.lock() {
                    list.push(hwnd as isize);
                }
                Ok(hwnd as u64)
            }
        })
        .await
        .map_err(|e| format!("dock task failed: {e}"))?
    }

    pub async fn place(handle: u64, client: DockRect, visible: bool) -> Result<(), String> {
        if handle == 0 {
            return Err("not an adopted window".into());
        }
        tokio::task::spawn_blocking(move || {
            // SAFETY: a stale handle makes SetWindowPos fail, which is the
            // outcome we want - the caller drops the pane either way.
            unsafe {
                SetWindowPos(
                    handle as HWND,
                    HWND_TOP,
                    client.x,
                    client.y,
                    client.width.max(1),
                    client.height.max(1),
                    SWP_NOACTIVATE
                        | SWP_NOZORDER
                        | if visible {
                            SWP_SHOWWINDOW
                        } else {
                            SWP_HIDEWINDOW
                        },
                );
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("dock task failed: {e}"))?
    }

    pub async fn clip(handle: u64, covers: Vec<DockRect>) -> Result<(), String> {
        if handle == 0 {
            return Err("not an adopted window".into());
        }
        tokio::task::spawn_blocking(move || {
            // SAFETY: every call is a plain GDI/window call; a dead handle makes
            // `SetWindowRgn` fail, which is the outcome we want.
            unsafe {
                let hwnd = handle as HWND;
                if covers.is_empty() {
                    // NULL region = no clip at all. Cheaper than a full-size one
                    // and it is what "the window is whole" actually means.
                    SetWindowRgn(hwnd, std::ptr::null_mut(), 1);
                    return Ok(());
                }
                let mut r = std::mem::zeroed();
                if GetWindowRect(hwnd, &mut r) == 0 {
                    return Err("window is gone".into());
                }
                let whole = CreateRectRgn(0, 0, r.right - r.left, r.bottom - r.top);
                for c in &covers {
                    let hole = CreateRectRgn(c.x, c.y, c.x + c.width, c.y + c.height);
                    CombineRgn(whole, whole, hole, RGN_DIFF);
                    DeleteObject(hole);
                }
                // The SYSTEM OWNS the region once this succeeds, so it must not
                // be deleted here - and must be deleted if it does not.
                if SetWindowRgn(hwnd, whole, 1) == 0 {
                    DeleteObject(whole);
                    return Err("could not clip the window".into());
                }
                Ok(())
            }
        })
        .await
        .map_err(|e| format!("dock task failed: {e}"))?
    }

    pub async fn release(window: tauri::Window, handle: u64, visible: bool) -> Result<(), String> {
        if handle == 0 {
            return Ok(());
        }
        let parent = parent_of(&window)?;
        tokio::task::spawn_blocking(move || {
            // DROP IT FROM THE LIST BEFORE DECIDING WHETHER TO UNJOIN. The input
            // queues are joined per THREAD, not per window, and every window one
            // Chromium opens belongs to the same UI thread - so a second browser
            // pane joins the very same pair a second time. `AttachThreadInput`
            // does not count its calls, so unjoining here on the first release
            // would take the keyboard away from the pane that is still open, and
            // do it silently: that pane keeps drawing, keeps taking clicks, and
            // stops accepting a single keystroke.
            let tid = thread_of(handle as HWND);
            let others_share_the_thread = match ADOPTED.lock() {
                Ok(mut list) => {
                    list.retain(|h| *h != handle as isize);
                    tid != 0 && list.iter().any(|h| thread_of(*h as HWND) == tid)
                }
                Err(_) => false,
            };
            if !others_share_the_thread {
                attach(parent as HWND, handle as HWND, false);
            }
            // SAFETY: as above - the window may already be gone, and every call
            // here fails harmlessly on a dead handle.
            unsafe {
                let hwnd = handle as HWND;
                SetParent(hwnd, std::ptr::null_mut());
                let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
                SetWindowLongPtrW(
                    hwnd,
                    GWL_STYLE,
                    ((style & !WS_CHILD) | WS_OVERLAPPEDWINDOW) as isize,
                );
                let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex & !WS_EX_TOOLWINDOW) as isize);
                // LEAVE IT WHERE IT IS. The four zeros are a position and a
                // size, and without `SWP_NOMOVE | SWP_NOSIZE` they are obeyed:
                // the window we just handed back jumps to the top-left corner of
                // the screen and collapses to whatever minimum the browser
                // clamps it to. `SWP_FRAMECHANGED` is the only thing wanted
                // here - the style bits above have changed and the frame has to
                // be recomputed - so everything else is suppressed.
                SetWindowPos(
                    hwnd,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_FRAMECHANGED
                        | SWP_NOACTIVATE
                        | SWP_NOMOVE
                        | SWP_NOSIZE
                        | SWP_NOZORDER
                        | if visible {
                            SWP_SHOWWINDOW
                        } else {
                            SWP_HIDEWINDOW
                        },
                );
            }
            Ok(())
        })
        .await
        .map_err(|e| format!("dock task failed: {e}"))?
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::DockRect;

    /// The one message every non-Windows caller gets, so a fallback can match on
    /// nothing and simply treat any error as "place it from outside instead".
    const UNSUPPORTED: &str = "window docking is available on Windows only";

    pub async fn adopt(
        _window: tauri::Window,
        _title: String,
        _client: DockRect,
    ) -> Result<u64, String> {
        Err(UNSUPPORTED.into())
    }

    pub async fn place(_handle: u64, _client: DockRect, _visible: bool) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub async fn clip(_handle: u64, _covers: Vec<super::DockRect>) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    pub async fn release(
        _window: tauri::Window,
        _handle: u64,
        _visible: bool,
    ) -> Result<(), String> {
        Err(UNSUPPORTED.into())
    }

    /// Nothing is ever adopted here, so nothing can have been clicked.
    pub fn focus_clicked_child(_parent: isize) {}
}
