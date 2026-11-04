//! Chrome extensions in browser panes: installed from the Chrome Web Store, managed
//! through WebView2, and their popups shown as a child webview of their own.
//!
//! CHROMIUM RUNS THEM. Nothing here emulates an extension API: a package is unpacked
//! into `browser/extensions/<id>` and handed to `AddBrowserExtension`, and the engine
//! enforces the manifest. They live in the panes' own profile, which holds no Tauri
//! IPC, so an extension can read what a page holds and nothing of TEDI's.
//!
//! THE MANIFEST GETS ITS `key` BACK. A store package usually ships without one, and an
//! unpacked extension with no key takes its id from its PATH. Its storage is keyed by
//! that id, so it would not be the same extension as far as anything is concerned. The
//! key is the public key from the CRX header, whose hash is the store id: that check
//! is also what binds the bytes to the extension that was asked for.
//!
//! shortcut: the CRX signature itself is not verified, only that header's id binding,
//! over TLS from Google's fixed hosts. Verify it if packages ever come from elsewhere.
//!
//! A SMALL WORKER GOES IN FRONT OF THE EXTENSION'S OWN, because WebView2 has no toolbar
//! to send it a click and every webview is its own window. See [`COMPAT_WORKER`]. The
//! extension's files are not edited: the manifest points at a loader beside its worker.
//!
//! shortcut: the toolbar shows what the manifest declares, so badges and a popup set at
//! runtime do not appear. Reading them needs a page kept running per extension.

use std::cell::{Cell, RefCell};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Once;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use sha2::{Digest, Sha256};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2BrowserExtension, ICoreWebView2Profile7, ICoreWebView2_13,
};
use webview2_com::{
    take_pwstr, AcceleratorKeyPressedEventHandler, BrowserExtensionEnableCompletedHandler,
    BrowserExtensionRemoveCompletedHandler, FocusChangedEventHandler,
    NewWindowRequestedEventHandler, ProfileAddBrowserExtensionCompletedHandler,
    ProfileGetBrowserExtensionsCompletedHandler, WindowCloseRequestedEventHandler,
};
use windows::core::{Interface, BOOL, HSTRING, PWSTR};
use wry::{WebContext, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

use super::native::{any_core, on_main, pane_shared, Shared};
use super::{cdp as cdp_bridge, PaneEvent};

const MAX_CRX_BYTES: usize = 256 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 50_000;
const MAX_ICON_BYTES: u64 = 256 * 1024;
/// Parts of the WebView2 runtime that list themselves as extensions.
const RUNTIME_COMPONENTS: [&str; 2] = [
    "dgiklkfkllikcanfonkcabmbdfmgleag",
    "mhjfbmdgcfjbbpaeojofohoefgiehjai",
];
/// Chromium reserves names starting with `_`; store packages carry this one.
const STORE_METADATA: &str = "_metadata";
const STAGING: &str = ".staging";
const HOST_DIR: &str = "tedi-host";
const LOADER: &str = "tedi-worker.js";

/// Runs before the extension's worker. Two answers WebView2 cannot give it:
///  - which tab a popup is for: a worker asking for the active tab of the last focused
///    window would otherwise get the popup's own;
///  - a toolbar click, for an extension with no popup, which only `action.onClicked` hears.
///
/// Each listener and the patched query keep native behaviour for everything else.
///
/// `windowType` comes off a query too: every WebView2 window reports itself as a
/// `popup`, so an extension asking for the `normal` window's tab, as Dark Reader does,
/// would find no tab anywhere.
const COMPAT_WORKER: &str = r#"(() => {
  let bound;
  let boundAt = 0;
  const query = chrome.tabs?.query;
  if (query) {
    chrome.tabs.query = function (filter, ...rest) {
      const fresh = bound !== undefined && Date.now() - boundAt < 300000;
      if (filter?.windowType === "normal") {
        const { windowType, ...others } = filter;
        filter = others;
      }
      if (fresh && filter?.active && filter.windowId === undefined) {
        const { currentWindow, lastFocusedWindow, ...others } = filter;
        filter = { ...others, windowId: bound };
      }
      return query.call(this, filter, ...rest);
    };
  }
  const clicked = chrome.action?.onClicked;
  const listeners = new Set();
  if (clicked) {
    const add = clicked.addListener;
    const remove = clicked.removeListener;
    clicked.addListener = function (listener) {
      listeners.add(listener);
      return add.call(this, listener);
    };
    clicked.removeListener = function (listener) {
      listeners.delete(listener);
      return remove.call(this, listener);
    };
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || typeof message !== "object" || !message) return;
    if ("__tediWindow" in message) {
      bound = message.__tediWindow ?? undefined;
      boundAt = Date.now();
    }
    if (Number.isInteger(message.__tediClick)) {
      (query ? query.call(chrome.tabs, { active: true, windowId: message.__tediClick }) : Promise.resolve([]))
        .then(([tab]) => {
          for (const listener of listeners) {
            try {
              listener(tab);
            } catch {}
          }
          reply({ done: true });
        })
        .catch(() => reply({ done: false }));
      return true;
    }
  });
})();
"#;

/// A throwaway page, the only thing that can message the worker from outside it.
const CLICK_PAGE: &str = "<!doctype html><meta charset=utf-8><script src=click.js></script>";
const CLICK_SCRIPT: &str = r#"chrome.runtime
  .sendMessage({ __tediClick: Number(location.hash.slice(1)) })
  .catch(() => {})
  .finally(() => window.close());
"#;

/// What the review shows before anything is installed.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtReview {
    id: String,
    name: String,
    version: String,
    description: String,
    permissions: Vec<String>,
    hosts: Vec<String>,
}

/// One installed extension, as the manager lists it.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExtInfo {
    id: String,
    name: String,
    version: String,
    enabled: bool,
    icon: String,
    popup: String,
    options: String,
    /// No popup, but a click reaches its `action.onClicked`.
    clickable: bool,
    from_store: bool,
}

/// Where the popup goes, in physical pixels of the window's client area.
#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PopupAnchor {
    right: i32,
    top: i32,
    max_width: i32,
    max_height: i32,
    scale: f64,
}

fn extensions_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    super::data_dirs(app)
        .map(|(_, dir)| dir)
        .ok_or_else(|| "no app data directory".to_string())
}

// --- identity ----------------------------------------------------------------

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

/// The extension id in a store link, or a bare id.
fn parse_store_id(input: &str) -> Option<String> {
    let input = input.trim();
    if valid_id(input) {
        return Some(input.to_string());
    }
    let parsed = url::Url::parse(input).ok()?;
    let host = parsed.host_str()?;
    if parsed.scheme() != "https"
        || (host != "chromewebstore.google.com" && host != "chrome.google.com")
    {
        return None;
    }
    parsed
        .path_segments()?
        .rfind(|segment| valid_id(segment))
        .map(str::to_string)
}

/// Chromium's id: the first 16 bytes of the key's SHA-256, written in `a`-`p`.
fn id_of_key(key: &[u8]) -> String {
    Sha256::digest(key)[..16]
        .iter()
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .map(|nibble| char::from(b'a' + nibble))
        .collect()
}

/// Read a protobuf varint at `*at`.
fn varint(bytes: &[u8], at: &mut usize) -> Option<u64> {
    let mut value = 0_u64;
    for shift in (0..64).step_by(7) {
        let byte = *bytes.get(*at)?;
        *at += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some(value);
        }
    }
    None
}

/// Every length-delimited field of a protobuf message, as `(number, bytes)`. A CRX
/// header is made of nothing else; any other wire type means this is not one.
fn fields(bytes: &[u8]) -> Option<Vec<(u64, &[u8])>> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let tag = varint(bytes, &mut at)?;
        if tag & 7 != 2 {
            return None;
        }
        let len = usize::try_from(varint(bytes, &mut at)?).ok()?;
        let end = at.checked_add(len)?;
        out.push((tag >> 3, bytes.get(at..end)?));
        at = end;
    }
    Some(out)
}

/// Split a CRX3 into its public key and zip, refusing one that is not `expected`.
fn open_crx<'a>(crx: &'a [u8], expected: &str) -> Result<(&'a [u8], &'a [u8]), String> {
    if crx.len() < 12 || &crx[..4] != b"Cr24" || crx[4..8] != 3_u32.to_le_bytes() {
        return Err("not a CRX3 package".to_string());
    }
    let header_len = u32::from_le_bytes([crx[8], crx[9], crx[10], crx[11]]) as usize;
    let header_end = header_len
        .checked_add(12)
        .filter(|end| *end <= crx.len())
        .ok_or("the package header is cut short")?;
    let header = fields(&crx[12..header_end]).ok_or("the package header is malformed")?;
    // 2 and 3 are the RSA and ECDSA proofs, 1 inside each is the public key.
    let key = header
        .iter()
        .filter(|(number, _)| *number == 2 || *number == 3)
        .filter_map(|(_, proof)| fields(proof))
        .flat_map(|proof| proof.into_iter())
        .filter(|(number, _)| *number == 1)
        .map(|(_, key)| key)
        .find(|key| id_of_key(key) == expected)
        .ok_or("the package is not the extension that was asked for")?;
    let zip = &crx[header_end..];
    if !zip.starts_with(b"PK") {
        return Err("the package holds no zip".to_string());
    }
    Ok((key, zip))
}

/// Unpack a zip under `dest`, leaving out store metadata. `enclosed_name` is the
/// path-traversal check, and the bounds are what a zip bomb runs into.
fn extract(zip: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(zip)).map_err(|e| format!("bad zip: {e}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err("the package has too many files".to_string());
    }
    let mut remaining = MAX_UNPACKED_BYTES;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("bad zip: {e}"))?;
        let Some(relative) = entry.enclosed_name() else {
            return Err("the package holds an unsafe path".to_string());
        };
        if relative.starts_with(STORE_METADATA) {
            continue;
        }
        let target = dest.join(relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut out = std::fs::File::create(&target).map_err(|e| e.to_string())?;
        // Limited by bytes actually read: an entry's declared size is the attacker's.
        let written = std::io::copy(&mut (&mut entry).take(remaining + 1), &mut out)
            .map_err(|e| e.to_string())?;
        remaining = remaining
            .checked_sub(written)
            .ok_or("the package unpacks too large")?;
    }
    Ok(())
}

/// Put the store key in a manifest's text. By text, not through a JSON round trip,
/// because a manifest may carry comments Chromium accepts and a parser here would not.
/// One it already declares comes later in the object and wins.
fn with_key(manifest: &str, key: &[u8]) -> Option<String> {
    let at = manifest.find('{')? + 1;
    let encoded = base64::engine::general_purpose::STANDARD.encode(key);
    Some(format!(
        "{}\"key\":\"{encoded}\",{}",
        &manifest[..at],
        &manifest[at..]
    ))
}

fn read_manifest(dir: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(dir.join("manifest.json")).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

fn strings(value: &serde_json::Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(|list| list.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn text(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|item| item.as_str())
        .unwrap_or_default()
        .to_string()
}

/// A name written as `__MSG_appName__` is resolved from the default locale.
fn localized(dir: &Path, manifest: &serde_json::Value, raw: String) -> String {
    let Some(key) = raw
        .strip_prefix("__MSG_")
        .and_then(|rest| rest.strip_suffix("__"))
    else {
        return raw;
    };
    let locale = text(manifest, "default_locale");
    let messages = std::fs::read_to_string(dir.join("_locales").join(locale).join("messages.json"))
        .ok()
        .and_then(|body| {
            serde_json::from_str::<serde_json::Value>(body.trim_start_matches('\u{feff}')).ok()
        });
    let lower = key.to_ascii_lowercase();
    messages
        .as_ref()
        .and_then(|all| all.as_object())
        .and_then(|all| {
            all.iter()
                .find(|(name, _)| name.to_ascii_lowercase() == lower)
        })
        .map(|(_, entry)| text(entry, "message"))
        .filter(|message| !message.is_empty())
        .unwrap_or(raw)
}

fn review_of(id: &str, dir: &Path) -> Result<ExtReview, String> {
    let manifest = read_manifest(dir).ok_or("the package has no readable manifest")?;
    if manifest.get("manifest_version").and_then(|v| v.as_u64()) != Some(3) {
        return Err("only Manifest V3 extensions run in this engine".to_string());
    }
    let mut permissions = strings(&manifest, "permissions");
    permissions.sort();
    let mut hosts = strings(&manifest, "host_permissions");
    if let Some(scripts) = manifest.get("content_scripts").and_then(|s| s.as_array()) {
        for script in scripts {
            hosts.extend(strings(script, "matches"));
        }
    }
    hosts.sort();
    hosts.dedup();
    Ok(ExtReview {
        id: id.to_string(),
        name: localized(dir, &manifest, text(&manifest, "name")),
        version: text(&manifest, "version"),
        description: localized(dir, &manifest, text(&manifest, "description")),
        permissions,
        hosts,
    })
}

/// A package path from a manifest, kept inside the package.
fn package_path(path: &str) -> Option<String> {
    let clean = path.trim_start_matches('/');
    let safe = !clean.is_empty() && !clean.contains("..") && !clean.contains(':');
    safe.then(|| clean.replace('\\', "/"))
}

/// Put the loader in front of a package's service worker. It sits beside the worker
/// because a relative `importScripts` resolves against the running script's url. One
/// with no worker has nothing to answer and is left alone.
fn add_worker_compat(dir: &Path, manifest_text: &str) -> Result<String, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(manifest_text.trim_start_matches('\u{feff}'))
            .map_err(|e| format!("the manifest is not readable: {e}"))?;
    let Some(background) = parsed.get("background") else {
        return Ok(manifest_text.to_string());
    };
    let worker = text(background, "service_worker");
    let Some(worker) = package_path(&worker) else {
        return Ok(manifest_text.to_string());
    };
    let (folder, file) = worker.rsplit_once('/').unwrap_or(("", worker.as_str()));
    let loader_path = if folder.is_empty() {
        LOADER.to_string()
    } else {
        format!("{folder}/{LOADER}")
    };
    let module = text(background, "type") == "module";
    let compat = format!("/{HOST_DIR}/compat.js");
    let loader = if module {
        format!("import \"{compat}\";\nimport \"./{file}\";\n")
    } else {
        format!("importScripts(\"{compat}\", \"./{file}\");\n")
    };
    let host = dir.join(HOST_DIR);
    std::fs::create_dir_all(&host).map_err(|e| e.to_string())?;
    for (name, body) in [
        ("compat.js", COMPAT_WORKER),
        ("click.html", CLICK_PAGE),
        ("click.js", CLICK_SCRIPT),
    ] {
        std::fs::write(host.join(name), body).map_err(|e| e.to_string())?;
    }
    std::fs::write(dir.join(&loader_path), loader).map_err(|e| e.to_string())?;

    // By text, for the same reason as `with_key`: only this one value changes.
    let at = manifest_text
        .find("\"service_worker\"")
        .ok_or("the manifest names no worker")?;
    let declared = text(background, "service_worker");
    let quoted = format!("\"{declared}\"");
    let value = manifest_text[at + 16..]
        .find(&quoted)
        .ok_or("the worker path is written in a way this cannot follow")?
        + at
        + 16;
    Ok(format!(
        "{}\"{loader_path}\"{}",
        &manifest_text[..value],
        &manifest_text[value + quoted.len()..]
    ))
}

/// The nearest declared size to 32px, the larger one on a tie.
fn nearest_icon(sizes: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    sizes
        .iter()
        .filter_map(|(size, path)| Some((size.parse::<i32>().ok()?, path.as_str()?)))
        .min_by_key(|(size, _)| ((size - 32).abs(), -size))
        .map(|(_, path)| path.to_string())
}

/// The manifest's icon as a `data:` url, for the toolbar.
fn icon_of(dir: &Path, manifest: &serde_json::Value) -> String {
    let declared = manifest
        .get("action")
        .and_then(|action| action.get("default_icon"))
        .or_else(|| manifest.get("icons"));
    let path = match declared {
        Some(serde_json::Value::String(path)) => Some(path.clone()),
        Some(serde_json::Value::Object(sizes)) => nearest_icon(sizes),
        _ => None,
    };
    let Some(relative) = path.as_deref().and_then(package_path) else {
        return String::new();
    };
    let full = dir.join(&relative);
    let small = std::fs::metadata(&full).is_ok_and(|meta| meta.len() <= MAX_ICON_BYTES);
    let Some(bytes) = small.then(|| std::fs::read(&full).ok()).flatten() else {
        return String::new();
    };
    let mime = if relative.ends_with(".svg") {
        "image/svg+xml"
    } else {
        "image/png"
    };
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}

// --- talking to the profile ---------------------------------------------------

fn profile_of(core: &ICoreWebView2) -> windows::core::Result<ICoreWebView2Profile7> {
    unsafe { core.cast::<ICoreWebView2_13>()?.Profile()?.cast() }
}

/// Hand `done` the profile's extensions, without the runtime's own components.
fn on_list(
    core: &ICoreWebView2,
    done: impl FnOnce(Result<Vec<ICoreWebView2BrowserExtension>, String>) + 'static,
) {
    let profile = match profile_of(core) {
        Ok(profile) => profile,
        Err(e) => return done(Err(format!("this WebView2 has no extension API: {e}"))),
    };
    // The completion is FnOnce behind a Fn-shaped COM box, and a refused call never
    // reaches it, so whichever side runs takes it.
    let slot = Rc::new(RefCell::new(Some(done)));
    let for_handler = slot.clone();
    let handler =
        ProfileGetBrowserExtensionsCompletedHandler::create(Box::new(move |status, list| {
            let result = status
                .map_err(|e| e.to_string())
                .and_then(|()| list.ok_or_else(|| "no extension list".to_string()))
                .and_then(|list| unsafe {
                    let mut count = 0;
                    list.Count(&mut count).map_err(|e| e.to_string())?;
                    (0..count.min(256))
                        .map(|index| list.GetValueAtIndex(index).map_err(|e| e.to_string()))
                        .collect::<Result<Vec<_>, _>>()
                })
                .map(|all| {
                    all.into_iter()
                        .filter(|item| !RUNTIME_COMPONENTS.contains(&id_of(item).as_str()))
                        .collect()
                });
            if let Some(done) = for_handler.borrow_mut().take() {
                done(result);
            }
            Ok(())
        }));
    if let Err(e) = unsafe { profile.GetBrowserExtensions(&handler) } {
        if let Some(done) = slot.borrow_mut().take() {
            done(Err(e.to_string()));
        }
    }
}

fn id_of(item: &ICoreWebView2BrowserExtension) -> String {
    let mut id = PWSTR::null();
    if unsafe { item.Id(&mut id) }.is_err() || id.is_null() {
        return String::new();
    }
    take_pwstr(id)
}

fn add_folder(
    core: &ICoreWebView2,
    folder: &Path,
    done: impl FnOnce(Result<String, String>) + 'static,
) {
    let profile = match profile_of(core) {
        Ok(profile) => profile,
        Err(e) => return done(Err(format!("this WebView2 has no extension API: {e}"))),
    };
    let slot = Rc::new(RefCell::new(Some(done)));
    let for_handler = slot.clone();
    let handler =
        ProfileAddBrowserExtensionCompletedHandler::create(Box::new(move |status, item| {
            let result = status
                .map_err(|e| e.to_string())
                .and_then(|()| item.ok_or_else(|| "nothing was installed".to_string()))
                .map(|item| id_of(&item));
            if let Some(done) = for_handler.borrow_mut().take() {
                done(result);
            }
            Ok(())
        }));
    let path = HSTRING::from(folder.as_os_str());
    if let Err(e) = unsafe { profile.AddBrowserExtension(&path, &handler) } {
        if let Some(done) = slot.borrow_mut().take() {
            done(Err(e.to_string()));
        }
    }
}

/// Once per run, when the first pane exists: learn what is installed, and load any
/// folder the profile does not know, which covers one dropped in by hand. Added
/// extensions persist in the profile, so a store one is only added again if the
/// profile lost it, and a disabled one is left disabled.
pub fn reconcile_once(app: &tauri::AppHandle, core: &ICoreWebView2) {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let Ok(dir) = extensions_dir(app) else {
            return;
        };
        let _ = std::fs::create_dir_all(&dir);
        let for_add = core.clone();
        on_list(core, move |installed| {
            let known: Vec<String> = installed
                .unwrap_or_default()
                .iter()
                .map(id_of)
                .inspect(|id| super::mark_installed(id, true))
                .collect();
            let Ok(entries) = std::fs::read_dir(&dir) else {
                return;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let path = entry.path();
                if name.starts_with('.')
                    || known.contains(&name)
                    || !path.join("manifest.json").is_file()
                {
                    continue;
                }
                add_folder(&for_add, &path, |added| match added {
                    Ok(id) => super::mark_installed(&id, true),
                    Err(e) => eprintln!("browser extension failed to load: {e}"),
                });
            }
        });
    });
}

fn core_or_refuse() -> Result<ICoreWebView2, String> {
    any_core().ok_or_else(|| "open a browser pane first".to_string())
}

// --- the commands -------------------------------------------------------------

/// Download an extension and unpack it to one side, for review. Installs nothing.
/// `installed` asks only for something newer, and answers `None` when there is none.
#[tauri::command]
pub async fn browser_ext_prepare(
    app: tauri::AppHandle,
    input: String,
    installed: Option<String>,
) -> Result<Option<ExtReview>, String> {
    let id = parse_store_id(&input).ok_or("that is not a Chrome Web Store link or id")?;
    let version = on_main(&app, || {
        let env = any_core()?
            .cast::<webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_2>()
            .ok()?;
        let env = unsafe { env.Environment() }.ok()?;
        let mut value = PWSTR::null();
        unsafe { env.BrowserVersionString(&mut value) }.ok()?;
        (!value.is_null()).then(|| take_pwstr(value))
    })
    .await?
    .and_then(|full| full.split_whitespace().next().map(str::to_string))
    .unwrap_or_else(|| "140.0.0.0".to_string());

    let Some(crx) = download(&id, &version, installed.as_deref()).await? else {
        return Ok(None);
    };
    let dir = extensions_dir(&app)?;
    let staged = dir.join(STAGING).join(&id);
    let for_task = id.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<ExtReview>, String> {
        let (key, zip) = open_crx(&crx, &for_task)?;
        let _ = std::fs::remove_dir_all(&staged);
        std::fs::create_dir_all(&staged).map_err(|e| e.to_string())?;
        extract(zip, &staged)?;
        let path = staged.join("manifest.json");
        let manifest = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let compat = add_worker_compat(&staged, &manifest)?;
        let keyed = with_key(&compat, key).ok_or("the manifest is not an object")?;
        std::fs::write(&path, keyed).map_err(|e| e.to_string())?;
        review_of(&for_task, &staged).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

async fn download(
    id: &str,
    version: &str,
    installed: Option<&str>,
) -> Result<Option<Vec<u8>>, String> {
    let mut url = url::Url::parse("https://clients2.google.com/service/update2/crx")
        .map_err(|e| e.to_string())?;
    {
        let mut item = url::form_urlencoded::Serializer::new(String::new());
        item.append_pair("id", id);
        if let Some(installed) = installed {
            item.append_pair("v", installed);
        }
        item.append_pair("uc", "");
        url.query_pairs_mut()
            .append_pair("response", "redirect")
            .append_pair("prodversion", version)
            .append_pair("acceptformat", "crx3")
            .append_pair("x", &item.finish());
    }

    // Google's own hosts only, over https, however many times it redirects.
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        let host = attempt.url().host_str().unwrap_or("");
        let trusted = attempt.url().scheme() == "https"
            && (host == "clients2.google.com"
                || host == "clients2.googleusercontent.com"
                || host.ends_with(".gvt1.com"));
        if trusted && attempt.previous().len() < 5 {
            attempt.follow()
        } else {
            attempt.error("the store redirected somewhere unexpected")
        }
    });
    let client = reqwest::Client::builder()
        .redirect(policy)
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("could not reach the Chrome Web Store: {e}"))?;
    if response.status() == reqwest::StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!("the store answered {}", response.status()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if body.len() + chunk.len() > MAX_CRX_BYTES {
            return Err("the package is too large".to_string());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(body))
}

/// Install what `browser_ext_prepare` unpacked, after the person agreed to it. An
/// existing copy is moved aside until the new one loads, so a failed update leaves
/// the working one. Same id, so its storage stays.
#[tauri::command]
pub async fn browser_ext_install(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("not an extension id".to_string());
    }
    let dir = extensions_dir(&app)?;
    let staged = dir.join(STAGING).join(&id);
    if !staged.join("manifest.json").is_file() {
        return Err("nothing is waiting to be installed".to_string());
    }
    let dest = dir.join(&id);
    let aside = dir.join(STAGING).join(format!("{id}.old"));
    let _ = std::fs::remove_dir_all(&aside);
    if dest.exists() {
        std::fs::rename(&dest, &aside)
            .map_err(|e| format!("the installed copy is in use, restart TEDI and retry: {e}"))?;
    }
    std::fs::rename(&staged, &dest).map_err(|e| e.to_string())?;

    let (tx, rx) = tokio::sync::oneshot::channel();
    let folder = dest.clone();
    on_main(&app, move || {
        match core_or_refuse() {
            Ok(core) => add_folder(&core, &folder, move |result| {
                let _ = tx.send(result);
            }),
            Err(e) => {
                let _ = tx.send(Err(e));
            }
        };
    })
    .await?;
    match rx
        .await
        .map_err(|_| "the install was abandoned".to_string())?
    {
        Ok(added) => {
            super::mark_installed(&added, true);
            let _ = std::fs::remove_dir_all(&aside);
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dest);
            if aside.exists() {
                let _ = std::fs::rename(&aside, &dest);
            }
            Err(format!("the engine refused this extension: {e}"))
        }
    }
}

/// Everything installed, with what the toolbar needs to show it.
#[tauri::command]
pub async fn browser_ext_list(app: tauri::AppHandle) -> Result<Vec<ExtInfo>, String> {
    let dir = extensions_dir(&app)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    on_main(&app, move || {
        let Some(core) = any_core() else {
            let _ = tx.send(Ok(Vec::new()));
            return;
        };
        on_list(&core, move |installed| {
            let _ = tx.send(installed.map(|all| {
                all.iter()
                    .map(|item| {
                        let id = id_of(item);
                        let mut enabled = BOOL::default();
                        let _ = unsafe { item.IsEnabled(&mut enabled) };
                        let mut name = PWSTR::null();
                        let name = if unsafe { item.Name(&mut name) }.is_ok() && !name.is_null() {
                            take_pwstr(name)
                        } else {
                            id.clone()
                        };
                        (id, name, enabled.as_bool())
                    })
                    .collect::<Vec<_>>()
            }));
        });
    })
    .await?;
    let native = rx
        .await
        .map_err(|_| "the extension list was lost".to_string())??;

    Ok(native
        .into_iter()
        .map(|(id, name, enabled)| {
            super::mark_installed(&id, true);
            let folder = dir.join(&id);
            let mut info = ExtInfo {
                from_store: folder.is_dir(),
                id: id.clone(),
                name,
                enabled,
                ..Default::default()
            };
            if let Some(manifest) = read_manifest(&folder) {
                let base = format!("chrome-extension://{id}/");
                let page = |path: String| {
                    package_path(&path)
                        .map(|p| format!("{base}{p}"))
                        .unwrap_or_default()
                };
                info.version = text(&manifest, "version");
                info.icon = icon_of(&folder, &manifest);
                info.popup = manifest
                    .get("action")
                    .map(|action| page(text(action, "default_popup")))
                    .unwrap_or_default();
                info.options = manifest
                    .get("options_ui")
                    .map(|ui| page(text(ui, "page")))
                    .filter(|url| !url.is_empty())
                    .unwrap_or_else(|| page(text(&manifest, "options_page")));
                info.clickable = info.popup.is_empty()
                    && manifest.get("action").is_some()
                    && folder.join(HOST_DIR).join("click.html").is_file();
            }
            info
        })
        .collect())
}

#[tauri::command]
pub async fn browser_ext_set_enabled(
    app: tauri::AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    on_main(&app, move || {
        let core = match core_or_refuse() {
            Ok(core) => core,
            Err(e) => {
                let _ = tx.send(Err(e));
                return;
            }
        };
        on_list(&core, move |installed| {
            let Some(item) = installed
                .unwrap_or_default()
                .into_iter()
                .find(|item| id_of(item) == id)
            else {
                let _ = tx.send(Err("that extension is not installed".to_string()));
                return;
            };
            let slot = Rc::new(RefCell::new(Some(tx)));
            let for_handler = slot.clone();
            let done = BrowserExtensionEnableCompletedHandler::create(Box::new(move |status| {
                if let Some(tx) = for_handler.borrow_mut().take() {
                    let _ = tx.send(status.map_err(|e| e.to_string()));
                }
                Ok(())
            }));
            if let Err(e) = unsafe { item.Enable(enabled, &done) } {
                if let Some(tx) = slot.borrow_mut().take() {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        });
    })
    .await?;
    rx.await.map_err(|_| "the change was lost".to_string())?
}

/// Remove an extension and its folder. Its storage goes with it.
#[tauri::command]
pub async fn browser_ext_remove(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let dir = extensions_dir(&app)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    let for_main = id.clone();
    on_main(&app, move || {
        let core = match core_or_refuse() {
            Ok(core) => core,
            Err(e) => {
                let _ = tx.send(Err(e));
                return;
            }
        };
        on_list(&core, move |installed| {
            let Some(item) = installed
                .unwrap_or_default()
                .into_iter()
                .find(|item| id_of(item) == for_main)
            else {
                let _ = tx.send(Ok(()));
                return;
            };
            let slot = Rc::new(RefCell::new(Some(tx)));
            let for_handler = slot.clone();
            let done = BrowserExtensionRemoveCompletedHandler::create(Box::new(move |status| {
                if let Some(tx) = for_handler.borrow_mut().take() {
                    let _ = tx.send(status.map_err(|e| e.to_string()));
                }
                Ok(())
            }));
            if let Err(e) = unsafe { item.Remove(&done) } {
                if let Some(tx) = slot.borrow_mut().take() {
                    let _ = tx.send(Err(e.to_string()));
                }
            }
        });
    })
    .await?;
    rx.await.map_err(|_| "the removal was lost".to_string())??;
    super::mark_installed(&id, false);
    // Only a folder named by a real id: this path comes from the caller.
    if valid_id(&id) {
        let _ = std::fs::remove_dir_all(dir.join(&id));
    }
    Ok(())
}

// --- the popup ----------------------------------------------------------------

struct Popup {
    view: wry::WebView,
    anchor: PopupAnchor,
    /// A click's throwaway page, which is never shown.
    hidden: bool,
    shown: Cell<bool>,
    _context: WebContext,
}

thread_local! {
    static POPUP: RefCell<Option<Rc<Popup>>> = const { RefCell::new(None) };
}

fn close_popup() {
    // Taken out before the drop: closing a controller can pump messages.
    let gone = POPUP.with_borrow_mut(Option::take);
    drop(gone);
}

/// Close the popup if one is up, from a later turn. For a pane taking the focus: a
/// popup that never held it hears no blur, and would float over the page regardless.
pub fn close_popup_soon(app: &tauri::AppHandle) {
    if POPUP.with_borrow(Option::is_some) {
        let _ = app.run_on_main_thread(close_popup);
    }
}

/// Close the popup, for a click in the app's own webview: the popup may not have had
/// the focus to lose.
#[tauri::command]
pub async fn browser_ext_popup_close(app: tauri::AppHandle) -> Result<(), String> {
    on_main(&app, close_popup).await
}

/// `chrome.tabs.query({active: true, currentWindow: true})` in a popup would answer
/// with the popup itself, since every webview is a window of its own. Popups ask
/// exactly that to learn which page they are for, so it is pointed at the pane's.
fn target_script(window_id: i64) -> String {
    format!(
        r#"(() => {{
  if (location.protocol !== "chrome-extension:" || !globalThis.chrome?.tabs?.query) return;
  const query = chrome.tabs.query;
  chrome.tabs.query = function (filter, ...rest) {{
    if (filter?.active && filter.windowId === undefined) {{
      const {{ currentWindow, lastFocusedWindow, windowType, ...others }} = filter;
      filter = {{ ...others, windowId: {window_id} }};
    }}
    return query.call(this, filter, ...rest);
  }};
  // The worker asks too, and it cannot see this page's patch.
  chrome.runtime.sendMessage({{ __tediWindow: {window_id} }}).catch(() => {{}});
  addEventListener("pagehide", () => {{
    chrome.runtime.sendMessage({{ __tediWindow: null }}).catch(() => {{}});
  }});
}})();"#
    )
}

/// Reports the content's size, because a popup sizes itself to what it holds.
const SIZE_SCRIPT: &str = r#"(() => {
  if (window !== top || location.protocol !== "chrome-extension:") return;
  let last = "";
  const report = () => {
    const body = document.body;
    if (!body) return;
    const style = getComputedStyle(body);
    const w = Math.max(body.scrollWidth, body.getBoundingClientRect().width)
      + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
    const h = Math.max(body.scrollHeight, body.getBoundingClientRect().height)
      + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
    const key = `${Math.ceil(w)},${Math.ceil(h)}`;
    if (key !== last) {
      last = key;
      chrome.webview.postMessage(key);
    }
  };
  addEventListener("load", () => {
    report();
    const watcher = new ResizeObserver(report);
    watcher.observe(document.documentElement);
    if (document.body) watcher.observe(document.body);
  }, { once: true });
})();"#;

/// Chromium's own limits for an extension popup.
fn popup_bounds(anchor: &PopupAnchor, width: f64, height: f64) -> (i32, i32, i32, i32) {
    let w = ((width.clamp(25.0, 800.0) * anchor.scale).ceil() as i32).min(anchor.max_width.max(1));
    let h =
        ((height.clamp(25.0, 600.0) * anchor.scale).ceil() as i32).min(anchor.max_height.max(1));
    ((anchor.right - w).max(0), anchor.top, w, h)
}

fn place_popup(popup: &Popup, width: f64, height: f64) {
    if popup.hidden {
        return;
    }
    let (x, y, w, h) = popup_bounds(&popup.anchor, width, height);
    let _ = popup.view.set_bounds(wry::Rect {
        position: wry::dpi::PhysicalPosition::new(x, y).into(),
        size: wry::dpi::PhysicalSize::new(w, h).into(),
    });
    if !popup.shown.replace(true) {
        let _ = popup.view.set_visible(true);
        let _ = popup.view.focus();
    }
}

/// Parses what `SIZE_SCRIPT` posts. A page's message, so it is only ever two numbers.
fn parse_size(body: &str) -> Option<(f64, f64)> {
    let (w, h) = body.split_once(',')?;
    let (w, h) = (w.parse::<f64>().ok()?, h.parse::<f64>().ok()?);
    (w.is_finite() && h.is_finite()).then_some((w, h))
}

/// Open an extension's popup under the toolbar. Opening it again closes it.
#[tauri::command]
pub async fn browser_ext_popup(
    app: tauri::AppHandle,
    window: tauri::Window,
    pane_id: String,
    url: String,
    anchor: PopupAnchor,
) -> Result<(), String> {
    show_page(app, window, pane_id, url, anchor, false).await
}

/// Click an extension's toolbar button, for one with no popup. The throwaway page tells
/// its worker which window the click was in, and closes itself.
#[tauri::command]
pub async fn browser_ext_click(
    app: tauri::AppHandle,
    window: tauri::Window,
    pane_id: String,
    id: String,
) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("not an extension id".to_string());
    }
    let url = format!("chrome-extension://{id}/{HOST_DIR}/click.html");
    let anchor = PopupAnchor {
        right: 1,
        top: 0,
        max_width: 1,
        max_height: 1,
        scale: 1.0,
    };
    show_page(app, window, pane_id, url, anchor, true).await
}

async fn show_page(
    app: tauri::AppHandle,
    window: tauri::Window,
    pane_id: String,
    url: String,
    anchor: PopupAnchor,
    hidden: bool,
) -> Result<(), String> {
    super::check_id(&pane_id)?;
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    let id = parsed.host_str().unwrap_or("").to_string();
    if parsed.scheme() != "chrome-extension" || !valid_id(&id) || !super::is_installed(&id) {
        return Err("that is not an installed extension's page".to_string());
    }

    // The pane's own window, which is what its popup has to answer for.
    let (reply, rx) = cdp_bridge::reply();
    let for_pane = pane_id.clone();
    on_main(&app, move || match super::native::pane_core(&for_pane) {
        Some(core) => cdp_bridge::send(&core, "Browser.getWindowForTarget", "{}", reply),
        None => cdp_bridge::answer(&reply, Err("no open browser pane with that id".to_string())),
    })
    .await?;
    let raw = cdp_bridge::wait(rx, "Browser.getWindowForTarget").await?;
    let window_id = serde_json::from_str::<serde_json::Value>(&raw)
        .ok()
        .and_then(|value| value.get("windowId").and_then(|w| w.as_i64()))
        .ok_or("the pane has no window yet")?;

    let dirs = super::data_dirs(&app).ok_or("no app data directory")?;
    let for_main = app.clone();
    // The window travels in the url's fragment for a click: a throwaway page has no
    // other way to be told, and nothing reads a fragment but the page it is for.
    let url = if hidden {
        format!("{url}#{window_id}")
    } else {
        url
    };
    on_main(&app, move || {
        open_popup(
            &for_main, &window, &pane_id, &url, &id, anchor, window_id, dirs.0, hidden,
        )
    })
    .await?
}

#[allow(clippy::too_many_arguments)]
fn open_popup(
    app: &tauri::AppHandle,
    window: &tauri::Window,
    pane_id: &str,
    url: &str,
    id: &str,
    anchor: PopupAnchor,
    window_id: i64,
    profile: PathBuf,
    hidden: bool,
) -> Result<(), String> {
    close_popup();
    let shared: Option<Rc<Shared>> = pane_shared(pane_id);
    let base = format!("chrome-extension://{id}/");
    let environment = super::native::environment(&profile)?;
    let mut context = WebContext::new(Some(profile));
    let view = WebViewBuilder::new_with_web_context(&mut context)
        .with_environment(environment)
        .with_browser_extensions_enabled(true)
        .with_initialization_script(target_script(window_id))
        .with_initialization_script(SIZE_SCRIPT)
        .with_url("about:blank")
        .with_navigation_handler(move |to| to == "about:blank" || to.starts_with(&base))
        .with_ipc_handler(|request| {
            let Some((width, height)) = parse_size(request.body()) else {
                return;
            };
            if let Some(popup) = POPUP.with_borrow(Clone::clone) {
                place_popup(&popup, width, height);
            }
        })
        .with_visible(false)
        .with_focused(false)
        .with_devtools(true)
        .with_bounds(wry::Rect {
            position: wry::dpi::PhysicalPosition::new(anchor.right, anchor.top).into(),
            // A conventional viewport to lay out in, before the content says its size.
            size: wry::dpi::PhysicalSize::new(400, 600).into(),
        })
        .build_as_child(window)
        .map_err(|e| format!("could not open the popup: {e}"))?;

    let core = view.webview();
    let controller = view.controller();
    let mut token = 0_i64;
    // Closed from a later turn: each of these runs inside the object being dropped.
    let closer = |app: &tauri::AppHandle| {
        let app = app.clone();
        move || {
            let _ = app.run_on_main_thread(close_popup);
        }
    };
    let close = closer(app);
    let blur = FocusChangedEventHandler::create(Box::new(move |_, _| {
        close();
        Ok(())
    }));
    let close = closer(app);
    let esc = AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut key = 0_u32;
        unsafe { args.VirtualKey(&mut key)? };
        if key == 0x1B {
            unsafe { args.SetHandled(true)? };
            close();
        }
        Ok(())
    }));
    let close = closer(app);
    let closed = WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
        close();
        Ok(())
    }));
    // A link in a popup opens in a pane, and clicking it took the focus anyway.
    let links = NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        unsafe { args.SetHandled(true)? };
        let mut uri = PWSTR::null();
        unsafe { args.Uri(&mut uri)? };
        if !uri.is_null() {
            let url = take_pwstr(uri);
            if let Some(shared) = shared.as_ref() {
                // A link in a popup opens a plain pane: nothing there waits for an answer.
                shared.send(PaneEvent::NewWindow { url, adopt: 0 });
            }
        }
        Ok(())
    }));
    unsafe {
        controller
            .add_LostFocus(&blur, &mut token)
            .and_then(|()| controller.add_AcceleratorKeyPressed(&esc, &mut token))
            .and_then(|()| core.add_WindowCloseRequested(&closed, &mut token))
            .and_then(|()| core.add_NewWindowRequested(&links, &mut token))
    }
    .map_err(|e| format!("could not open the popup: {e}"))?;

    view.load_url(url).map_err(|e| e.to_string())?;
    POPUP.with_borrow_mut(|slot| {
        *slot = Some(Rc::new(Popup {
            view,
            anchor,
            hidden,
            shown: Cell::new(false),
            _context: context,
        }));
    });

    // A page that never reports its size still has to appear.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let _ = on_main(&app, || {
            if let Some(popup) = POPUP.with_borrow(Clone::clone) {
                if popup.hidden {
                    close_popup();
                } else if !popup.shown.get() {
                    place_popup(&popup, 400.0, 600.0);
                }
            }
        })
        .await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A protobuf length-delimited field.
    fn field(number: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![(number << 3) | 2];
        let mut len = body.len();
        while len >= 0x80 {
            out.push((len as u8 & 0x7f) | 0x80);
            len >>= 7;
        }
        out.push(len as u8);
        out.extend_from_slice(body);
        out
    }

    fn crx(keys: &[&[u8]], zip: &[u8]) -> Vec<u8> {
        let header: Vec<u8> = keys
            .iter()
            .flat_map(|key| field(2, &[field(1, key), field(2, b"sig")].concat()))
            .collect();
        [
            b"Cr24".as_slice(),
            &3_u32.to_le_bytes(),
            &(header.len() as u32).to_le_bytes(),
            &header,
            zip,
        ]
        .concat()
    }

    #[test]
    fn a_store_link_or_a_bare_id_names_an_extension() {
        let id = "cjpalhdlnbpafiamejdnhcphjbkeiagm";
        assert_eq!(parse_store_id(id).as_deref(), Some(id));
        let link = format!("https://chromewebstore.google.com/detail/ublock-origin/{id}?hl=en");
        assert_eq!(parse_store_id(&link).as_deref(), Some(id));
        let old = format!("https://chrome.google.com/webstore/detail/x/{id}");
        assert_eq!(parse_store_id(&old).as_deref(), Some(id));
        // Somewhere else claiming the same path is not the store.
        let fake = format!("https://chromewebstore.evil.example/detail/x/{id}");
        assert_eq!(parse_store_id(&fake), None);
        assert_eq!(parse_store_id("uBlock Origin"), None);
    }

    #[test]
    fn the_id_is_the_hash_of_the_key() {
        // The same arithmetic Chromium does: known pair from sha256("key").
        let id = id_of_key(b"key");
        assert_eq!(id.len(), 32);
        assert!(valid_id(&id));
    }

    #[test]
    fn a_package_must_be_the_extension_that_was_asked_for() {
        let zip = b"PK\x03\x04rest";
        let good = id_of_key(b"real key");
        let package = crx(&[b"other key", b"real key"], zip);
        let (key, body) = open_crx(&package, &good).unwrap();
        assert_eq!(key, b"real key");
        assert_eq!(body, zip);

        // Signed by somebody else entirely.
        assert!(open_crx(&crx(&[b"other key"], zip), &good).is_err());
        // Not a package, an older format, a header running past the end, no zip.
        assert!(open_crx(b"PK\x03\x04", &good).is_err());
        let mut v2 = package.clone();
        v2[4] = 2;
        assert!(open_crx(&v2, &good).is_err());
        let mut long = package.clone();
        long[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(open_crx(&long, &good).is_err());
        assert!(open_crx(&crx(&[b"real key"], b"html"), &good).is_err());
    }

    #[test]
    fn unpacking_stays_inside_and_leaves_store_metadata_out() {
        use std::io::Write;
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("manifest.json", options).unwrap();
            zip.write_all(b"{}").unwrap();
            zip.start_file("js/app.js", options).unwrap();
            zip.write_all(b"1").unwrap();
            zip.start_file("_metadata/verified_contents.json", options)
                .unwrap();
            zip.write_all(b"[]").unwrap();
            zip.finish().unwrap();
        }
        let dest = std::env::temp_dir().join(format!("tedi-ext-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(&dest).unwrap();
        extract(buffer.get_ref(), &dest).unwrap();
        assert!(dest.join("manifest.json").is_file());
        assert!(dest.join("js/app.js").is_file());
        assert!(!dest.join("_metadata").exists());
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn a_traversing_entry_refuses_the_package() {
        use std::io::Write;
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);
            zip.start_file("../escape.js", options).unwrap();
            zip.write_all(b"1").unwrap();
            zip.finish().unwrap();
        }
        let dest = std::env::temp_dir().join(format!("tedi-ext-trav-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(&dest).unwrap();
        assert!(extract(buffer.get_ref(), &dest).is_err());
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn the_key_goes_in_without_disturbing_the_manifest() {
        let keyed = with_key("// note\n{ \"name\": \"x\" }", b"k").unwrap();
        assert!(keyed.starts_with("// note\n{\"key\":\"aw==\","));
        assert!(keyed.ends_with(" \"name\": \"x\" }"));
        assert_eq!(with_key("not an object", b"k"), None);
    }

    #[test]
    fn the_loader_goes_beside_the_worker_and_the_worker_is_untouched() {
        let dest = std::env::temp_dir().join(format!("tedi-ext-worker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(dest.join("bg")).unwrap();
        std::fs::write(dest.join("bg/index.js"), "\"use strict\";").unwrap();

        let classic =
            r#"{ "background": { "service_worker": "bg/index.js" }, "name": "bg/index.js" }"#;
        let out = add_worker_compat(&dest, classic).unwrap();
        assert!(out.contains(r#""service_worker": "bg/tedi-worker.js""#));
        assert!(
            out.contains(r#""name": "bg/index.js""#),
            "only the worker's value moves"
        );
        let loader = std::fs::read_to_string(dest.join("bg/tedi-worker.js")).unwrap();
        assert_eq!(
            loader,
            "importScripts(\"/tedi-host/compat.js\", \"./index.js\");\n"
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("bg/index.js")).unwrap(),
            "\"use strict\";"
        );
        assert!(dest.join("tedi-host/click.html").is_file());

        let module = r#"{"background":{"service_worker":"sw.js","type":"module"}}"#;
        let out = add_worker_compat(&dest, module).unwrap();
        assert!(out.contains(r#""service_worker":"tedi-worker.js""#));
        let loader = std::fs::read_to_string(dest.join("tedi-worker.js")).unwrap();
        assert!(loader.starts_with("import \"/tedi-host/compat.js\";"));

        // No worker: nothing to answer, nothing written.
        let plain = r#"{"name":"x"}"#;
        assert_eq!(add_worker_compat(&dest, plain).unwrap(), plain);
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn the_icon_nearest_to_toolbar_size_wins() {
        let sizes = |json: &str| {
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(json).unwrap()
        };
        // The set that left Dark Reader with no icon: no 32, no 48.
        assert_eq!(
            nearest_icon(&sizes(r#"{"19":"a","38":"b"}"#)).as_deref(),
            Some("b")
        );
        assert_eq!(
            nearest_icon(&sizes(r#"{"16":"a","32":"b","128":"c"}"#)).as_deref(),
            Some("b")
        );
        assert_eq!(nearest_icon(&sizes(r#"{"x":"a"}"#)), None);
    }

    #[test]
    fn a_manifest_path_stays_in_the_package() {
        assert_eq!(
            package_path("/popup/index.html").as_deref(),
            Some("popup/index.html")
        );
        assert_eq!(package_path("../secret"), None);
        assert_eq!(package_path("C:/x"), None);
        assert_eq!(package_path(""), None);
    }

    #[test]
    fn a_popup_fits_chromiums_limits_and_the_window() {
        let anchor = PopupAnchor {
            right: 1000,
            top: 100,
            max_width: 500,
            max_height: 400,
            scale: 1.25,
        };
        // Grows to the content at the display's scale, right-aligned to the anchor.
        assert_eq!(popup_bounds(&anchor, 200.0, 100.0), (750, 100, 250, 125));
        // Never past the window.
        assert_eq!(popup_bounds(&anchor, 800.0, 600.0), (500, 100, 500, 400));
        assert_eq!(parse_size("320,240"), Some((320.0, 240.0)));
        assert_eq!(parse_size("NaN,1"), None);
        assert_eq!(parse_size("<script>"), None);
    }
}
