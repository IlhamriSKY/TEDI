//! Embedded preview browser (native child webview) + live favicon resolution.
//
// The preview tab renders a real native webview (WebView2 / WebKit) docked
// over the tab's content area, instead of an iframe. It is a true browser, so
// modern sites (YouTube, logged-in apps, DRM video, WebSockets) just work - the
// iframe proxy is bypassed entirely. The frontend owns layout: it measures the
// content rect (physical px) and calls `preview_embed_update` to create / move
// / show / hide the webview. Navigation is reported back via the
// `PREVIEW_NAV_EVENT` Tauri event so the React address bar + history stay in
// sync. Requires the `unstable` Tauri feature (`Window::add_child`).

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use lol_html::{element, HtmlRewriter, Settings};
use tauri::webview::{PageLoadEvent, Webview, WebviewBuilder};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, Rect, WebviewUrl};
use url::Url;

use super::proxy::proxy_client;
use super::util::js_string_literal;

/// Inject a trusted left click at CSS-viewport coordinates into THIS tab's
/// embedded webview via the DevTools Protocol (`Input.dispatchMouseEvent`).
///
/// A synthetic JS `dispatchEvent` is `isTrusted: false` and is silently ignored
/// by Gmail's `jsaction`, React controlled inputs, and many modal frameworks.
/// CDP input is injected into the browser's REAL input pipeline, so the page
/// sees a trusted click. It is a "virtual mouse": no on-screen cursor moves and
/// no foreground window is required, so it keeps working while TEDI is in the
/// background or MINIMIZED (the agent drives the pane without hijacking the
/// user's mouse). `css_x`/`css_y` are CSS px in the page viewport - exactly what
/// `read_browser` reports as `@x,y` - so there is no HWND lookup or DPI/screen
/// mapping at all, and it targets this `wv` directly so the right tab is hit.
///
/// Returns `Ok(true)` on success, `Err` if the CDP call failed.
#[cfg(target_os = "windows")]
async fn native_click_at(wv: &Webview, css_x: f64, css_y: f64) -> Result<bool, String> {
    use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
    use windows::core::{HSTRING, PCWSTR};

    // A press + release pair at the viewport point. `buttons` is the bitmask of
    // buttons currently held: 1 (left) while pressing, 0 once released;
    // clickCount 1 so the page registers one full click.
    let press = format!(
        r#"{{"type":"mousePressed","x":{css_x},"y":{css_y},"button":"left","buttons":1,"clickCount":1}}"#
    );
    let release = format!(
        r#"{{"type":"mouseReleased","x":{css_x},"y":{css_y},"button":"left","buttons":0,"clickCount":1}}"#
    );

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    // The CDP call must run on the UI thread (COM STA); `with_webview` hops
    // there. Send press then release in order; each `wait_for_async_operation`
    // pumps until that command completes, so the click lands as down-then-up.
    wv.with_webview(move |platform| {
        let run = || -> Result<(), String> {
            let core =
                unsafe { platform.controller().CoreWebView2() }.map_err(|e| e.to_string())?;
            let method = HSTRING::from("Input.dispatchMouseEvent");
            for params in [press, release] {
                let core = core.clone();
                let method = method.clone();
                let params = HSTRING::from(params);
                CallDevToolsProtocolMethodCompletedHandler::wait_for_async_operation(
                    Box::new(move |handler| unsafe {
                        core.CallDevToolsProtocolMethod(
                            PCWSTR(method.as_ptr()),
                            PCWSTR(params.as_ptr()),
                            &handler,
                        )
                        .map_err(webview2_com::Error::WindowsError)
                    }),
                    Box::new(move |res: windows::core::Result<()>, _json: String| res),
                )
                .map_err(|e| e.to_string())?;
            }
            Ok(())
        };
        let _ = tx.send(run());
    })
    .map_err(|e| e.to_string())?;

    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(Ok(()))) => Ok(true),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(_)) => Err("native click callback dropped".into()),
        Err(_) => Err("native click timed out".into()),
    }
}

/// Fallback for non-Windows: no native click injection available (caller falls
/// back to JS dispatch).
#[cfg(not(target_os = "windows"))]
async fn native_click_at(_wv: &Webview, _css_x: f64, _css_y: f64) -> Result<bool, String> {
    Ok(false)
}

const PREVIEW_NAV_EVENT: &str = "tedi:preview-nav";

#[derive(Clone, serde::Serialize)]
struct PreviewNavEvent {
    #[serde(rename = "tabId")]
    tab_id: i64,
    /// "navigated" when a load starts (update the address bar), "loaded" when
    /// it finishes, "title" when document.title changed (carries `title`).
    kind: &'static str,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
}

fn embed_label(tab_id: i64) -> String {
    format!("preview-embed-{tab_id}")
}

/// Leaf ids whose preview webview has been closed. The rAF bounds loop can have
/// a `preview_embed_update` queued at close time; without this gate it would
/// land after teardown, hit the create branch (webview now missing), and
/// recreate an orphaned floating browser. Leaf ids are never reused, so a
/// closed id stays closed for the rest of the session.
static CLOSED_EMBEDS: OnceLock<Mutex<HashSet<i64>>> = OnceLock::new();

fn closed_embeds() -> &'static Mutex<HashSet<i64>> {
    CLOSED_EMBEDS.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Last visible bounds (physical px, relative to the window content) of each
/// embedded webview, recorded on every show/reposition. The macOS/Linux
/// `preview_embed_screenshot` reads it to crop the screen capture to the pane.
/// Windows captures the webview content directly, so it keeps no bounds cache.
#[cfg(not(target_os = "windows"))]
type BoundsMap = std::collections::HashMap<i64, (i32, i32, i32, i32)>;
#[cfg(not(target_os = "windows"))]
static LAST_BOUNDS: OnceLock<Mutex<BoundsMap>> = OnceLock::new();

#[cfg(not(target_os = "windows"))]
fn last_bounds() -> &'static Mutex<BoundsMap> {
    LAST_BOUNDS.get_or_init(|| Mutex::new(BoundsMap::new()))
}

/// Physical-pixel bounds for the embedded webview, measured by the frontend.
#[derive(serde::Deserialize)]
pub struct EmbedBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// Injected at document start when whole-app transparency is on, so the page's
/// backdrop is transparent and TEDI's window shows through. Page content (text,
/// images, elements with their own background) still paints normally.
const TRANSPARENT_BODY_SCRIPT: &str = r#"
(function(){
  try {
    var s = document.createElement('style');
    s.textContent = 'html,body{background-color:transparent !important}';
    (document.head || document.documentElement).appendChild(s);
  } catch (e) {}
})();
"#;

/// WebView2 command-line flags for embedded browser panes. Keeps wry's defaults
/// (disable the mini-menu / SmartScreen / PDF OOUI) and adds the bits that let a
/// pane keep running while TEDI is minimized or occluded: turning off
/// `CalculateNativeWinOcclusion` (so a minimized window isn't frozen) plus
/// renderer/timer background-throttling, so CDP "virtual mouse" clicks and the
/// page keep processing. Autoplay stays enabled (these are real browser tabs).
#[cfg(target_os = "windows")]
const EMBED_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --autoplay-policy=no-user-gesture-required";

/// Apply [`EMBED_BROWSER_ARGS`] at the WebView2 ENVIRONMENT level - the process-wide
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` env var the WebView2 loader reads when it
/// creates each environment - so EVERY webview (the main TEDI window AND every
/// embedded preview child) is created with the SAME additional args.
///
/// Setting these flags on ONLY the child via per-webview `additional_browser_args`
/// made the child's args differ from the main webview's and rendered the child
/// permanently BLANK on Windows (tauri-apps/tauri#13092). Pushing them to the shared
/// environment keeps the occlusion / background-throttling flags (so a minimized
/// preview keeps processing CDP clicks + rendering) without that mismatch.
///
/// Must run once at startup, before the first webview is created.
#[cfg(target_os = "windows")]
pub fn apply_webview2_browser_args_env() {
    // Edition 2021: `set_var` is safe. Called on the main thread at startup before
    // any webview (or other thread) exists.
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", EMBED_BROWSER_ARGS);
}

/// Create (first visible call) or reposition/show the embedded browser webview
/// for a preview tab. `x/y/width/height` are physical pixels measured by the
/// frontend. A hidden or zero-area request just hides any existing webview.
/// Never reloads an existing webview - navigation is a separate command.
#[tauri::command]
pub async fn preview_embed_update(
    app: tauri::AppHandle,
    tab_id: i64,
    url: String,
    bounds: EmbedBounds,
    visible: bool,
    transparent: bool,
) -> Result<(), String> {
    let label = embed_label(tab_id);
    // A closed pane must never be (re)created or repositioned: an in-flight
    // bounds update from the rAF loop can land after `preview_embed_close`.
    if closed_embeds()
        .lock()
        .map(|c| c.contains(&tab_id))
        .unwrap_or(false)
    {
        return Ok(());
    }

    if !visible || bounds.width < 1.0 || bounds.height < 1.0 {
        if let Some(wv) = app.get_webview(&label) {
            wv.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    let position = PhysicalPosition::new(bounds.x.round() as i32, bounds.y.round() as i32);
    let size = PhysicalSize::new(bounds.width.round() as i32, bounds.height.round() as i32);
    #[cfg(not(target_os = "windows"))]
    if let Ok(mut b) = last_bounds().lock() {
        b.insert(tab_id, (position.x, position.y, size.width, size.height));
    }

    if let Some(wv) = app.get_webview(&label) {
        wv.set_bounds(Rect {
            position: position.into(),
            size: size.into(),
        })
        .map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // First time this tab is visible with a real url: create the child webview.
    if url.is_empty() {
        return Ok(());
    }
    let target = Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    // http(s) for the web; `file://` so a local HTML file (e.g. a generated
    // report on disk) opens directly in the preview like any browser tab.
    if !matches!(target.scheme(), "http" | "https" | "file") {
        return Err("only http(s) or file:// URLs can load in the preview".into());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let app_evt = app.clone();
    let app_title = app.clone();
    let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(target))
        .on_page_load(move |_wv, payload| {
            let kind = match payload.event() {
                PageLoadEvent::Started => "navigated",
                PageLoadEvent::Finished => "loaded",
            };
            let _ = app_evt.emit(
                PREVIEW_NAV_EVENT,
                PreviewNavEvent {
                    tab_id,
                    kind,
                    url: payload.url().to_string(),
                    title: None,
                },
            );
        })
        // document.title changes fire here (including SPA route changes that
        // update the title); `wv.url()` reflects the current page so the URL
        // tracks too. Drives the tab/pane label + address bar.
        .on_document_title_changed(move |wv, title| {
            let url = wv.url().map(|u| u.to_string()).unwrap_or_default();
            let _ = app_title.emit(
                PREVIEW_NAV_EVENT,
                PreviewNavEvent {
                    tab_id,
                    kind: "title",
                    url,
                    title: Some(title),
                },
            );
        });
    // NOTE: the occlusion / background-throttling flags that keep this pane
    // processing while TEDI is minimized are applied PROCESS-WIDE via the
    // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS env var (see
    // `apply_webview2_browser_args_env`, called at startup) - deliberately NOT as a
    // per-child `additional_browser_args` here: args that differ from the main
    // webview's render the child BLANK on Windows (tauri-apps/tauri#13092).
    // Follow whole-app transparency: dissolve the page backdrop into TEDI's
    // transparent window instead of painting opaque white. Create-time only -
    // toggling the setting applies to newly opened browser panes. The webview
    // `transparent` setter needs Tauri's macos-private-api on macOS, so there we
    // rely on the injected CSS alone (the surface stays opaque).
    if transparent {
        #[cfg(not(target_os = "macos"))]
        {
            builder = builder.transparent(true);
        }
        builder = builder.initialization_script(TRANSPARENT_BODY_SCRIPT);
    }

    window
        .add_child(builder, position, size)
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Navigate an existing embedded preview webview to `url` (address-bar submit,
/// detected-localhost chip, AI). No-op if the webview was not created yet -
/// `preview_embed_update` creates it at the right url on first show.
#[tauri::command]
pub async fn preview_embed_navigate(
    app: tauri::AppHandle,
    tab_id: i64,
    url: String,
) -> Result<(), String> {
    let Some(wv) = app.get_webview(&embed_label(tab_id)) else {
        return Ok(());
    };
    let target = Url::parse(&url).map_err(|e| format!("invalid url: {e}"))?;
    // Mirror `preview_embed_update`: web schemes plus `file://` for local files.
    if !matches!(target.scheme(), "http" | "https" | "file") {
        return Err("only http(s) or file:// URLs can load in the preview".into());
    }
    wv.navigate(target).map_err(|e| e.to_string())
}

/// Drive the embedded webview's own session history / reload, exactly like a
/// browser's back / forward / reload buttons.
#[tauri::command]
pub async fn preview_embed_dispatch(
    app: tauri::AppHandle,
    tab_id: i64,
    action: String,
) -> Result<(), String> {
    let Some(wv) = app.get_webview(&embed_label(tab_id)) else {
        return Ok(());
    };
    let js = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        other => return Err(format!("unknown action: {other}")),
    };
    wv.eval(js).map_err(|e| e.to_string())
}

/// Read the live, JS-rendered text of an embedded browser pane (title + visible
/// body text + a `Values:` list of form-field values, capped). Lets the AI get
/// page content - view counts, article text, search results, converter/calculator
/// outputs - that a plain HTTP fetch (curl) can't see on JS-heavy sites. Waits
/// (bounded) for the page to render stable content first, so a read fired right
/// after open/navigate returns the loaded page in one call instead of empty text.
/// Runs at the webview level via `eval_with_callback`, so it works on any loaded
/// page (no Tauri IPC needed in the page) and only reads visible text (innerText,
/// never executes page-supplied code into the host).
///
/// Token-light by construction (the result is fed to the AI every read): it
/// prefers the page's `<main>`/`<article>` content over the whole body to drop
/// nav/footer boilerplate, collapses runs of whitespace, and caps the text -
/// the established "reader view" trim. Document-wide links are listed separately
/// so navigation targets survive even when the body text is trimmed to `<main>`.
#[tauri::command]
pub async fn preview_embed_read(
    app: tauri::AppHandle,
    tab_id: i64,
    fields: bool,
) -> Result<String, String> {
    let wv = app
        .get_webview(&embed_label(tab_id))
        .ok_or_else(|| "no open browser pane with that id".to_string())?;
    // Wait (bounded ~3s) for the page to actually have rendered, stable content
    // before extracting, so a read fired right after open_preview / navigate
    // returns the LOADED page in ONE call. Without this the first read often hit
    // a blank or half-loaded DOM, returned almost nothing, and the agent re-read
    // several times (wandering into unrelated tools while it waited) before the
    // content appeared. Cheap when already loaded: two quick probes confirm the
    // body text has stopped growing, then we read.
    let mut prev: i64 = -2;
    for _ in 0..15 {
        let cur = eval_for_string(wv.clone(), PROBE_JS.to_string())
            .await
            .ok()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(-1);
        // cur >= 0 => readyState complete; equal to the previous probe => body
        // text stopped growing. -1 => still loading/navigating, keep waiting.
        if cur >= 0 && cur == prev {
            break;
        }
        prev = cur;
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // Prepend the FIELDS flag the script reads; concat (not format!) so the
    // script's many `{}` need no escaping.
    let js = format!("var FIELDS={fields};") + READ_JS;
    eval_for_string(wv, js).await
}

/// Tiny readiness probe for `preview_embed_read`'s wait loop: the body's
/// non-whitespace text length once `document.readyState === "complete"` AND that
/// length is past a small floor, else "-1" (still loading, navigating, blank, or
/// errored - keep waiting). The floor matters because a freshly created webview
/// can report `complete` on an empty document before the real page paints; the
/// caller treats two equal non-negative results as "loaded and stable".
const PROBE_JS: &str = r#"(function(){try{
  if(document.readyState!=="complete")return "-1";
  var n=document.body?document.body.innerText.replace(/\s+/g,"").length:0;
  return n<30?"-1":(""+n);
}catch(e){return "-1";}})()"#;

/// Title + reader-mode body text + a `Values:` list of form-control values
/// (innerText omits input/select values, where currency/unit converters,
/// calculators, and prefilled fields keep the number the user sees) + capped
/// links, plus (when the prepended `FIELDS` flag is set) a tagged, indexed list
/// of interactive controls the agent can then drive with `preview_embed_act`.
/// Tagging writes a transient `data-tedi-idx` attribute on each control so the
/// act command can re-find it.
const READ_JS: &str = r#"(function(){try{
  var t=document.title||"";
  // Reader-view body: prefer the LARGEST <main>/<article> (a stray little news
  // card shouldn't win), but ONLY when it actually dominates the page. A single
  // SERP/feed <article> over ~200 chars used to shadow the real answer (Google
  // results, the currency answer box, etc. live OUTSIDE it) - require >=50% of
  // body text before trusting it, else fall back to the whole body.
  var cs=document.querySelectorAll("main,article"),c=null,cmax=0;
  for(var ci=0;ci<cs.length;ci++){var cl=(cs[ci].innerText||"").length;if(cl>cmax){cmax=cl;c=cs[ci];}}
  var ct=c?c.innerText:"",ba=document.body?document.body.innerText:"";
  var body=(ct.length>=200&&ct.length>=ba.length*0.5)?ct:ba;
  body=body.replace(/[ \t]+/g," ").replace(/ *\n/g,"\n").replace(/\n{3,}/g,"\n\n").trim();
  var out=t+"\n\n"+body.slice(0,12000)+(body.length>12000?"\n[...truncated]":"");
  // Form-control VALUES: innerText never includes an input/select/textarea value,
  // so an answer the user plainly sees - Google's currency converter ("1 USD =
  // 17.919,00 IDR" lives in <input>s), unit converters, calculators, prefilled
  // search boxes, settings - is otherwise structurally invisible to this read.
  // Whole-document, value-bearing controls only; password/hidden/button/checkbox/
  // radio/file excluded (secret, stateless, or covered by FIELDS state).
  var vals=[],vseen={},vc=document.querySelectorAll("input:not([type=hidden]):not([type=password]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=reset]):not([type=file]):not([type=image]),textarea,select");
  for(var vi=0;vi<vc.length&&vals.length<30;vi++){
    var ve=vc[vi],vv="";
    if(ve.tagName==="SELECT"){var vo=ve.options[ve.selectedIndex];vv=vo?(vo.text||vo.value||""):"";}
    else vv=ve.value||"";
    vv=(vv+"").trim();if(!vv)continue;
    var vl=(ve.getAttribute("aria-label")||ve.getAttribute("name")||ve.getAttribute("placeholder")||ve.getAttribute("title")||"").trim();
    var vline=(vl?vl+": ":"")+vv.slice(0,80);
    if(vseen[vline])continue;vseen[vline]=1;vals.push("- "+vline);
  }
  if(vals.length)out+="\n\nValues:\n"+vals.join("\n");
  var seen={},links=[],as=document.querySelectorAll("a[href]");
  for(var i=0;i<as.length&&links.length<40;i++){
    var a=as[i],href=a.href,txt=((a.innerText||a.textContent||"").trim().replace(/\s+/g," "));
    if(!href||!/^https?:/i.test(href)||!txt||seen[href])continue;
    seen[href]=1;links.push("- "+txt.slice(0,80)+" -> "+href);
  }
  if(links.length)out+="\n\nLinks:\n"+links.join("\n");
  if(typeof FIELDS!=="undefined"&&FIELDS){
    var fsel='input:not([type=hidden]),textarea,select,button,[role=button],[role=textbox],[role=combobox],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option],[contenteditable=""],[contenteditable=true],a[role=button]';
    // Best-effort FUNCTION label, robust to icon-only buttons: aria-label,
    // data-tooltip (Gmail & co), title, placeholder, name, aria-labelledby,
    // own text, then a labelled child (img alt / aria-label / title), then value.
    var flabel=function(e){
      var l=e.getAttribute("aria-label")||e.getAttribute("data-tooltip")||e.getAttribute("title")||e.getAttribute("placeholder")||e.getAttribute("name")||"";
      if(!(l&&l.trim())){var lb=e.getAttribute("aria-labelledby");if(lb){var ids=lb.split(/\s+/),ps=[];for(var x=0;x<ids.length;x++){var rf=document.getElementById(ids[x]);if(rf)ps.push(rf.innerText||rf.textContent||"");}l=ps.join(" ");}}
      if(!(l&&l.trim()))l=(e.innerText||e.textContent||"");
      if(!l.trim()){var ic=e.querySelector("img[alt],[aria-label],[title]");if(ic)l=ic.getAttribute("alt")||ic.getAttribute("aria-label")||ic.getAttribute("title")||"";}
      if(!l.trim())l=e.value||"";
      return (l+"").trim().replace(/\s+/g," ").slice(0,80);
    };
    var fes=document.querySelectorAll(fsel),fl=[],n=0,hiddenN=0;
    for(var j=0;j<fes.length&&n<80;j++){
      var fe=fes[j];
      if(fe.disabled)continue;
      var lbl=flabel(fe);
      var rr=fe.getBoundingClientRect(),vis=rr.width>=1&&rr.height>=1,pos;
      if(vis){
        pos="@"+Math.round(rr.left+rr.width/2)+","+Math.round(rr.top+rr.height/2);
      }else{
        // Hidden (hover-only / collapsed, e.g. a Gmail row's Delete before the
        // row is hovered). Still list it so the agent can reach it: skip
        // unlabeled noise, cap the count, and borrow the nearest VISIBLE
        // ancestor's center so it's locatable (which row it belongs to).
        // Clicking still fires its handler; or hover that area then re-read.
        if(!lbl||hiddenN>=25)continue;
        hiddenN++;
        var an=fe.parentElement,ar=null;
        while(an){var ab=an.getBoundingClientRect();if(ab.width>=1&&ab.height>=1){ar=ab;break;}an=an.parentElement;}
        pos=ar?("~"+Math.round(ar.left+ar.width/2)+","+Math.round(ar.top+ar.height/2)+" hidden"):"hidden";
      }
      fe.setAttribute("data-tedi-idx",n);
      var ftag=fe.tagName.toLowerCase(),ftype=fe.getAttribute("type")||"";
      var role=fe.getAttribute("role")||(ftag+(ftype?("/"+ftype):""));
      var cur="";
      if(ftag==="select"){
        var os=fe.options,on=[];
        for(var k=0;k<os.length&&k<20;k++)on.push(((os[k].text||os[k].value||"")+"").trim().slice(0,30));
        cur=" options: "+on.join(" | ")+(os.length>20?" (+"+(os.length-20)+" more)":"");
      }else if(ftype==="checkbox"||ftype==="radio"){
        cur=fe.checked?" [checked]":"";
      }else if(ftype==="password"){
        cur=fe.value?" [set]":"";
      }else if((ftag==="input"||ftag==="textarea")&&fe.value){
        cur=" =\""+(fe.value+"").slice(0,40)+"\"";
      }
      fl.push("["+n+"] "+role+" \""+lbl+"\" "+pos+cur);
      n++;
    }
    if(fl.length)out+="\n\nControls (viewport "+Math.round(window.innerWidth)+"x"+Math.round(window.innerHeight)+"; [N]=target for browser_click / browser_type / browser_hover; @x,y=center px; ~x,y hidden=not visible yet, hover-only/collapsed - click it or browser_hover its area then read again):\n"+fl.join("\n");
  }
  return out.slice(0,16000);
}catch(e){return "[read error]";}})()"#;

/// Eval `js` in the webview and return its string result. wry hands the result
/// back JSON-encoded, so the string layer is unwrapped. 5s timeout.
async fn eval_for_string(wv: Webview, js: String) -> Result<String, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = std::sync::Mutex::new(Some(tx));
    wv.eval_with_callback(js, move |result| {
        if let Ok(mut guard) = tx.lock() {
            if let Some(sender) = guard.take() {
                let _ = sender.send(result);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    match tokio::time::timeout(Duration::from_secs(5), rx).await {
        Ok(Ok(raw)) => Ok(serde_json::from_str::<String>(&raw).unwrap_or(raw)),
        Ok(Err(_)) => Err("eval callback dropped".into()),
        Err(_) => Err("timed out (page still loading?)".into()),
    }
}

/// Type into or click an interactive element previously indexed + tagged by a
/// `preview_embed_read` with `fields=true` (located by its `data-tedi-idx`).
/// `action` is "click" or "type"; for "type" the value is set via the native
/// setter + input/change events so React/controlled inputs update, and `submit`
/// presses Enter / `requestSubmit` after. Returns "ok", "not-found" (re-read to
/// refresh indices), "not-editable", or "error:..".
#[tauri::command]
pub async fn preview_embed_act(
    app: tauri::AppHandle,
    tab_id: i64,
    index: i64,
    action: String,
    text: String,
    submit: bool,
) -> Result<String, String> {
    if !matches!(
        action.as_str(),
        "click" | "type" | "hover" | "key" | "scroll" | "clickxy"
    ) {
        return Err("unknown action".into());
    }
    let wv = app
        .get_webview(&embed_label(tab_id))
        .ok_or_else(|| "no open browser pane with that id".to_string())?;
    // ── Trusted "virtual mouse" click injection for `clickxy` ──────────
    // Synthetic JS `dispatchEvent` produces events with `isTrusted: false`,
    // which Gmail's `jsaction`, React controlled components, and many modal
    // frameworks silently ignore. Inject the click through the DevTools
    // Protocol instead: trusted input, no cursor movement, and it works even
    // while TEDI is backgrounded or minimized. Fall back to JS dispatch only
    // when the native path is unavailable (non-Windows) or errors.
    if action == "clickxy" {
        if let Some((xs, ys)) = text.split_once(',') {
            if let (Ok(cx), Ok(cy)) = (xs.trim().parse::<f64>(), ys.trim().parse::<f64>()) {
                match native_click_at(&wv, cx, cy).await {
                    Ok(true) => {
                        tokio::time::sleep(Duration::from_millis(120)).await;
                        return Ok("ok".into());
                    }
                    Ok(false) => { /* native injection unavailable – fall through to JS */ }
                    Err(e) => {
                        log::warn!("native_click_at failed, falling back to JS: {e}");
                    }
                }
            }
        }
    }

    let prelude = format!(
        "var IDX={};var ACTION={};var TEXT={};var SUBMIT={};",
        index,
        js_string_literal(&action),
        js_string_literal(&text),
        submit
    );
    let result = eval_for_string(wv, prelude + ACT_JS).await?;
    // "typing" => the in-page human-typing loop was kicked off (randomized
    // per-char delay). Wait out roughly its duration so the AI's "ok" lands
    // after the field is filled / submitted, not before.
    if result == "typing" {
        let n = text.chars().count() as u64;
        let per = if n > 30 { 25 } else { 100 };
        let ms = n.saturating_mul(per).saturating_add(350).min(12_000);
        tokio::time::sleep(Duration::from_millis(ms)).await;
        return Ok("ok".into());
    }
    Ok(result)
}

/// Capture the focused browser tab as a JPEG (base64). The agent's LAST-RESORT
/// "look at it" for purely-visual targets the DOM can't express (canvas, maps,
/// drawn UIs). On-demand only and JPEG (small) to stay light.
///
/// Windows: ask WebView2 to render its own content via `CapturePreview`, so the
/// result is exactly the tab - no window chrome, no screen crop, and it works
/// even though WebView2 composites through DirectComposition (which a plain
/// screen grab misses, capturing the host window instead).
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn preview_embed_screenshot(
    app: tauri::AppHandle,
    tab_id: i64,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let label = embed_label(tab_id);
    let wv = app
        .get_webview(&label)
        .ok_or_else(|| "no open browser pane with that id".to_string())?;

    // CapturePreview is async (completion handler) and its COM objects must be
    // touched on the UI thread; `with_webview` hops there. Bridge the result
    // back to this async command over a oneshot.
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();

    wv.with_webview(move |platform| {
        use webview2_com::CapturePreviewCompletedHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG;
        use windows::Win32::Foundation::HGLOBAL;
        use windows::Win32::System::Com::StructuredStorage::{
            CreateStreamOnHGlobal, GetHGlobalFromStream,
        };
        use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG};
        use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};

        let capture = || -> Result<Vec<u8>, String> {
            let core =
                unsafe { platform.controller().CoreWebView2() }.map_err(|e| e.to_string())?;
            // An auto-growing HGLOBAL-backed stream receives the JPEG.
            let stream: IStream =
                unsafe { CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true) }
                    .map_err(|e| e.to_string())?;
            let stream_cap = stream.clone();
            CapturePreviewCompletedHandler::wait_for_async_operation(
                Box::new(move |handler| unsafe {
                    core.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
                        &stream_cap,
                        &handler,
                    )
                    .map_err(webview2_com::Error::WindowsError)
                }),
                Box::new(move |res: windows::core::Result<()>| res),
            )
            .map_err(|e| e.to_string())?;
            // The stream's logical size is the bytes actually written; the
            // HGLOBAL allocation behind it may be larger, so read cbSize, not
            // GlobalSize, to avoid padding the JPEG with trailing bytes.
            let mut stat = STATSTG::default();
            unsafe { stream.Stat(&mut stat, STATFLAG_NONAME) }.map_err(|e| e.to_string())?;
            let size = stat.cbSize as usize;
            if size == 0 {
                return Err("capture produced no data".into());
            }
            // Copy those bytes straight out of the stream's backing memory.
            unsafe {
                let hg: HGLOBAL = GetHGlobalFromStream(&stream).map_err(|e| e.to_string())?;
                let ptr = GlobalLock(hg);
                if ptr.is_null() {
                    return Err("could not read capture buffer".into());
                }
                let bytes = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
                let _ = GlobalUnlock(hg);
                Ok(bytes)
            }
        };
        let _ = tx.send(capture());
    })
    .map_err(|e| e.to_string())?;

    let bytes = rx
        .await
        .map_err(|_| "capture did not complete".to_string())??;
    Ok(STANDARD.encode(bytes))
}

/// macOS/Linux: the OS screen capture includes the webview surface, so grab the
/// screen region the pane occupies (window content position + the pane's last
/// visible bounds) and crop to it. The pane must be visible and the window in
/// front - which holds when the agent is actively interacting with it.
#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn preview_embed_screenshot(
    app: tauri::AppHandle,
    tab_id: i64,
) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let (bx, by, bw, bh) = last_bounds()
        .lock()
        .ok()
        .and_then(|m| m.get(&tab_id).copied())
        .ok_or_else(|| "pane bounds unknown - show the browser pane first".to_string())?;
    if bw < 1 || bh < 1 {
        return Err("browser pane is not visible".into());
    }
    let win = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let pos = win.inner_position().map_err(|e| e.to_string())?;
    let (sx, sy) = (pos.x + bx, pos.y + by);
    let jpeg = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        use xcap::image::{codecs::jpeg::JpegEncoder, imageops, DynamicImage, ExtendedColorType};
        let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
        let (cx, cy) = (sx + bw / 2, sy + bh / 2);
        // xcap 0.9's geometry accessors are fallible, so resolve each monitor's
        // origin up front and keep the one whose rect contains the pane center.
        let mut chosen: Option<(xcap::Monitor, i32, i32)> = None;
        for m in monitors {
            let mx = m.x().map_err(|e| e.to_string())?;
            let my = m.y().map_err(|e| e.to_string())?;
            let mw = m.width().map_err(|e| e.to_string())? as i32;
            let mh = m.height().map_err(|e| e.to_string())? as i32;
            if cx >= mx && cx < mx + mw && cy >= my && cy < my + mh {
                chosen = Some((m, mx, my));
                break;
            }
        }
        let (mon, mx, my) = chosen.ok_or_else(|| "pane is off-screen".to_string())?;
        let shot = mon.capture_image().map_err(|e| e.to_string())?;
        let rx = (sx - mx).max(0) as u32;
        let ry = (sy - my).max(0) as u32;
        let rw = (bw as u32).min(shot.width().saturating_sub(rx));
        let rh = (bh as u32).min(shot.height().saturating_sub(ry));
        if rw == 0 || rh == 0 {
            return Err("empty crop region".into());
        }
        let cropped = imageops::crop_imm(&shot, rx, ry, rw, rh).to_image();
        let rgb = DynamicImage::ImageRgba8(cropped).into_rgb8();
        let (w, h) = (rgb.width(), rgb.height());
        let mut buf = Vec::new();
        JpegEncoder::new_with_quality(&mut buf, 70)
            .encode(&rgb, w, h, ExtendedColorType::Rgb8)
            .map_err(|e| e.to_string())?;
        Ok(buf)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(STANDARD.encode(jpeg))
}

const ACT_JS: &str = r#"(function(){try{
  // Key press goes to whatever is focused (or the body), so it needs no
  // indexed element - close a popup with Escape, drive a menu/list with arrows
  // / Enter / Tab, delete with Delete, etc.
  if(ACTION==="key"){
    var tgt=document.activeElement||document.body;
    var nk={Enter:13,Escape:27,Esc:27,Tab:9,Backspace:8,Delete:46,Del:46,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Home:36,End:35,PageUp:33,PageDown:34," ":32};
    var kk=(TEXT||"")+"", kc=nk[kk]||(kk.length===1?kk.charCodeAt(0):0);
    var ko={key:kk,code:kk,keyCode:kc,which:kc,bubbles:true,cancelable:true};
    tgt.dispatchEvent(new KeyboardEvent("keydown",ko));
    try{tgt.dispatchEvent(new KeyboardEvent("keypress",ko));}catch(e){}
    tgt.dispatchEvent(new KeyboardEvent("keyup",ko));
    return "ok";
  }
  // Page / inner-container scroll to reach off-screen or lazy-loaded content.
  // TEXT: "down"|"up"|"top"|"bottom"|"<pixels>". Scrolls the scrollable element
  // under the viewport center (e.g. Gmail's list) if any, else the window.
  if(ACTION==="scroll"){
    var t2=(TEXT||"down")+"",vh=window.innerHeight,amt;
    if(t2==="up")amt=-Math.round(vh*0.85);else if(t2==="top")amt=-1e7;else if(t2==="bottom")amt=1e7;else if(/^-?\d+$/.test(t2))amt=parseInt(t2,10);else amt=Math.round(vh*0.85);
    var cc=document.elementFromPoint(Math.round(window.innerWidth/2),Math.round(vh/2)),sc=null,an2=cc;
    while(an2&&an2!==document.body){var st=getComputedStyle(an2);if(an2.scrollHeight>an2.clientHeight+2&&/(auto|scroll)/.test(st.overflowY)){sc=an2;break;}an2=an2.parentElement;}
    if(sc)sc.scrollTop+=amt;else window.scrollBy(0,amt);
    return "ok";
  }
  // Click at viewport CSS coordinates (TEXT "x,y") - the visual fallback for
  // anything not in the controls list (canvas, custom-drawn UI seen in a
  // screenshot). Dispatches a full pointer+mouse click sequence at that point.
  // NOTE: On Windows this action is intercepted at the Rust level and injected
  // as a trusted DevTools-Protocol click (`isTrusted: true`, works minimized).
  // The JS below only runs when that native path is unavailable (macOS, Linux)
  // or it errored.
  if(ACTION==="clickxy"){
    var m=((TEXT||"")+"").split(","),cx=parseFloat(m[0]),cy=parseFloat(m[1]);
    if(isNaN(cx)||isNaN(cy))return "bad-coords";
    var tp2=document.elementFromPoint(cx,cy);
    if(!tp2)return "no-element-at-point";
    // Full event sequence matching real browser pointer flow. Use PointerEvent
    // when available (Chrome, Edge, Firefox) for richer pointer properties, then
    // fall back to MouseEvent.
    try{
      var pe=typeof PointerEvent!=="undefined"?function(t,o){return new PointerEvent(t,o)}:function(t,o){return new MouseEvent(t,o)};
      var opts={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:0,buttons:1,pointerId:1,pointerType:"mouse",isPrimary:true,width:1,height:1,pressure:0.5};
      ["pointerover","pointerenter","mouseover","mouseenter","pointermove","mousemove","pointerdown","mousedown"].forEach(function(ev){try{tp2.dispatchEvent(pe(ev,Object.assign({},opts,{buttons:ev.indexOf("down")>0?1:0})));}catch(e){}});
      opts.buttons=0;
      ["pointerup","mouseup","click"].forEach(function(ev){try{tp2.dispatchEvent(pe(ev,opts));}catch(e){}});
    }catch(ex){
      // Ultra-fallback: plain MouseEvent (older engines).
      ["pointerover","mousemove","pointerdown","mousedown","pointerup","mouseup","click"].forEach(function(ev){try{tp2.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:0}));}catch(e){}});
    }
    // Final resort: .click() on the element (some frameworks listen on it).
    try{tp2.click();}catch(e){}
    return "ok";
  }
  var el=document.querySelector('[data-tedi-idx="'+IDX+'"]');
  if(!el)return "not-found";
  try{el.scrollIntoView({block:"center",inline:"center"});}catch(e){}
  if(ACTION==="click"){
    if(el.focus)el.focus();
    // Dispatch a FULL pointer+mouse sequence (not just el.click()) so apps that
    // bind to mousedown/up / jsaction (Gmail, most SPAs) actually react.
    var rc=el.getBoundingClientRect(),mx=rc.left+rc.width/2,my=rc.top+rc.height/2;
    try{
      var pe2=typeof PointerEvent!=="undefined"?function(t,o){return new PointerEvent(t,o)}:function(t,o){return new MouseEvent(t,o)};
      var o2={bubbles:true,cancelable:true,view:window,clientX:mx,clientY:my,button:0,buttons:1,pointerId:1,pointerType:"mouse",isPrimary:true,width:1,height:1,pressure:0.5};
      ["pointerover","pointerenter","mouseover","mouseenter","pointermove","mousemove","pointerdown","mousedown"].forEach(function(ev){try{el.dispatchEvent(pe2(ev,Object.assign({},o2,{buttons:ev.indexOf("down")>0?1:0})));}catch(e){}});
      o2.buttons=0;
      ["pointerup","mouseup","click"].forEach(function(ev){try{el.dispatchEvent(pe2(ev,o2));}catch(e){}});
    }catch(ex){
      ["pointerover","mouseover","pointermove","mousemove","pointerdown","mousedown","pointerup","mouseup","click"].forEach(function(ev){try{el.dispatchEvent(new MouseEvent(ev,{bubbles:true,cancelable:true,view:window,clientX:mx,clientY:my,button:0}));}catch(e){}});
    }
    try{el.click();}catch(e){}
    return "ok";
  }
  // Hover: fire pointer/mouse-enter events so hover-only controls (e.g. Gmail's
  // per-row delete/archive icons) reveal themselves; the agent re-reads after.
  if(ACTION==="hover"){
    ["pointerover","pointerenter","mouseover","mouseenter","mousemove"].forEach(function(tp){try{el.dispatchEvent(new MouseEvent(tp,{bubbles:true,cancelable:true,view:window}));}catch(e){}});
    return "ok";
  }
  if(el.focus)el.focus();
  var tag=el.tagName, itype=((el.type||"")+"").toLowerCase();
  // Native <select>: match TEXT against an option (value, then exact label,
  // then contains), set it, fire input/change. No SUBMIT for a selection.
  if(tag==="SELECT"){
    var opts=el.options, mi=-1, tl=((TEXT||"")+"").trim().toLowerCase();
    for(var oi=0;oi<opts.length;oi++){var o=opts[oi];if(o.value===TEXT||((o.text||"")+"").trim().toLowerCase()===tl){mi=oi;break;}}
    if(mi<0)for(var oj=0;oj<opts.length;oj++){if((((opts[oj].text||"")+"").toLowerCase().indexOf(tl)>=0)){mi=oj;break;}}
    if(mi<0)return "option-not-found";
    el.selectedIndex=mi;
    el.dispatchEvent(new Event("input",{bubbles:true}));
    el.dispatchEvent(new Event("change",{bubbles:true}));
    return "ok";
  }
  // Radio: select it. Checkbox: set to desired state (TEXT "false/no/off/uncheck" => off, else on).
  if(tag==="INPUT"&&itype==="radio"){ if(!el.checked)el.click(); return "ok"; }
  if(tag==="INPUT"&&itype==="checkbox"){
    var want=!/^(0|false|no|off|uncheck|unchecked)$/i.test(((TEXT||"")+"").trim());
    if(el.checked!==want)el.click();
    return "ok";
  }
  // Text inputs (incl. date/time/range/color/number) / textarea / contenteditable.
  var isInput=(tag==="INPUT"||tag==="TEXTAREA");
  if(!isInput&&!el.isContentEditable)return "not-editable";
  // Human-like typing: clear, then emit per-character key + input events with
  // randomized delays so the page sees REAL keystrokes (validation/anti-bot
  // handlers fire, and the field visibly fills). Kicked off async; the sync
  // function returns "typing" and Rust waits out the duration. SUBMIT (Enter /
  // requestSubmit) runs only after the last character.
  var proto=tag==="TEXTAREA"?window.HTMLTextAreaElement.prototype:(tag==="INPUT"?window.HTMLInputElement.prototype:null);
  function setVal(v){if(proto){var pd=Object.getOwnPropertyDescriptor(proto,"value");if(pd&&pd.set){pd.set.call(el,v);return;}el.value=v;}else{el.textContent=v;}}
  function getVal(){return proto?el.value:(el.textContent||"");}
  setVal("");
  el.dispatchEvent(new Event("input",{bubbles:true}));
  var chars=((TEXT||"")+"").split(""), fast=chars.length>30;
  (async function(){try{
    for(var i=0;i<chars.length;i++){
      var ch=chars[i], kev={key:ch,bubbles:true};
      el.dispatchEvent(new KeyboardEvent("keydown",kev));
      setVal(getVal()+ch);
      try{el.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertText",data:ch}));}catch(e){el.dispatchEvent(new Event("input",{bubbles:true}));}
      el.dispatchEvent(new KeyboardEvent("keyup",kev));
      await new Promise(function(r){setTimeout(r,(fast?12:55)+Math.floor(Math.random()*(fast?18:75)));});
    }
    el.dispatchEvent(new Event("change",{bubbles:true}));
    if(SUBMIT){
      var k={key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true};
      el.dispatchEvent(new KeyboardEvent("keydown",k));
      el.dispatchEvent(new KeyboardEvent("keyup",k));
      if(el.form&&el.form.requestSubmit){try{el.form.requestSubmit();}catch(e){}}
    }
  }catch(e){}})();
  return "typing";
}catch(e){return "error:"+(e&&e.message?e.message:e);}})()"#;

/// Destroy the embedded webview when its preview tab closes. Hides first so it
/// vanishes immediately even if the (async) close lags, then closes.
#[tauri::command]
pub async fn preview_embed_close(app: tauri::AppHandle, tab_id: i64) -> Result<(), String> {
    let label = embed_label(tab_id);
    // Mark closed FIRST so any in-flight / future `preview_embed_update` bails
    // (see its gate) instead of recreating an orphan after teardown.
    if let Ok(mut closed) = closed_embeds().lock() {
        closed.insert(tab_id);
    }
    // Drop this pane's cached bounds so the screenshot bounds map only tracks
    // live preview panes.
    #[cfg(not(target_os = "windows"))]
    if let Ok(mut b) = last_bounds().lock() {
        b.remove(&tab_id);
    }
    if let Some(wv) = app.get_webview(&label) {
        let _ = wv.hide();
        let _ = wv.close();
    }
    // A create may still be mid-flight: registered just after our check, or
    // executing `add_child` right now (past the gate above). Re-check briefly
    // and tear down anything that appears so a closed pane never leaves an
    // orphan floating. Leaf ids are never reused, so any webview for this label
    // is that orphan.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..6 {
            tokio::time::sleep(Duration::from_millis(150)).await;
            if let Some(wv) = app.get_webview(&label) {
                let _ = wv.hide();
                let _ = wv.close();
            }
        }
    });
    Ok(())
}

/// Set the embedded browser page's background color (live), so transparency can
/// FOLLOW the app-opacity slider instead of being a fixed on/off. The frontend
/// passes an `rgba()` string built from the theme canvas color + the current
/// opacity; forcing it inline on html/body keeps the page text readable while
/// only the backdrop fades, and re-applies cheaply on each slider change.
/// No-op if the webview is gone.
#[tauri::command]
pub async fn preview_embed_set_bg(
    app: tauri::AppHandle,
    tab_id: i64,
    color: String,
) -> Result<(), String> {
    let Some(wv) = app.get_webview(&embed_label(tab_id)) else {
        return Ok(());
    };
    let js = format!(
        "(function(){{try{{var c={};var d=document.documentElement,b=document.body;if(d)d.style.setProperty('background-color',c,'important');if(b)b.style.setProperty('background-color',c,'important');}}catch(e){{}}}})()",
        js_string_literal(&color)
    );
    wv.eval(js).map_err(|e| e.to_string())
}

/// Resolve a site's real favicon. First reads the loaded page's declared
/// `<link rel="icon">` (covers sites whose icon lives at a hashed/custom path
/// like `/assets/icons/favicon-64.png`). If the page declares none - e.g.
/// Google's sign-in page, where gmail.com lands when logged out - it falls back
/// to the conventional `<origin>/favicon.ico`, following its redirects and
/// confirming the final response is actually an image. Returns an absolute URL
/// to the best icon, or None to fall back to the globe glyph.
///
/// Both steps fetch directly from the site the user is already viewing - NOT
/// through a third-party favicon service - so browsing isn't leaked anywhere.
/// Redirects are resolved here so the returned URL points straight at the image:
/// the frontend's optimistic `<origin>/favicon.ico` <img> probe can't follow a
/// cross-origin favicon redirect, which is exactly when this command is called.
#[tauri::command]
pub async fn preview_resolve_favicon(url: String) -> Result<Option<String>, String> {
    let page = match Url::parse(&url) {
        Ok(u) if matches!(u.scheme(), "http" | "https") => u,
        _ => return Ok(None),
    };
    // Block SSRF to cloud-metadata / link-local addresses; on a blocked host
    // fall back to the globe glyph rather than surfacing an error.
    if crate::modules::net::reject_metadata_ssrf(page.as_str())
        .await
        .is_err()
    {
        return Ok(None);
    }
    // 1. The page's own declared <link rel="icon">, resolved against the final
    //    (post-redirect) document URL.
    if let Ok(resp) = proxy_client().get(page.clone()).send().await {
        if resp.status().is_success() {
            let final_url = resp.url().clone();
            let html = read_head_html(resp, 256 * 1024).await;
            if let Some(href) = pick_icon_href(&html) {
                if let Ok(abs) = final_url.join(&href) {
                    return Ok(Some(abs.to_string()));
                }
            }
        }
    }
    // 2. Fallback: the conventional /favicon.ico on the origin the user is
    //    actually viewing. Follow its redirects and require an image
    //    content-type, so a /favicon.ico that redirects to an HTML login page is
    //    rejected (-> globe) instead of returned as a broken icon.
    if let Ok(ico) = page.join("/favicon.ico") {
        if let Ok(resp) = proxy_client().get(ico).send().await {
            if resp.status().is_success() && resp_is_image(&resp) {
                return Ok(Some(resp.url().to_string()));
            }
        }
    }
    Ok(None)
}

/// True when a response's `Content-Type` declares an image, used to reject a
/// `/favicon.ico` that redirects to an HTML error/login page.
fn resp_is_image(resp: &reqwest::Response) -> bool {
    resp.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_start().to_ascii_lowercase().starts_with("image/"))
        .unwrap_or(false)
}

/// Read a response body up to `cap` bytes (favicon `<link>`s live in `<head>`,
/// so the whole document is never needed) and lossily decode it as UTF-8.
async fn read_head_html(mut resp: reqwest::Response, cap: usize) -> String {
    let mut buf: Vec<u8> = Vec::new();
    while buf.len() < cap {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                // Favicon links live in <head>; once it closes there is no
                // reason to keep downloading a possibly multi-MB body.
                if buf.windows(6).any(|w| w.eq_ignore_ascii_case(b"</head")) {
                    break;
                }
            }
            _ => break,
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Pick the best `<link rel="icon">` href from HTML: the one with the largest
/// declared `sizes` (crisper when downscaled), falling back to the first icon
/// link. Only `rel="icon"` / `rel="shortcut icon"` count - apple-touch / mask
/// icons are skipped (often oversized or monochrome silhouettes).
fn pick_icon_href(html: &str) -> Option<String> {
    use std::cell::RefCell;
    use std::rc::Rc;
    let found: Rc<RefCell<Vec<(u32, String)>>> = Rc::new(RefCell::new(Vec::new()));
    let sink = found.clone();
    let mut rewriter = HtmlRewriter::new(
        Settings {
            element_content_handlers: vec![element!("link", move |el| {
                let rel = el
                    .get_attribute("rel")
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if rel.split_whitespace().any(|t| t == "icon") {
                    if let Some(href) = el.get_attribute("href") {
                        let href = href.trim().to_string();
                        if !href.is_empty() {
                            let width = el
                                .get_attribute("sizes")
                                .and_then(|s| parse_size_width(&s))
                                .unwrap_or(0);
                            sink.borrow_mut().push((width, href));
                        }
                    }
                }
                Ok(())
            })],
            ..Settings::default()
        },
        |_: &[u8]| {},
    );
    let _ = rewriter.write(html.as_bytes());
    let _ = rewriter.end();
    let v = found.borrow();
    v.iter().max_by_key(|(w, _)| *w).map(|(_, h)| h.clone())
}

/// Largest pixel width declared in a `sizes` attribute (`"16x16 32x32"` -> 32),
/// or None for `"any"` / unparseable values.
fn parse_size_width(sizes: &str) -> Option<u32> {
    sizes
        .split_whitespace()
        .filter_map(|tok| {
            tok.split(['x', 'X'])
                .next()
                .and_then(|w| w.parse::<u32>().ok())
        })
        .max()
}
