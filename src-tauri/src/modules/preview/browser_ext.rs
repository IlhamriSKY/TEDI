//! Browser extensions for the preview pane.
//
// The pane is a real Chromium webview on Windows (WebView2), so it can run
// ordinary unpacked Chrome / Edge extensions. This module is deliberately a
// generic installer and manager: it knows how to fetch, unpack, validate,
// enable, disable and remove *an extension*, and nothing here knows or cares
// what any particular extension does.
//
// Content blocking is the case that motivated it, and the one worth naming
// because it is why the design is shaped this way: rather than TEDI shipping and
// maintaining a blocker plus its filter lists, the user installs the blocker they
// already trust and it updates its own lists. A password manager, a reader-mode
// tool or an internal corporate extension all install through exactly the same
// path, and adding one requires no code here.
//
// Three directories under `app_data_dir`:
//
//   browser-extensions/       every subfolder is one ACTIVE unpacked extension.
//                             This is what `extensions_path` points at; wry
//                             calls `AddBrowserExtension` on each entry it finds.
//   browser-extensions-off/   parked extensions. Toggling MOVES the folder
//                             between the two, because wry adds every entry in
//                             the directory and offers no per-extension disable.
//   browser-profile/          the pane's OWN WebView2 user data folder.
//
// That last directory is not a nicety. WebView2 keeps
// `AreBrowserExtensionsEnabled` on the ENVIRONMENT, and Tauri's own config docs
// say webviews differing on it "must have different data directories" (the same
// trap that made a child webview render blank when its browser args differed,
// tauri#13092). Giving the pane its own profile satisfies that requirement, and
// it also means an installed extension can never run inside TEDI's own webview,
// which is the one holding Tauri IPC. The pane keeps the app's default profile
// until the first extension is installed, so users who never touch this feature
// never get a new profile and never lose a logged-in session.
//
// WINDOWS ONLY. macOS WKWebView has no extension support at all, and on Linux
// `extensions_path` means compiled WebKitGTK `.so` plugins, not Chrome
// extensions, so a Chrome extension zip would silently do nothing there.
// Firefox `.xpi` add-ons never work: this is Chromium, not Gecko.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use tauri::Manager;
use zip::ZipArchive;

use crate::modules::extensions::github;

/// Cap on a downloaded extension archive. Real ones are single-digit to low
/// tens of MB (the two blockers measured below are 4.2 and 9.3 MB compressed), so
/// 64 MB leaves generous room while keeping a mistyped url from streaming a disk
/// image into app data.
const MAX_ARCHIVE_BYTES: u64 = 64 * 1024 * 1024;

/// Cap on the UNPACKED size, counted from bytes actually written rather than
/// from what each entry claims, so a crafted archive cannot lie its way past it.
/// Without this a 64 MB download can expand to gigabytes straight into app data.
/// Measured against the real thing: uBlock Origin unpacks to 14.5 MB (3.4x) and
/// uBlock Origin Lite to 34.4 MB (3.7x), so this leaves several times the headroom
/// any genuine extension needs while a zip bomb runs into it immediately.
const MAX_UNPACKED_BYTES: u64 = 256 * 1024 * 1024;

/// Cap on entry count. The byte cap alone does not bound this: empty entries cost
/// nothing to unpack, so a 64 MB archive can still declare millions of them and
/// leave millions of files in app data. Real extensions are nowhere near it
/// (uBlock Origin Lite ships 1019 entries).
const MAX_ENTRIES: usize = 20_000;

const ACTIVE_DIR: &str = "browser-extensions";
const PARKED_DIR: &str = "browser-extensions-off";
const PROFILE_DIR: &str = "browser-profile";

/// Where an archive is unpacked before it is accepted. Deliberately a SIBLING of
/// [`ACTIVE_DIR`] rather than a folder inside it: wry hands every entry under
/// `extensions_path` to `AddBrowserExtension`, and `list` walks the same
/// directory, so a staging tree left behind by a crash would be offered to
/// WebView2 as a real extension and shown as installed. Both directories live
/// under app data, so accepting an install is still a same-volume rename.
const STAGING_DIR: &str = "browser-extensions-staging";

/// How long a staging tree may sit before it is treated as crash debris. Only
/// disk hygiene: nothing reads these, but an abandoned one can be 256 MB.
const STAGING_STALE_MS: u128 = 10 * 60 * 1000;

/// Where the install source is remembered, inside the extension folder so it
/// travels with the extension when it is enabled, disabled, or removed. A
/// leading dot keeps it out of Chromium's way (`_` prefixes are reserved, `.` is
/// not), and it is only ever read back to offer a re-fetch.
const SOURCE_FILE: &str = ".tedi-source";

/// One installed browser extension, as the Settings UI sees it.
#[derive(serde::Serialize)]
pub struct BrowserExt {
    /// Folder name under the active / parked directory. Also the remove +
    /// toggle handle, so it is always a single path segment.
    dir: String,
    name: String,
    version: String,
    /// 2 or 3. Chromium is removing Manifest V2 support, so the UI warns on 2.
    manifest_version: u64,
    enabled: bool,
    /// What it was installed from, when that is re-fetchable (a url or a GitHub
    /// slug). Empty for a local file, which may have moved since. Drives the
    /// Update action; nothing else depends on it.
    source: String,
}

/// Everything the Settings card needs in one round trip: whether this platform
/// can run browser extensions at all, where they live (for a "reveal in folder"
/// action), and what is currently installed.
#[derive(serde::Serialize)]
pub struct BrowserExtInfo {
    supported: bool,
    /// Empty when the directory could not be resolved.
    #[serde(rename = "extensionsDir")]
    extensions_dir: String,
    items: Vec<BrowserExt>,
}

/// Whether the host webview can load Chrome extensions. See the module note:
/// only WebView2 can, so this is a compile-time constant, not a runtime probe.
const fn platform_supported() -> bool {
    cfg!(target_os = "windows")
}

fn root(app: &tauri::AppHandle, which: &str) -> Result<PathBuf, String> {
    let mut p = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    p.push(which);
    if !p.exists() {
        fs::create_dir_all(&p).map_err(|e| format!("mkdir {which}: {e}"))?;
    }
    Ok(p)
}

/// The extensions + profile directories to hand the preview webview builder, or
/// `None` when the feature is inert: unsupported platform, or no extension
/// installed and enabled. Returning `None` is what keeps an untouched install on
/// the app's default profile.
pub fn active_dirs(app: &tauri::AppHandle) -> Option<(PathBuf, PathBuf)> {
    if !platform_supported() {
        return None;
    }
    let active = root(app, ACTIVE_DIR).ok()?;
    // An empty directory must read as "off": handing `extensions_path` to wry
    // still flips the environment onto the extension profile, which would move
    // the pane off the app profile for no benefit.
    let has_any = fs::read_dir(&active)
        .ok()?
        .flatten()
        .any(|e| e.path().join("manifest.json").is_file());
    if !has_any {
        return None;
    }
    Some((active, root(app, PROFILE_DIR).ok()?))
}

/// Read `manifest.json` out of an installed extension folder. `None` when the
/// folder is not an extension (no manifest, or one we cannot parse), which is
/// how a half-extracted or hand-dropped folder gets skipped instead of listed.
fn read_manifest(dir: &Path, enabled: bool) -> Option<BrowserExt> {
    let raw = fs::read_to_string(dir.join("manifest.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let declared = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
    Some(BrowserExt {
        dir: dir.file_name()?.to_string_lossy().into_owned(),
        name: resolve_i18n(
            dir,
            declared,
            v.get("default_locale").and_then(|x| x.as_str()),
        )
        .unwrap_or_else(|| {
            if declared.is_empty() {
                "(unnamed)".to_string()
            } else {
                declared.to_string()
            }
        }),
        version: v
            .get("version")
            .and_then(|x| x.as_str())
            .unwrap_or("?")
            .to_string(),
        manifest_version: v
            .get("manifest_version")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        enabled,
        // Capped on read: this is echoed straight into the UI, and the file is
        // ordinary user-writable data rather than something we produced here.
        source: fs::read_to_string(dir.join(SOURCE_FILE))
            .map(|s| s.trim().chars().take(300).collect())
            .unwrap_or_default(),
    })
}

/// Resolve a `__MSG_key__` placeholder against the extension's own
/// `_locales/<locale>/messages.json`, returning `None` for anything that is not
/// a placeholder or cannot be looked up.
///
/// Chrome extensions localize their display name this way and the real ones do
/// use it: uBlock Origin Lite's manifest says `__MSG_extName__`, so without this
/// the Settings list would show that literal token and the install folder would
/// be named after it.
///
/// `locale` comes out of the extension's own manifest, so it is untrusted input
/// on a path join; anything but a plain locale identifier is refused rather than
/// allowed to walk out of the extension directory.
fn resolve_i18n(dir: &Path, value: &str, locale: Option<&str>) -> Option<String> {
    let key = value.strip_prefix("__MSG_")?.strip_suffix("__")?;
    if key.is_empty() {
        return None;
    }
    let plain = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    // The declared locale first, then English: an extension can declare `en`
    // while shipping only `en_US`, or the other way round.
    let declared = locale.filter(|s| plain(s));
    for cand in declared.into_iter().chain(["en", "en_US"]) {
        let raw = match fs::read_to_string(dir.join("_locales").join(cand).join("messages.json")) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if let Some(msg) = v
            .get(key)
            .and_then(|m| m.get("message"))
            .and_then(|m| m.as_str())
        {
            let msg = msg.trim();
            if !msg.is_empty() {
                return Some(msg.to_string());
            }
        }
    }
    None
}

fn list_dir(app: &tauri::AppHandle, which: &str, enabled: bool) -> Vec<BrowserExt> {
    let Ok(base) = root(app, which) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut out: Vec<BrowserExt> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| read_manifest(&e.path(), enabled))
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// List installed browser extensions, active ones first.
#[tauri::command]
pub async fn browser_ext_list(app: tauri::AppHandle) -> Result<BrowserExtInfo, String> {
    if !platform_supported() {
        return Ok(BrowserExtInfo {
            supported: false,
            extensions_dir: String::new(),
            items: Vec::new(),
        });
    }
    let mut items = list_dir(&app, ACTIVE_DIR, true);
    items.extend(list_dir(&app, PARKED_DIR, false));
    Ok(BrowserExtInfo {
        supported: true,
        extensions_dir: root(&app, ACTIVE_DIR)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
        items,
    })
}

/// Reject a handle that is not a single, ordinary path segment, so a folder name
/// arriving from the frontend can only ever resolve inside our own root.
fn safe_segment(dir: &str) -> Result<&str, String> {
    let d = dir.trim();
    if d.is_empty()
        || d == "."
        || d == ".."
        || d.contains('/')
        || d.contains('\\')
        || d.contains(':')
    {
        return Err("invalid extension folder".into());
    }
    Ok(d)
}

/// Move an extension between the active and parked directories. wry adds every
/// entry under `extensions_path`, so moving the folder is the only per-extension
/// off switch available.
#[tauri::command]
pub async fn browser_ext_set_enabled(
    app: tauri::AppHandle,
    dir: String,
    enabled: bool,
) -> Result<(), String> {
    let seg = safe_segment(&dir)?;
    let (from, to) = if enabled {
        (PARKED_DIR, ACTIVE_DIR)
    } else {
        (ACTIVE_DIR, PARKED_DIR)
    };
    let src = root(&app, from)?.join(seg);
    if !src.is_dir() {
        return Ok(()); // already on the requested side
    }
    let dst = root(&app, to)?.join(seg);
    if dst.exists() {
        fs::remove_dir_all(&dst).map_err(|e| format!("replace {to}/{seg}: {e}"))?;
    }
    // Same parent directory tree, so a rename is a metadata move. It can still
    // fail across volumes if app data is a junction; copy is not worth the code
    // until someone actually hits it.
    fs::rename(&src, &dst).map_err(|e| format!("move extension: {e}"))
}

/// Delete an installed extension from disk, whether it is active or parked.
#[tauri::command]
pub async fn browser_ext_remove(app: tauri::AppHandle, dir: String) -> Result<(), String> {
    let seg = safe_segment(&dir)?;
    let mut removed = false;
    for which in [ACTIVE_DIR, PARKED_DIR] {
        let p = root(&app, which)?.join(seg);
        if p.is_dir() {
            fs::remove_dir_all(&p).map_err(|e| format!("remove {which}/{seg}: {e}"))?;
            removed = true;
        }
    }
    if removed {
        Ok(())
    } else {
        Err("no such extension".into())
    }
}

/// Install an unpacked Chrome / Edge extension from `source`, which is either a
/// direct `https://` link to a `.zip` or `.crx`, or a GitHub `owner/repo` whose
/// latest release ships one. Returns the installed entry.
#[tauri::command]
pub async fn browser_ext_install(
    app: tauri::AppHandle,
    source: String,
) -> Result<BrowserExt, String> {
    require_platform()?;
    let url = resolve_source(&source).await?;
    reject_wrong_engine(&url)?;
    // A url the user typed is a trust boundary. Refuse the cloud-metadata and
    // link-local addresses that turn "fetch an extension" into an SSRF probe -
    // the same guard `preview_resolve_favicon` applies for the same reason.
    crate::modules::net::reject_metadata_ssrf(&url).await?;
    let bytes = github::http_get_bytes_capped(&url, MAX_ARCHIVE_BYTES).await?;
    let src = source.trim().to_string();
    // Unpacking is blocking file I/O of up to MAX_UNPACKED_BYTES. The download
    // above is async, but this part would sit on an async-runtime worker for the
    // duration, so it goes to the blocking pool like the rest of TEDI's file work.
    tauri::async_runtime::spawn_blocking(move || install_archive(&app, &bytes, &src))
        .await
        .map_err(|e| format!("install task: {e}"))?
}

/// Install from a `.zip` / `.crx` already on disk.
///
/// Nothing about this feature is about downloading: an extension pulled from a
/// store by hand, built locally, or handed over internally has to be installable
/// too, so the file picker is a first-class path rather than a fallback.
#[tauri::command]
pub async fn browser_ext_install_file(
    app: tauri::AppHandle,
    path: String,
) -> Result<BrowserExt, String> {
    require_platform()?;
    reject_wrong_engine(&path)?;
    // Read + unpack are both blocking; keep them off the async runtime's workers.
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| format!("read {path}: {e}"))?;
        if meta.len() > MAX_ARCHIVE_BYTES {
            return Err(format!(
                "archive is larger than the {} MB limit",
                MAX_ARCHIVE_BYTES / (1024 * 1024)
            ));
        }
        let bytes = fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
        // Deliberately records no source: a local file can be moved or replaced
        // between now and any later re-fetch, so offering Update would be a lie.
        install_archive(&app, &bytes, "")
    })
    .await
    .map_err(|e| format!("install task: {e}"))?
}

/// Delete staging trees old enough to be crash debris. Best effort throughout: a
/// failed sweep must never block an install, and skipping a young one is what
/// keeps a concurrent install from having its tree pulled out from under it.
fn sweep_stale_staging(staging_root: &Path) {
    let Ok(entries) = fs::read_dir(staging_root) else {
        return;
    };
    for e in entries.flatten() {
        let stale = e
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| {
                t.elapsed()
                    .map(|d| d.as_millis() > STAGING_STALE_MS)
                    // A clock that moved backwards makes `elapsed` fail; leaving
                    // the tree alone is the harmless choice.
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

fn require_platform() -> Result<(), String> {
    if platform_supported() {
        Ok(())
    } else {
        Err("browser extensions only run in the WebView2 pane, so this is Windows-only".into())
    }
}

/// Unpack, validate, and move an extension archive into place, whatever it came
/// from. `source` is recorded next to the manifest so the UI can offer Update
/// later; pass an empty string when there is nothing re-fetchable.
fn install_archive(
    app: &tauri::AppHandle,
    bytes: &[u8],
    source: &str,
) -> Result<BrowserExt, String> {
    let zip = strip_crx_header(bytes);

    // Stage first: an install that fails validation must not leave a partial
    // extension sitting where wry would try to load it.
    let active = root(app, ACTIVE_DIR)?;
    let staging_root = root(app, STAGING_DIR)?;
    sweep_stale_staging(&staging_root);
    // Per-call unique: the UI serializes installs, but the commands are plain IPC
    // and two overlapping calls sharing one staging path would interleave their
    // files and install a chimera.
    static STAGING_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = STAGING_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let staging = staging_root.join(format!("{}-{seq}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    let staged = extract_extension(zip, &staging, MAX_UNPACKED_BYTES).and_then(|()| {
        let m = read_manifest(&staging, true)
            .ok_or_else(|| "archive has no readable manifest.json".to_string())?;
        if !matches!(m.manifest_version, 2 | 3) {
            return Err("manifest.json has no usable manifest_version (expected 2 or 3)".into());
        }
        Ok(m)
    });
    let manifest = match staged {
        Ok(m) => m,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    if !source.is_empty() {
        // Best effort: a recorded source only enables a convenience action, so a
        // read-only staging tree must not fail the whole install.
        let _ = fs::write(staging.join(SOURCE_FILE), source);
    }

    let slug = slugify(&manifest.name);
    let dest = active.join(&slug);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| format!("replace {slug}: {e}"))?;
    }
    fs::rename(&staging, &dest).map_err(|e| {
        let _ = fs::remove_dir_all(&staging);
        format!("move into place: {e}")
    })?;
    // A parked copy under the same slug would shadow this one on the next
    // toggle, so clear it.
    if let Ok(parked) = root(app, PARKED_DIR) {
        let _ = fs::remove_dir_all(parked.join(&slug));
    }
    read_manifest(&dest, true).ok_or_else(|| "installed but unreadable".to_string())
}

/// Reject an archive built for an engine WebView2 is not.
///
/// This matters more than it looks. A Firefox `.xpi` at least fails to load, but
/// a Safari or Gecko *zip* installs cleanly, appears in the list, and then does
/// nothing at all, which reads as an extension that is installed and working when
/// it is neither. Cross-browser projects commonly publish every engine side by
/// side (uBlock Origin Lite ships chromium, edge, firefox and safari builds in one
/// release), and the release resolver just takes the first `.zip`, so an upstream
/// reorder is enough to pick the wrong one. Only the file name is inspected, and
/// an explicit `chromium` in it wins, since Edge builds are Chromium too.
fn reject_wrong_engine(url: &str) -> Result<(), String> {
    // Split on both separators: this also vets a local file PATH, and on Windows
    // `C:\safari-builds\ub.zip` would otherwise be read whole and refused for a
    // directory name that says nothing about the archive.
    let file = url
        .split('?')
        .next()
        .unwrap_or(url)
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_lowercase();
    if file.ends_with(".xpi") {
        return Err(
            "that is a Firefox (.xpi) add-on; this pane is Chromium, so use the chromium build"
                .into(),
        );
    }
    if file.contains("chromium") {
        return Ok(());
    }
    for engine in ["safari", "firefox", "gecko"] {
        if file.contains(engine) {
            return Err(format!(
                "`{file}` looks like a {engine} build, which loads but blocks nothing here - \
                 paste the direct url of the chromium asset instead"
            ));
        }
    }
    Ok(())
}

/// Turn an install source into a download url. A GitHub slug is resolved
/// through the existing release resolver (REST API, with two HTML fallbacks for
/// when anonymous API calls are rate limited).
async fn resolve_source(source: &str) -> Result<String, String> {
    let s = source.trim();
    if s.is_empty() {
        return Err("enter a .zip / .crx url or a GitHub owner/repo".into());
    }
    let lower = s.to_lowercase();
    if lower.starts_with("https://") {
        return Ok(s.to_string());
    }
    if lower.starts_with("http://") {
        return Err("use an https:// url".into());
    }
    let slug = github::normalize_owner_repo(s)?;
    let (_tag, zip) = github::resolve_latest_release(&slug).await?;
    Ok(zip)
}

/// A `.crx` is a signed header followed by an ordinary zip. Strip the header so
/// the same extraction path handles both formats; a plain zip passes through.
///
/// CRX3: `Cr24` | version=3 | header_len | header | zip
/// CRX2: `Cr24` | version=2 | pubkey_len | sig_len | pubkey | sig | zip
fn strip_crx_header(bytes: &[u8]) -> &[u8] {
    if bytes.len() < 16 || &bytes[0..4] != b"Cr24" {
        return bytes;
    }
    let u32_at = |o: usize| -> usize {
        u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]) as usize
    };
    let offset = match u32_at(4) {
        3 => 12usize.checked_add(u32_at(8)),
        2 => 16usize
            .checked_add(u32_at(8))
            .and_then(|n| n.checked_add(u32_at(12))),
        _ => None,
    };
    match offset {
        Some(o) if o <= bytes.len() => &bytes[o..],
        // Malformed header: hand the whole thing to the zip reader, which will
        // produce a clearer error than a silent empty extraction.
        _ => bytes,
    }
}

/// Extract an extension archive into `dest` so that `dest/manifest.json` exists.
///
/// Extension zips come both ways: files at the root, or everything nested under
/// one folder (uBlock Origin's chromium build does the latter). Rather than
/// guess, find the SHALLOWEST `manifest.json` and treat its parent as the root,
/// dropping anything outside it. `enclosed_name` is the zip crate's own
/// traversal guard, so `../` entries are skipped rather than escaping `dest`.
fn extract_extension(zip_bytes: &[u8], dest: &Path, max_unpacked: u64) -> Result<(), String> {
    let mut archive =
        ZipArchive::new(io::Cursor::new(zip_bytes)).map_err(|e| format!("not a zip: {e}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err(format!(
            "archive declares {} entries, over the {MAX_ENTRIES} limit",
            archive.len()
        ));
    }

    let mut prefix: Option<String> = None;
    let mut best_depth = usize::MAX;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("entry {i}: {e}"))?;
        let Some(p) = entry.enclosed_name() else {
            continue;
        };
        let s = p.to_string_lossy().replace('\\', "/");
        if !s.ends_with("manifest.json") {
            continue;
        }
        let depth = s.matches('/').count();
        if depth < best_depth {
            best_depth = depth;
            prefix = Some(s.trim_end_matches("manifest.json").to_string());
        }
    }
    let prefix = prefix.ok_or_else(|| "archive contains no manifest.json".to_string())?;

    fs::create_dir_all(dest).map_err(|e| format!("mkdir staging: {e}"))?;
    let mut written: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("entry {i}: {e}"))?;
        let Some(p) = entry.enclosed_name() else {
            continue;
        };
        let s = p.to_string_lossy().replace('\\', "/");
        let Some(rel) = s.strip_prefix(&prefix) else {
            continue; // outside the extension root (a sibling folder in the zip)
        };
        if rel.is_empty() {
            continue;
        }
        let out = dest.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| format!("mkdir {rel}: {e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {rel} parent: {e}"))?;
        }
        let mut f = fs::File::create(&out).map_err(|e| format!("create {rel}: {e}"))?;
        // Count what was really written, not what the entry claims, so a header
        // that understates its payload cannot walk past MAX_UNPACKED_BYTES. The
        // caller deletes the staging tree on error, so a bomb leaves nothing.
        written = written
            .saturating_add(io::copy(&mut entry, &mut f).map_err(|e| format!("write {rel}: {e}"))?);
        if written > max_unpacked {
            return Err(format!(
                "unpacked size exceeds the {} MB limit",
                max_unpacked / (1024 * 1024)
            ));
        }
    }
    Ok(())
}

/// Filesystem-safe folder name derived from an extension's declared name. Used
/// as the install directory and as the toggle / remove handle.
fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "extension".to_string()
    } else {
        trimmed.chars().take(48).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crx_headers_are_stripped_to_the_zip() {
        // A plain zip passes through untouched.
        let plain = b"PK\x03\x04rest-of-a-zip";
        assert_eq!(strip_crx_header(plain), plain);

        // CRX3: magic, version 3, header_len 4, 4 header bytes, then the zip.
        let mut crx3 = Vec::new();
        crx3.extend_from_slice(b"Cr24");
        crx3.extend_from_slice(&3u32.to_le_bytes());
        crx3.extend_from_slice(&4u32.to_le_bytes());
        crx3.extend_from_slice(b"HDR!");
        crx3.extend_from_slice(b"PK\x03\x04zip");
        assert_eq!(strip_crx_header(&crx3), b"PK\x03\x04zip");

        // CRX2: magic, version 2, pubkey_len 2, sig_len 3, then both, then zip.
        let mut crx2 = Vec::new();
        crx2.extend_from_slice(b"Cr24");
        crx2.extend_from_slice(&2u32.to_le_bytes());
        crx2.extend_from_slice(&2u32.to_le_bytes());
        crx2.extend_from_slice(&3u32.to_le_bytes());
        crx2.extend_from_slice(b"KKSSS");
        crx2.extend_from_slice(b"PK\x03\x04zip");
        assert_eq!(strip_crx_header(&crx2), b"PK\x03\x04zip");

        // A header longer than the file must not panic or slice out of bounds.
        let mut bogus = Vec::new();
        bogus.extend_from_slice(b"Cr24");
        bogus.extend_from_slice(&3u32.to_le_bytes());
        bogus.extend_from_slice(&u32::MAX.to_le_bytes());
        bogus.extend_from_slice(b"tail");
        assert_eq!(strip_crx_header(&bogus), bogus.as_slice());
    }

    #[test]
    fn non_chromium_builds_are_refused() {
        // The real asset names from a uBlock Origin Lite release, where all four
        // engines ship in one set and the resolver only picks the first zip.
        let base = "https://github.com/uBlockOrigin/uBOL-home/releases/download/x/";
        assert!(reject_wrong_engine(&format!("{base}uBOLite_x.chromium.zip")).is_ok());
        assert!(reject_wrong_engine(&format!("{base}uBOLite_x.edge.zip")).is_ok());
        assert!(reject_wrong_engine(&format!("{base}uBOLite_x.safari.zip")).is_err());
        assert!(reject_wrong_engine(&format!("{base}uBOLite_x.firefox.xpi")).is_err());
        assert!(reject_wrong_engine(&format!("{base}uBlock0_x.firefox.signed.xpi")).is_err());
        // Only the file name is inspected, so a directory that happens to be
        // called "safari-notes" is not a false positive.
        assert!(reject_wrong_engine("https://x.dev/safari-notes/ub.zip").is_ok());
        // And an explicit chromium marker wins over any other token present.
        assert!(reject_wrong_engine("https://x.dev/ub.chromium.safari-fix.zip").is_ok());
        // A query string must not hide the extension.
        assert!(reject_wrong_engine("https://x.dev/ub.xpi?token=1").is_err());
        // The same check vets a local file path, so Windows separators have to be
        // understood: without that, this folder name would refuse a fine archive.
        assert!(reject_wrong_engine(r"C:\Users\me\safari-builds\ub.zip").is_ok());
        assert!(reject_wrong_engine(r"C:\Downloads\uBOLite.safari.zip").is_err());
        assert!(reject_wrong_engine(r"C:\Downloads\uBlock0.chromium.zip").is_ok());
    }

    /// Scratch directory for a test that needs real files. Named per test so the
    /// suite's threads cannot collide.
    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("tedi-browser-ext-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    fn zip_with(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use zip::write::SimpleFileOptions;
        let mut buf = io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            let opts =
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (name, body) in entries {
                w.start_file(*name, opts).unwrap();
                std::io::Write::write_all(&mut w, body).unwrap();
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn both_real_archive_shapes_extract_to_a_usable_root() {
        // uBlock Origin's chromium build nests everything under one folder...
        let nested = zip_with(&[
            (
                "uBlock0.chromium/manifest.json",
                br#"{"name":"uBlock Origin","version":"1.72.2","manifest_version":2}"#,
            ),
            ("uBlock0.chromium/js/start.js", b"// code"),
        ]);
        let dir = scratch("nested");
        extract_extension(&nested, &dir, MAX_UNPACKED_BYTES).unwrap();
        assert!(
            dir.join("manifest.json").is_file(),
            "manifest must land at the root"
        );
        assert!(
            dir.join("js/start.js").is_file(),
            "nested files must be kept"
        );
        assert!(
            !dir.join("uBlock0.chromium").exists(),
            "the wrapper folder must be stripped"
        );
        let m = read_manifest(&dir, true).unwrap();
        assert_eq!(m.name, "uBlock Origin");
        assert_eq!(m.manifest_version, 2);
        let _ = fs::remove_dir_all(&dir);

        // ...while uBlock Origin Lite puts manifest.json at the root instead, so
        // the prefix is empty and nothing may be stripped.
        let flat = zip_with(&[
            (
                "manifest.json",
                br#"{"name":"uBOL","version":"1","manifest_version":3}"#,
            ),
            ("js/start.js", b"// code"),
        ]);
        let dir = scratch("flat");
        extract_extension(&flat, &dir, MAX_UNPACKED_BYTES).unwrap();
        assert!(dir.join("manifest.json").is_file());
        assert!(dir.join("js/start.js").is_file());
        assert_eq!(read_manifest(&dir, true).unwrap().manifest_version, 3);
        let _ = fs::remove_dir_all(&dir);

        // An archive with no manifest at all is refused, not silently extracted.
        let dir = scratch("nomanifest");
        assert!(extract_extension(
            &zip_with(&[("readme.txt", b"hi")]),
            &dir,
            MAX_UNPACKED_BYTES
        )
        .is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_oversized_unpack_is_stopped_partway() {
        let payload = vec![0u8; 1024 * 1024];
        let big = zip_with(&[
            (
                "manifest.json",
                br#"{"name":"x","version":"1","manifest_version":3}"#,
            ),
            ("payload.bin", payload.as_slice()),
        ]);
        // The archive is small; the payload is not. That asymmetry is the whole
        // shape of a zip bomb, so the guard has to count what it writes.
        let dir = scratch("bomb");
        let err = extract_extension(&big, &dir, 64 * 1024).unwrap_err();
        assert!(err.contains("unpacked size exceeds"), "got: {err}");
        let _ = fs::remove_dir_all(&dir);
        // And the same archive installs fine under a limit that fits it, so the
        // guard is a ceiling rather than a blanket refusal.
        let dir = scratch("bomb-ok");
        assert!(extract_extension(&big, &dir, 8 * 1024 * 1024).is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_traversal_entry_cannot_write_outside_the_destination() {
        // `enclosed_name` is the zip crate's own guard; this pins that we rely on
        // it, so a future rewrite of the extract loop cannot quietly drop it.
        let evil = zip_with(&[
            (
                "manifest.json",
                br#"{"name":"x","version":"1","manifest_version":3}"#,
            ),
            ("../escaped.txt", b"pwned"),
        ]);
        let dir = scratch("traversal");
        extract_extension(&evil, &dir, MAX_UNPACKED_BYTES).unwrap();
        assert!(dir.join("manifest.json").is_file());
        assert!(
            !dir.parent().unwrap().join("escaped.txt").exists(),
            "a ../ entry must never be written"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn localized_names_resolve_and_cannot_escape_the_extension() {
        let dir = scratch("i18n");
        fs::create_dir_all(dir.join("_locales/en")).unwrap();
        fs::write(
            dir.join("_locales/en/messages.json"),
            br#"{"extName":{"message":"uBlock Origin Lite"}}"#,
        )
        .unwrap();
        fs::write(
            dir.join("manifest.json"),
            br#"{"name":"__MSG_extName__","version":"1","manifest_version":3,"default_locale":"en"}"#,
        )
        .unwrap();
        // The real uBOL manifest shape: the list must show the readable name.
        assert_eq!(
            read_manifest(&dir, true).unwrap().name,
            "uBlock Origin Lite"
        );
        // A plain name is passed through untouched.
        assert_eq!(resolve_i18n(&dir, "Plain Name", Some("en")), None);
        // A locale that is really a path must be refused, not joined. It falls
        // back to `en`, which happens to exist here, so assert on the traversal
        // not being attempted by pointing at a missing key instead.
        assert_eq!(
            resolve_i18n(&dir, "__MSG_missing__", Some("../../..")),
            None
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn folder_handles_cannot_escape_the_root() {
        for bad in ["", " ", ".", "..", "../evil", "a/b", "a\\b", "C:\\x"] {
            assert!(safe_segment(bad).is_err(), "{bad:?} must be rejected");
        }
        assert_eq!(safe_segment(" ublock-origin ").unwrap(), "ublock-origin");
    }

    #[test]
    fn slugs_are_filesystem_safe() {
        assert_eq!(slugify("uBlock Origin"), "ublock-origin");
        assert_eq!(slugify("AdGuard  AdBlocker!!"), "adguard-adblocker");
        assert_eq!(slugify("../../etc"), "etc");
        assert_eq!(slugify("!!!"), "extension");
        assert!(slugify(&"x".repeat(200)).len() <= 48);
    }
}
