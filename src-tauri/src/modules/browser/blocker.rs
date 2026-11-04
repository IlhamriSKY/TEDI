//! The pane's ad and tracker blocker: Brave's `adblock` engine over EasyList and
//! EasyPrivacy, asked once per subresource from WebView2's own request event.
//!
//! NO PROXY AND NO CERTIFICATE. WebView2 hands the host each request before it
//! leaves, and a blocked one gets an empty 403. Everything else is untouched.
//!
//! WHY THIS NEEDS A RAW WEBVIEW. wry serves custom protocols from a
//! `WebResourceRequested` handler that matches on the url, and the filter below
//! is `http://*`. On a Tauri webview that filter would hand `http://ipc.localhost`
//! back to that handler. `native.rs` registers no protocol, so wry installs no
//! handler at all.
//!
//! FAILS OPEN, ALWAYS. No engine yet, a url the matcher will not parse, a runtime
//! too old for the filter API: the request goes through. A broken blocker costs an
//! ad, a blocking one costs the page.
//!
//! COSMETICS ARE A CONSTRUCTED STYLESHEET, adopted by the document from the host.
//! Constructed sheets are exempt from a page's CSP where a `<style>` is not, one
//! invalid selector drops only its own rule, and the page's markup is not touched.
//! Generic rules are looked up from the classes and ids the document really holds,
//! so no page carries the whole list.
//!
//! shortcut: generic rules are looked up on three passes around the load, with no
//! mutation observer, so an ad container added much later stays visible. Scriptlets
//! and procedural filters are not applied either.
//!
//! shortcut: lists are fetched on first use and refreshed every 4 days, with no
//! copy bundled, so a first run offline blocks nothing until a later launch.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Once, OnceLock, RwLock};
use std::time::Duration;

use adblock::lists::{FilterSet, ParseOptions, RuleTypes};
use adblock::request::Request;
use adblock::Engine;
use tauri::Manager;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Environment, ICoreWebView2WebResourceRequestedEventArgs,
    ICoreWebView2_22, COREWEBVIEW2_WEB_RESOURCE_CONTEXT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST,
    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT,
};
use webview2_com::{ExecuteScriptCompletedHandler, WebResourceRequestedEventHandler};
use windows::core::{w, Interface, HSTRING, PWSTR};

const LISTS: [(&str, &str); 2] = [
    ("easylist.txt", "https://easylist.to/easylist/easylist.txt"),
    (
        "easyprivacy.txt",
        "https://easylist.to/easylist/easyprivacy.txt",
    ),
];

/// The lists' own `Expires: 4 days`.
const REFRESH_AFTER: Duration = Duration::from_secs(4 * 24 * 60 * 60);
const MAX_LIST_BYTES: usize = 16 * 1024 * 1024;
const MAX_URL_BYTES: usize = 32 * 1024;

/// What is worth a round trip to the host. Documents are not: blocking a page
/// someone opened is not this feature's call, and the lists' `$document` rules are
/// not what they installed a browser pane for.
const CONTEXTS: [(COREWEBVIEW2_WEB_RESOURCE_CONTEXT, &str); 8] = [
    (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET, "stylesheet"),
    (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE, "image"),
    (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA, "media"),
    (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT, "font"),
    (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT, "script"),
    (
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST,
        "xmlhttprequest",
    ),
    (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH, "xmlhttprequest"),
    (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING, "ping"),
];

/// Past this a stylesheet costs more than the ads it hides.
const MAX_SELECTORS_PER_PAGE: usize = 20_000;
const MAX_PERSONAL_HOSTS: usize = 2_000;
const MAX_PERSONAL_SELECTORS: usize = 500;
const MAX_SELECTOR_BYTES: usize = 4 * 1024;
const MAX_SCAN_RESULT_BYTES: usize = 4 * 1024 * 1024;

/// Reads the classes and ids in the document, bounded, for the generic lookup. Its
/// answer comes from the page's world, so it is only ever matched against the lists.
const SCAN_SCRIPT: &str = r#"(() => {
  const classes = new Set(), ids = new Set();
  for (const el of document.querySelectorAll("[class],[id]")) {
    if (el.id) ids.add(el.id);
    for (const name of el.classList) classes.add(name);
    if (classes.size + ids.size > 20000) break;
  }
  return { c: [...classes], i: [...ids] };
})()"#;

static ENABLED: AtomicBool = AtomicBool::new(false);
static ENGINE: OnceLock<Engine> = OnceLock::new();
const ENGINE_CACHE: &str = "engine.dat";
static LOADING: Once = Once::new();
static RULES: RwLock<Option<SiteRules>> = RwLock::new(None);

/// What the person decided per site. Kept by the extension, pushed here.
#[derive(Default)]
struct SiteRules {
    paused: HashSet<String>,
    hides: HashMap<String, Vec<String>>,
}

/// Replace the per-site decisions, bounded because they come over IPC.
pub fn set_rules(paused: Vec<String>, hides: HashMap<String, Vec<String>>) {
    let rules = SiteRules {
        paused: paused.into_iter().take(MAX_PERSONAL_HOSTS).collect(),
        hides: hides
            .into_iter()
            .take(MAX_PERSONAL_HOSTS)
            .map(|(host, selectors)| {
                let kept = selectors
                    .into_iter()
                    .filter(|selector| selector.len() <= MAX_SELECTOR_BYTES)
                    .take(MAX_PERSONAL_SELECTORS)
                    .collect();
                (host, kept)
            })
            .collect(),
    };
    if let Ok(mut slot) = RULES.write() {
        *slot = Some(rules);
    }
}

fn host_of(url: &str) -> String {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(str::to_string))
        .unwrap_or_default()
}

fn is_paused(top: &str) -> bool {
    RULES.read().is_ok_and(|rules| {
        rules
            .as_ref()
            .is_some_and(|rules| rules.paused.contains(&host_of(top)))
    })
}

/// Turn blocking on or off. The first time it goes on, the lists are read or
/// fetched and the engine is built in the background: nothing here costs anything
/// until a browser pane exists and the setting asks for it.
pub fn set_enabled(app: &tauri::AppHandle, enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
    if !enabled {
        return;
    }
    let app = app.clone();
    LOADING.call_once(move || {
        tauri::async_runtime::spawn(async move {
            let Ok(dir) = app.path().app_data_dir() else {
                return;
            };
            let dir = dir.join("browser").join("filters");
            let cache = dir.join(ENGINE_CACHE);
            let list_paths: Vec<_> = LISTS.iter().map(|(name, _)| dir.join(name)).collect();
            let mut lists = Vec::with_capacity(LISTS.len());
            for (name, url) in LISTS {
                if let Some(text) = list_text(&dir, name, url).await {
                    lists.push(text);
                }
            }
            if lists.is_empty() {
                return;
            }
            let built = tauri::async_runtime::spawn_blocking(move || {
                cached_engine(&cache, &list_paths).unwrap_or_else(|| {
                    let engine = build_engine(lists);
                    let _ = std::fs::write(&cache, engine.serialize());
                    engine
                })
            })
            .await;
            if let Ok(engine) = built {
                let _ = ENGINE.set(engine);
            }
        });
    });
}

/// The parsed engine, if it is newer than every list it came from. Parsing EasyList
/// is most of a second of a core on each launch, and a corrupt or older file is
/// refused by `deserialize` and simply parsed again.
fn cached_engine(cache: &std::path::Path, lists: &[std::path::PathBuf]) -> Option<Engine> {
    let built = std::fs::metadata(cache).ok()?.modified().ok()?;
    for list in lists {
        if std::fs::metadata(list).ok()?.modified().ok()? > built {
            return None;
        }
    }
    let bytes = std::fs::read(cache).ok()?;
    let mut engine = Engine::default();
    engine.deserialize(&bytes).ok()?;
    Some(engine)
}

fn build_engine(lists: Vec<String>) -> Engine {
    let mut set = FilterSet::new(false);
    for text in lists {
        set.add_filter_list(
            text,
            ParseOptions {
                rule_types: RuleTypes::All,
                ..Default::default()
            },
        );
    }
    Engine::new_with_filter_set(set)
}

/// A list's text: the cached copy if there is one, refreshed in the background
/// when it has aged out, otherwise fetched now.
async fn list_text(dir: &std::path::Path, name: &'static str, url: &'static str) -> Option<String> {
    let path = dir.join(name);
    let cached = tokio::fs::read_to_string(&path).await.ok();
    let Some(cached) = cached else {
        return fetch_list(&path, url).await;
    };
    let stale = tokio::fs::metadata(&path)
        .await
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_none_or(|age| age > REFRESH_AFTER);
    if stale {
        let path = path.clone();
        tauri::async_runtime::spawn(async move {
            fetch_list(&path, url).await;
        });
    }
    Some(cached)
}

/// Download a list and keep it, or say why not and return nothing. A failed
/// refresh leaves the cached copy alone.
async fn fetch_list(path: &std::path::Path, url: &str) -> Option<String> {
    let fetched = async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        let response = client
            .get(url)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?;
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        accept_list(&bytes)
    }
    .await;
    let text = match fetched {
        Ok(text) => text,
        Err(e) => {
            eprintln!("browser blocker: {url}: {e}");
            return None;
        }
    };
    if let Some(dir) = path.parent() {
        let _ = tokio::fs::create_dir_all(dir).await;
    }
    // Through a temp file: a half-written list parses as a smaller list and nothing
    // would ever say so.
    let temp = path.with_extension("tmp");
    if tokio::fs::write(&temp, &text).await.is_ok() {
        let _ = tokio::fs::rename(&temp, path).await;
    }
    Some(text)
}

/// Is this a filter list? A captive portal answers 200 with its login page, and
/// that must not overwrite a good copy.
fn accept_list(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_LIST_BYTES {
        return Err(format!("too large ({} bytes)", bytes.len()));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "not text".to_string())?;
    if !text.trim_start_matches('\u{feff}').starts_with("[Adblock") {
        return Err("not a filter list".to_string());
    }
    Ok(text.to_string())
}

/// Whether a host is this machine. A dev tool's browser pane spends its life on
/// someone's own dev server, where `/ads/banner.js` is the code being written.
fn is_local(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or("").trim_end_matches('.');
    host == "localhost"
        || host.ends_with(".localhost")
        || host == "[::1]"
        || host.starts_with("127.")
        || host == "0.0.0.0"
}

/// The decision, apart from the COM around it. The frame that asked is not
/// something WebView2 reports here, so `top` stands in for it.
fn should_block(engine: &Engine, url: &str, method: &str, top: &str, kind: &str) -> bool {
    if url.len() > MAX_URL_BYTES || is_local(top) || is_local(url) {
        return false;
    }
    let source = if top.starts_with("http") { top } else { url };
    Request::new(url, source, kind, method)
        .map(|request| engine.check_network_request(&request).should_block())
        .unwrap_or(false)
}

/// Rules for this document alone: the site's own from the lists, and what the person
/// hid here themselves. Theirs apply on any host and through a pause, because it is
/// not the lists asking.
fn site_selectors(engine: Option<&Engine>, top: &str) -> Vec<String> {
    let mut out = RULES
        .read()
        .ok()
        .and_then(|rules| {
            rules
                .as_ref()
                .and_then(|rules| rules.hides.get(&host_of(top)).cloned())
        })
        .unwrap_or_default();
    if let Some(engine) = engine {
        if ENABLED.load(Ordering::Relaxed) && !is_local(top) && !is_paused(top) {
            out.extend(engine.url_cosmetic_resources(top).hide_selectors);
        }
    }
    out
}

/// Add rules to the document's sheet, skipping what this document already has. One
/// rule per selector, so an invalid one costs only itself.
fn adopt(core: &ICoreWebView2, selectors: Vec<String>, applied: &mut HashSet<String>) {
    let fresh: Vec<String> = selectors
        .into_iter()
        .filter(|selector| {
            applied.len() < MAX_SELECTORS_PER_PAGE && applied.insert(selector.clone())
        })
        .collect();
    if fresh.is_empty() {
        return;
    }
    let Ok(list) = serde_json::to_string(&fresh) else {
        return;
    };
    let script = format!(
        r#"(() => {{
  const key = Symbol.for("tedi.hide");
  const sheet = globalThis[key] ?? (globalThis[key] = new CSSStyleSheet());
  if (!document.adoptedStyleSheets.includes(sheet)) document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  for (const selector of {list}) {{
    try {{ sheet.insertRule(selector + "{{display:none!important}}", sheet.cssRules.length); }} catch {{}}
  }}
}})()"#
    );
    let done = ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(())));
    let _ = unsafe { core.ExecuteScript(&HSTRING::from(script), &done) };
}

/// A new document: forget the old one's rules and apply this site's straight away.
pub fn start_document(core: &ICoreWebView2, top: &str, applied: &mut HashSet<String>) {
    applied.clear();
    adopt(core, site_selectors(ENGINE.get(), top), applied);
}

/// Look up generic rules for what the document holds right now.
pub fn scan_document(
    core: &ICoreWebView2,
    top: String,
    applied: std::rc::Rc<std::cell::RefCell<HashSet<String>>>,
) {
    let Some(engine) = ENGINE.get() else { return };
    if !ENABLED.load(Ordering::Relaxed) || is_local(&top) || is_paused(&top) {
        return;
    }
    let resources = engine.url_cosmetic_resources(&top);
    if resources.generichide {
        return;
    }
    let sender = core.clone();
    let done = ExecuteScriptCompletedHandler::create(Box::new(move |status, json| {
        if status.is_err() || json.len() > MAX_SCAN_RESULT_BYTES {
            return Ok(());
        }
        let Some((classes, ids)) = parse_scan(&json) else {
            return Ok(());
        };
        let selectors = engine.hidden_class_id_selectors(classes, ids, &resources.exceptions);
        adopt(&sender, selectors, &mut applied.borrow_mut());
        Ok(())
    }));
    let _ = unsafe { core.ExecuteScript(&HSTRING::from(SCAN_SCRIPT), &done) };
}

fn parse_scan(json: &str) -> Option<(Vec<String>, Vec<String>)> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let list = |key: &str| -> Vec<String> {
        value
            .get(key)
            .and_then(|items| items.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    Some((list("c"), list("i")))
}

/// Install the request filter on one pane. `top` reads the pane's current address and
/// `on_block` hears each block, for the count the menu shows.
pub fn attach(
    core: &ICoreWebView2,
    environment: &ICoreWebView2Environment,
    top: impl Fn() -> String + 'static,
    on_block: impl Fn() + 'static,
) {
    // Below this runtime the filter cannot be limited to document requests.
    let Ok(core22) = core.cast::<ICoreWebView2_22>() else {
        return;
    };
    // One empty response for every block, rather than parsing the same headers for
    // each ad.
    let Ok(blocked) = (unsafe {
        environment.CreateWebResourceResponse(
            None,
            403,
            w!("Blocked"),
            w!("Cache-Control: no-store\r\nContent-Length: 0"),
        )
    }) else {
        return;
    };
    let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        if !ENABLED.load(Ordering::Relaxed) {
            return Ok(());
        }
        let Some(engine) = ENGINE.get() else {
            return Ok(());
        };
        let Some((url, method, kind)) = request_of(&args) else {
            return Ok(());
        };
        let page = top();
        if !is_paused(&page) && should_block(engine, &url, &method, &page, kind) {
            unsafe { args.SetResponse(&blocked) }?;
            on_block();
        }
        Ok(())
    }));
    let mut token = 0_i64;
    if unsafe { core.add_WebResourceRequested(&handler, &mut token) }.is_err() {
        return;
    }
    for pattern in [w!("https://*"), w!("http://*")] {
        for (context, _) in CONTEXTS {
            let _ = unsafe {
                core22.AddWebResourceRequestedFilterWithRequestSourceKinds(
                    pattern,
                    context,
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT,
                )
            };
        }
    }
}

fn request_of(
    args: &ICoreWebView2WebResourceRequestedEventArgs,
) -> Option<(String, String, &'static str)> {
    let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
    unsafe { args.ResourceContext(&mut context) }.ok()?;
    let kind = CONTEXTS.iter().find(|(c, _)| *c == context)?.1;
    let request = unsafe { args.Request() }.ok()?;
    let (mut uri, mut method) = (PWSTR::null(), PWSTR::null());
    unsafe { request.Uri(&mut uri) }.ok()?;
    unsafe { request.Method(&mut method) }.ok()?;
    if uri.is_null() || method.is_null() {
        return None;
    }
    Some((
        webview2_com::take_pwstr(uri),
        webview2_com::take_pwstr(method),
        kind,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> Engine {
        build_engine(vec![
            "[Adblock Plus 2.0]\n||ads.example.net^\n/banner/ads.js\n@@||ads.example.net/ok.js\n"
                .to_string(),
        ])
    }

    #[test]
    fn a_cached_engine_blocks_what_the_parsed_one_did() {
        let dir = std::env::temp_dir().join(format!("tedi-engine-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (cache, list) = (dir.join(ENGINE_CACHE), dir.join("list.txt"));
        std::fs::write(&list, "x").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&cache, engine().serialize()).unwrap();
        let cached = cached_engine(&cache, std::slice::from_ref(&list)).expect("a fresh cache");
        assert!(blocks(
            &cached,
            "https://ads.example.net/x.js",
            "https://site.test/"
        ));
        // A list refreshed since then means the cache is stale.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(&list, "y").unwrap();
        assert!(cached_engine(&cache, &[list]).is_none());
        // And garbage is parsed again rather than trusted.
        std::fs::write(&cache, "not an engine").unwrap();
        assert!(cached_engine(&cache, &[]).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn blocks(e: &Engine, url: &str, top: &str) -> bool {
        should_block(e, url, "GET", top, "script")
    }

    #[test]
    fn a_listed_request_is_blocked_and_an_exception_is_not() {
        let e = engine();
        let top = "https://news.example.com/";
        assert!(blocks(&e, "https://ads.example.net/a.js", top));
        assert!(blocks(&e, "https://cdn.example.org/banner/ads.js", top));
        assert!(!blocks(&e, "https://ads.example.net/ok.js", top));
        assert!(!blocks(&e, "https://cdn.example.org/app.js", top));
    }

    #[test]
    fn this_machine_is_never_blocked() {
        let e = engine();
        // The page being developed may well be called this.
        assert!(!blocks(
            &e,
            "http://localhost:3000/banner/ads.js",
            "http://localhost:3000/"
        ));
        assert!(!blocks(
            &e,
            "https://ads.example.net/a.js",
            "http://127.0.0.1:5173/"
        ));
        assert!(!blocks(
            &e,
            "https://ads.example.net/a.js",
            "http://app.localhost/"
        ));
    }

    #[test]
    fn a_page_with_no_address_yet_still_gets_an_answer() {
        assert!(blocks(
            &engine(),
            "https://ads.example.net/a.js",
            "about:blank"
        ));
    }

    #[test]
    fn a_paused_site_keeps_only_what_the_person_hid_there() {
        let e = build_engine(vec![
            "[Adblock Plus 2.0]\nnews.example.com##.banner\n##.ad-slot\n".to_string(),
        ]);
        ENABLED.store(true, Ordering::Relaxed);
        let top = "https://news.example.com/a";
        let mut hides = HashMap::new();
        hides.insert("news.example.com".to_string(), vec![".mine".to_string()]);

        set_rules(Vec::new(), hides.clone());
        let on = site_selectors(Some(&e), top);
        assert!(on.contains(&".banner".to_string()) && on.contains(&".mine".to_string()));
        // Another site gets neither of this site's rules.
        assert!(site_selectors(Some(&e), "https://other.example.org/").is_empty());
        // A generic rule comes back only for a class the document really holds.
        let found = e.hidden_class_id_selectors(["ad-slot"], [] as [&str; 0], &HashSet::new());
        assert_eq!(found, vec![".ad-slot".to_string()]);
        assert!(e
            .hidden_class_id_selectors(["article"], [] as [&str; 0], &HashSet::new())
            .is_empty());

        set_rules(vec!["news.example.com".to_string()], hides);
        assert_eq!(site_selectors(Some(&e), top), vec![".mine".to_string()]);
        assert!(is_paused(top));
        set_rules(Vec::new(), HashMap::new());
    }

    #[test]
    fn an_oversized_personal_rule_is_dropped_and_a_page_answer_is_only_data() {
        let mut hides = HashMap::new();
        hides.insert(
            "a.test".to_string(),
            vec!["x".repeat(MAX_SELECTOR_BYTES + 1), ".ok".to_string()],
        );
        set_rules(Vec::new(), hides);
        assert_eq!(
            site_selectors(None, "https://a.test/"),
            vec![".ok".to_string()]
        );
        set_rules(Vec::new(), HashMap::new());
        assert_eq!(
            parse_scan(r#"{"c":["a",1],"i":["b"]}"#),
            Some((vec!["a".to_string()], vec!["b".to_string()]))
        );
        assert_eq!(parse_scan("not json"), None);
    }

    #[test]
    fn only_a_filter_list_replaces_the_cached_one() {
        assert!(accept_list(b"[Adblock Plus 2.0]\n||x^\n").is_ok());
        assert!(accept_list("\u{feff}[Adblock Plus 2.0]\n".as_bytes()).is_ok());
        assert!(accept_list(b"<html>Sign in to the wifi</html>").is_err());
        assert!(accept_list(&vec![b'a'; MAX_LIST_BYTES + 1]).is_err());
    }
}
