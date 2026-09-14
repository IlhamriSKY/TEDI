//! Screenshot preview: tell the main window when the OS saves a new screenshot,
//! so it can offer the file to drag into a terminal or copy its path.
//!
//! Nothing hooks the Print Screen key. Every desktop's screenshot tool already
//! writes the capture into a known folder - Snipping Tool and Win+PrtScn into
//! the Screenshots known folder, macOS into `com.apple.screencapture location`
//! (else the Desktop), GNOME, KDE Spectacle, Flameshot and xfce4-screenshooter
//! under XDG Pictures - so all the watcher has to do is notice a new image
//! there. That also makes it independent of which key or tool took the shot.
//!
//! It POLLS directory mtimes once a second instead of using inotify / FSEvents /
//! ReadDirectoryChangesW: a `stat` per folder is free, needs no new crate, and
//! behaves the same on every kernel and filesystem (an inotify watch budget
//! already spent by an IDE included). A folder is only listed when its mtime
//! moved, which is what adding or renaming a file in it does.
//!
//! A tool that ONLY copies to the clipboard (Windows 10's bare PrtScn, macOS
//! Ctrl+Cmd+Shift+3) writes no file and is not seen.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use tauri::{AppHandle, Emitter};

use crate::modules::events;

const TICK: Duration = Duration::from_secs(1);
/// Re-resolve the folder list this often, so a Screenshots folder the OS
/// creates on the very first capture is picked up without a restart.
const REFRESH_FOLDERS_EVERY: u32 = 10;
/// A file younger than this may still be being written; look again next tick.
const SETTLE: Duration = Duration::from_millis(500);
const IMAGE_EXTS: [&str; 8] = ["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "heic"];

static ENABLED: AtomicBool = AtomicBool::new(false);
static WORKER: OnceLock<Option<std::thread::Thread>> = OnceLock::new();

/// Turn the watcher on or off (Settings > General > Screenshots). The thread is
/// spawned on first use and PARKS while off, so a disabled watcher costs nothing.
#[tauri::command]
pub async fn snapshot_watch(app: AppHandle, enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
    let worker = WORKER.get_or_init(|| {
        std::thread::Builder::new()
            .name("tedi-snapshot".into())
            .spawn(move || run(app))
            .map(|h| h.thread().clone())
            .map_err(|e| log::warn!("snapshot watcher did not start: {e}"))
            .ok()
    });
    if let Some(t) = worker {
        t.unpark();
    }
}

fn run(app: AppHandle) {
    loop {
        if !ENABLED.load(Ordering::SeqCst) {
            // Spurious wake-ups are fine: the loop re-checks the flag.
            std::thread::park();
            continue;
        }
        // A fresh watch per enable: its `since` is now, so turning the feature
        // on never replays the screenshots already on disk.
        let mut watch = Watch::new();
        loop {
            std::thread::sleep(TICK);
            // Checked AFTER the sleep: turned off mid-sleep must not get one
            // last tick that reports a file saved while it was off.
            if !ENABLED.load(Ordering::SeqCst) {
                break;
            }
            if let Some(path) = watch.tick() {
                let _ = app.emit_to("main", events::SNAPSHOT, path.to_string_lossy());
            }
        }
    }
}

struct Watch {
    folders: Vec<PathBuf>,
    /// Folder -> the mtime it had when last listed.
    seen: HashMap<PathBuf, SystemTime>,
    /// Only files modified after this count.
    since: SystemTime,
    ticks: u32,
    #[cfg(target_os = "macos")]
    mac_location: Option<PathBuf>,
}

impl Watch {
    fn new() -> Self {
        #[cfg(target_os = "macos")]
        let mac_location = mac_capture_location();
        let mut w = Watch {
            folders: Vec::new(),
            seen: HashMap::new(),
            since: SystemTime::now(),
            ticks: 0,
            #[cfg(target_os = "macos")]
            mac_location,
        };
        w.folders = w.resolve_folders();
        w
    }

    fn tick(&mut self) -> Option<PathBuf> {
        self.ticks = self.ticks.wrapping_add(1);
        if self.ticks.is_multiple_of(REFRESH_FOLDERS_EVERY) {
            self.folders = self.resolve_folders();
        }
        let now = SystemTime::now();
        let mut newest: Option<(SystemTime, PathBuf)> = None;
        for dir in &self.folders {
            let Ok(mtime) = fs::metadata(dir).and_then(|m| m.modified()) else {
                continue;
            };
            if self.seen.get(dir) == Some(&mtime) {
                continue;
            }
            match newest_image(dir, self.since, now) {
                // Not settled: leave the folder unmarked so it is listed again.
                Scan::NotReady => continue,
                Scan::Found(t, p) => {
                    if newest.as_ref().is_none_or(|(nt, _)| t > *nt) {
                        newest = Some((t, p));
                    }
                }
                Scan::Nothing => {}
            }
            self.seen.insert(dir.clone(), mtime);
        }
        let (t, p) = newest?;
        self.since = t;
        Some(p)
    }

    fn resolve_folders(&self) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = Vec::new();

        #[cfg(target_os = "windows")]
        {
            out.extend(windows_screenshots_folder());
            if let Some(p) = dirs::picture_dir() {
                out.push(p.join("Screenshots"));
            }
            // OneDrive's "save screenshots I capture to OneDrive" writes here
            // even when Pictures itself is not redirected into OneDrive.
            if let Some(od) = std::env::var_os("OneDrive") {
                out.push(PathBuf::from(od).join("Pictures").join("Screenshots"));
            }
        }

        #[cfg(target_os = "macos")]
        out.extend(self.mac_location.clone().or_else(dirs::desktop_dir));

        #[cfg(not(any(target_os = "windows", target_os = "macos")))]
        {
            let pictures =
                dirs::picture_dir().or_else(|| dirs::home_dir().map(|h| h.join("Pictures")));
            if let Some(pics) = pictures {
                // GNOME and Spectacle save into a subfolder whose NAME is
                // translated ("Screenshots", "Tangkapan layar",
                // "Bildschirmfotos"), so take every direct child instead of
                // guessing it.
                if let Ok(rd) = fs::read_dir(&pics) {
                    for e in rd.flatten() {
                        let hidden = e.file_name().to_string_lossy().starts_with('.');
                        if !hidden && e.file_type().is_ok_and(|t| t.is_dir()) {
                            out.push(e.path());
                        }
                    }
                }
                out.push(pics);
            }
            // scrot, ImageMagick `import` and a session with no Pictures folder
            // save straight into $HOME.
            out.extend(dirs::home_dir());
        }

        out.retain(|p| p.is_dir());
        out.sort();
        out.dedup();
        out
    }
}

#[derive(Debug, PartialEq)]
enum Scan {
    Found(SystemTime, PathBuf),
    NotReady,
    Nothing,
}

/// The newest image in `dir` modified after `since`. Hidden files are skipped:
/// macOS writes `.Screenshot ...png` first and renames it into place.
fn newest_image(dir: &Path, since: SystemTime, now: SystemTime) -> Scan {
    let Ok(rd) = fs::read_dir(dir) else {
        return Scan::Nothing;
    };
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for e in rd.flatten() {
        let name = e.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || !is_image_name(&name) {
            continue;
        }
        let Ok(meta) = e.metadata() else { continue };
        let Ok(mtime) = meta.modified() else { continue };
        if !meta.is_file() || mtime <= since {
            continue;
        }
        if meta.len() == 0 || now.duration_since(mtime).unwrap_or_default() < SETTLE {
            return Scan::NotReady;
        }
        if best.as_ref().is_none_or(|(bt, _)| mtime > *bt) {
            best = Some((mtime, e.path()));
        }
    }
    best.map_or(Scan::Nothing, |(t, p)| Scan::Found(t, p))
}

fn is_image_name(name: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| IMAGE_EXTS.iter().any(|x| ext.eq_ignore_ascii_case(x)))
}

/// `FOLDERID_Screenshots`, which follows a user who moved the folder or had
/// Pictures redirected into OneDrive.
#[cfg(target_os = "windows")]
fn windows_screenshots_folder() -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_Screenshots, SHGetKnownFolderPath};

    let mut raw: windows_sys::core::PWSTR = std::ptr::null_mut();
    // SAFETY: `raw` is an out-pointer the call fills with a NUL-terminated
    // CoTaskMem string; it is read only on success and freed on every path, as
    // the API requires (CoTaskMemFree accepts null).
    unsafe {
        let hr = SHGetKnownFolderPath(&FOLDERID_Screenshots, 0, std::ptr::null_mut(), &mut raw);
        let path = if hr >= 0 && !raw.is_null() {
            let len = (0..).take_while(|&i| *raw.add(i) != 0).count();
            Some(PathBuf::from(OsString::from_wide(
                std::slice::from_raw_parts(raw, len),
            )))
        } else {
            None
        };
        CoTaskMemFree(raw as *const _);
        path
    }
}

/// Where the user pointed macOS screenshots (Screenshot.app > Options > Save
/// to). Unset means the Desktop.
#[cfg(target_os = "macos")]
fn mac_capture_location() -> Option<PathBuf> {
    let out = std::process::Command::new("defaults")
        .args(["read", "com.apple.screencapture", "location"])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    match raw.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().map(|h| h.join(rest)),
        None => Some(PathBuf::from(raw)),
    }
}

/// Start a native OS drag of the screenshot at `path`, so it can be dropped
/// anywhere: a TEDI terminal (which types its path through the ordinary file
/// drop handler), the AI composer, an editor pane, Explorer / Finder / Files, a
/// browser upload, a chat app.
///
/// The webview calls it on the first pointer move past a threshold, while the
/// button is still down, and it runs on the UI thread because every platform's
/// drag loop does. `image` is a small PNG data URL for the drag ghost: macOS and
/// GTK draw the image at its natural size, so the screenshot itself would be a
/// screen-sized ghost. Windows ignores it and lets the shell draw its own, as an
/// Explorer drag does.
#[tauri::command]
pub async fn snapshot_drag(
    window: tauri::Window,
    path: String,
    image: Option<String>,
) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() || !path.is_file() {
        return Err(format!("not a file: {}", path.display()));
    }
    let w = window.clone();
    window
        .run_on_main_thread(move || {
            if let Err(e) = start_native_drag(&w, &path, image) {
                log::warn!("snapshot drag of {} failed: {e}", path.display());
            }
        })
        .map_err(|e| e.to_string())
}

/// The shell's own data object for the file plus `SHDoDragDrop` with its default
/// drop source: Explorer's exact drag, thumbnail included, in a few calls and on
/// the `windows` crate already in the tree (the `drag` crate would add a second,
/// older copy of it).
#[cfg(target_os = "windows")]
fn start_native_drag(
    window: &tauri::Window,
    path: &Path,
    _image: Option<String>,
) -> Result<(), String> {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Ole::{IDropSource, DROPEFFECT_COPY, DROPEFFECT_LINK};
    use windows::Win32::UI::Shell::SHDoDragDrop;

    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let data = shell_data_object(path).map_err(|e| e.to_string())?;
    // SAFETY: called on the UI thread, which tao has OLE-initialised for the
    // window's own drop target. SHDoDragDrop runs the modal drag loop and
    // returns when the drag ends; `None` asks for the shell's default source.
    unsafe {
        SHDoDragDrop(
            Some(HWND(hwnd.0)),
            &data,
            None::<&IDropSource>,
            DROPEFFECT_COPY | DROPEFFECT_LINK,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The data object Explorer itself would put on a drag of `path`.
#[cfg(target_os = "windows")]
fn shell_data_object(
    path: &Path,
) -> windows::core::Result<windows::Win32::System::Com::IDataObject> {
    use windows::core::HSTRING;
    use windows::Win32::System::Com::IBindCtx;
    use windows::Win32::UI::Shell::{BHID_DataObject, IShellItem, SHCreateItemFromParsingName};
    // SAFETY: plain COM calls on an initialised apartment; both interfaces are
    // owned by their wrappers and released on drop.
    unsafe {
        let item: IShellItem =
            SHCreateItemFromParsingName(&HSTRING::from(path), None::<&IBindCtx>)?;
        item.BindToHandler(None::<&IBindCtx>, &BHID_DataObject)
    }
}

/// The drag ghost: the webview's thumbnail, else the file itself.
#[cfg(not(target_os = "windows"))]
fn drag_icon(path: &Path, image: Option<String>) -> drag::Image {
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    image
        .as_deref()
        .and_then(|d| d.strip_prefix("data:image/png;base64,"))
        .and_then(|b| B64.decode(b).ok())
        .map_or_else(|| drag::Image::File(path.to_path_buf()), drag::Image::Raw)
}

#[cfg(target_os = "macos")]
fn start_native_drag(
    window: &tauri::Window,
    path: &Path,
    image: Option<String>,
) -> Result<(), String> {
    drag::start_drag(
        window,
        drag::DragItem::Files(vec![path.to_path_buf()]),
        drag_icon(path, image),
        |_, _| {},
        drag::Options::default(),
    )
    .map_err(|e| e.to_string())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn start_native_drag(
    window: &tauri::Window,
    path: &Path,
    image: Option<String>,
) -> Result<(), String> {
    // The GTK backend writes `file://{path}` WITHOUT percent-encoding, so a name
    // with a space ("Screenshot From 2026-09-14 10-00-00.png") would be a broken
    // URI. Hand it the already-encoded path instead.
    let encoded = gtk_uri_path(path)
        .ok_or_else(|| format!("cannot build a file URI for {}", path.display()))?;
    let gtk_window = window.gtk_window().map_err(|e| e.to_string())?;
    drag::start_drag(
        &gtk_window,
        drag::DragItem::Files(vec![encoded]),
        drag_icon(path, image),
        |_, _| {},
        drag::Options::default(),
    )
    .map_err(|e| e.to_string())
}

/// `path` percent-encoded the way it must appear after `file://`.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn gtk_uri_path(path: &Path) -> Option<PathBuf> {
    let url = url::Url::from_file_path(path).ok()?;
    url.as_str().strip_prefix("file://").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_image_waits_for_settle_and_skips_noise() {
        let dir = std::env::temp_dir().join(format!("tedi-snapshot-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let before = SystemTime::now() - Duration::from_secs(5);

        fs::write(dir.join("notes.txt"), b"x").unwrap();
        fs::write(dir.join(".Screenshot hidden.png"), b"x").unwrap();
        fs::write(dir.join("empty.png"), b"").unwrap();
        // An empty image is a write in progress.
        assert_eq!(
            newest_image(&dir, before, SystemTime::now()),
            Scan::NotReady
        );
        fs::remove_file(dir.join("empty.png")).unwrap();

        fs::write(dir.join("Screenshot 1.PNG"), b"png").unwrap();
        let mtime = fs::metadata(dir.join("Screenshot 1.PNG"))
            .unwrap()
            .modified()
            .unwrap();
        // Too young: may still be written.
        assert_eq!(newest_image(&dir, before, mtime), Scan::NotReady);
        let later = mtime + Duration::from_secs(2);
        assert_eq!(
            newest_image(&dir, before, later),
            Scan::Found(mtime, dir.join("Screenshot 1.PNG"))
        );
        // Already reported: nothing new.
        assert_eq!(newest_image(&dir, mtime, later), Scan::Nothing);

        let _ = fs::remove_dir_all(&dir);
    }

    /// GNOME names captures "Screenshot From <date> <time>.png"; the GTK drag
    /// backend pastes this straight after `file://`, so the spaces must arrive
    /// already encoded.
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    #[test]
    fn gtk_uri_path_percent_encodes_spaces() {
        assert_eq!(
            gtk_uri_path(Path::new(
                "/home/u/Pictures/Screenshots/Screenshot From 2026-09-14 10-00-00.png"
            )),
            Some(PathBuf::from(
                "/home/u/Pictures/Screenshots/Screenshot%20From%202026-09-14%2010-00-00.png"
            ))
        );
    }

    /// What a drop target reads off the drag: the file as `CF_HDROP`, the format
    /// TEDI's own drop handler, Explorer and every file-accepting app take. A
    /// name with spaces, as Windows screenshots have.
    #[cfg(target_os = "windows")]
    #[test]
    fn shell_data_object_offers_the_file_as_hdrop() {
        use windows::Win32::System::Com::{
            CoInitializeEx, COINIT_APARTMENTTHREADED, DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL,
        };
        use windows::Win32::System::Ole::CF_HDROP;

        let dir = std::env::temp_dir().join(format!("tedi-snapshot-drag-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Screenshot 2026-09-14 101500.png");
        fs::write(&file, b"png").unwrap();

        // SAFETY: initialises COM for this test thread only.
        let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        let data = shell_data_object(&file).expect("shell data object");
        let format = FORMATETC {
            cfFormat: CF_HDROP.0,
            ptd: std::ptr::null_mut(),
            dwAspect: DVASPECT_CONTENT.0,
            lindex: -1,
            tymed: TYMED_HGLOBAL.0 as u32,
        };
        // SAFETY: `format` is a valid FORMATETC for the duration of the call.
        assert!(unsafe { data.QueryGetData(&format) }.is_ok());

        drop(data);
        let _ = fs::remove_dir_all(&dir);
    }
}
