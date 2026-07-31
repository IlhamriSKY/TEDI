import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import {
  markPreviewCreated,
  nextBrowserZoom,
  BROWSER_NAV_EVENT,
  BROWSER_FOCUS_ADDRESS_EVENT,
  previewEmbedDispatch,
  previewEmbedNavigate,
  previewEmbedSetBg,
  previewEmbedUpdate,
  previewEmbedUrl,
  previewEmbedZoom,
  previewEmbedZoomGet,
  type BrowserNavEvent,
  type EmbedBounds,
  wasPreviewCreatedTransparent,
} from "./lib/native";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { IS_WINDOWS } from "@/lib/platform";
import {
  anyOverlayIntersects,
  overlayRectsOver,
  useAnyOverlayOpen,
  usePaneDragActive,
} from "./lib/overlaySuppress";
import { isSelfReferenceUrl, SELF_REFERENCE_NOTICE } from "./lib/proxy";
import { BrowserAddressBar, type BrowserAddressBarHandle } from "./BrowserAddressBar";
import { CircleAlert, Globe } from "lucide-react";

// Resolving an arbitrary CSS color (hex / hsl / oklch / var) to "r, g, b" needs
// a DOM probe + style recalc, so cache it keyed by the raw value: the canvas
// color only changes on a theme edit, not on every page load / opacity tick.
let cachedCanvasRaw = "";
let cachedCanvasRgb = "0, 0, 0";

function canvasRgb(): string {
  let raw = "";
  try {
    raw = getComputedStyle(document.documentElement).getPropertyValue("--tedi-canvas-bg").trim();
  } catch {
    return cachedCanvasRgb;
  }
  if (!raw || raw === cachedCanvasRaw) return cachedCanvasRgb;
  try {
    const probe = document.createElement("span");
    probe.style.color = raw;
    probe.style.display = "none";
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color; // normalized to rgb()/rgba()
    probe.remove();
    const m = resolved.match(/(\d+)\D+(\d+)\D+(\d+)/);
    if (m) {
      cachedCanvasRgb = `${m[1]}, ${m[2]}, ${m[3]}`;
      cachedCanvasRaw = raw;
    }
  } catch {
    /* keep the previous value */
  }
  return cachedCanvasRgb;
}

/** The app's canvas background as `rgba(r,g,b,alpha)`, so a transparent browser
 *  backdrop matches the rest of TEDI's glass at the same opacity level. */
function canvasBgRgba(alpha: number): string {
  return `rgba(${canvasRgb()}, ${alpha})`;
}

export type BrowserPaneHandle = {
  reload: () => void;
  focusAddressBar: () => void;
  getUrl: () => string;
};

type Props = {
  id: number;
  url: string;
  visible: boolean;
  onUrlChange: (url: string) => void;
  ref?: Ref<BrowserPaneHandle>;
};

type History = { entries: string[]; index: number };

type SentBounds = { visible: boolean; key: string };

/**
 * Preview tab backed by a real native browser webview (WebView2 / WebKit)
 * docked over this pane's content area by the Rust `preview_embed_*` commands -
 * not an iframe. It is a full browser, so modern sites (YouTube, logged-in
 * apps, DRM video, WebSockets, HMR dev servers) all work.
 *
 * The native webview is a separate OS surface that floats above the DOM, so
 * this component:
 *   - measures the content rect every frame and pushes physical-pixel bounds
 *     to Rust (only when they change), keeping the webview glued to the pane;
 *   - hides the webview whenever this tab isn't the active one, an in-toolbar
 *     overlay (Ports menu) is open, the url is empty, or it would load TEDI;
 *   - tracks navigation via the `BROWSER_NAV_EVENT` Tauri event to drive the
 *     address bar + back/forward history;
 *   - destroys the webview on unmount (tab close).
 */
export function BrowserPane({ id, url, visible, onUrlChange, ref }: Props) {
  const [history, setHistory] = useState<History>(() =>
    url ? { entries: [url], index: 0 } : { entries: [], index: -1 },
  );
  const [loading, setLoading] = useState(false);
  // Page zoom, 1 = 100%. Only ever a DISPLAY copy: the webview's own Ctrl+plus /
  // Ctrl+minus / Ctrl+scroll change the real value without TEDI seeing the
  // keystroke (the page has focus, so nothing reaches the DOM), so every step
  // re-reads the live factor first and every load re-syncs this.
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  const anyOverlayOpen = useAnyOverlayOpen();
  const paneDragActive = usePaneDragActive();
  // Follow whole-app transparency: a transparent TEDI makes the browser
  // backdrop transparent too. `transparent` (read at create) enables the alpha
  // webview; `appOpacity` then drives the backdrop level live (see below).
  const appOpacity = usePreferencesStore((s) => s.appOpacity);
  const transparent = appOpacity < 1;
  const addressRef = useRef<BrowserAddressBarHandle>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const current = history.index >= 0 ? history.entries[history.index] : "";
  const selfBlocked = current ? isSelfReferenceUrl(current) : false;

  // Refs mirror the latest values so the rAF bounds loop reads them without
  // re-subscribing every render.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const currentRef = useRef(current);
  currentRef.current = current;
  const selfBlockedRef = useRef(selfBlocked);
  selfBlockedRef.current = selfBlocked;
  const anyOverlayOpenRef = useRef(anyOverlayOpen);
  anyOverlayOpenRef.current = anyOverlayOpen;
  const paneDragActiveRef = useRef(paneDragActive);
  paneDragActiveRef.current = paneDragActive;
  const transparentRef = useRef(transparent);
  transparentRef.current = transparent;
  const appOpacityRef = useRef(appOpacity);
  appOpacityRef.current = appOpacity;
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  const reconcile = useCallback((nextUrl: string) => {
    if (!nextUrl) return;
    setHistory((h) => {
      const cur = h.index >= 0 ? h.entries[h.index] : "";
      if (nextUrl === cur) return h; // reload / re-report of the same page
      if (h.index > 0 && nextUrl === h.entries[h.index - 1]) return { ...h, index: h.index - 1 };
      if (h.index < h.entries.length - 1 && nextUrl === h.entries[h.index + 1]) {
        return { ...h, index: h.index + 1 };
      }
      const entries = [...h.entries.slice(0, h.index + 1), nextUrl];
      return { entries, index: entries.length - 1 };
    });
  }, []);

  // --- native webview bounds sync -----------------------------------------
  const sentRef = useRef<SentBounds | null>(null);
  const inFlightRef = useRef(false);
  const lastSendRef = useRef(0);
  // Set when a hide is needed but a create/update send is still in flight (the
  // hide branch is gated on !inFlightRef). The in-flight send's `.finally`
  // re-runs syncBounds to issue the deferred hide, so switching tabs mid-create
  // doesn't leave the always-on-top webview shown over the now-active pane.
  const pendingHideRef = useRef(false);

  const syncBounds = useCallback(() => {
    const el = contentRef.current;
    const dpr = window.devicePixelRatio || 1;
    // Rectangles to cut out of the pane so a menu, dialog or tooltip drawn over
    // it is visible AND clickable while the page stays on screen. Only Windows
    // can do this (a window region on the pane's child HWND); everywhere else
    // an overlapping overlay still costs the whole page, via `show = false`.
    let holes: EmbedBounds[] = [];
    let show =
      // The native webview composites ABOVE the DOM. While the window is
      // minimized/hidden the rAF loop below is throttled, so without this it
      // would stay frozen-shown at stale bounds and, after the minimize/restore
      // pane relayout, cover a sibling terminal pane and eat its pointer events
      // (no text selection/copy, no drag-drop). Hiding on not-visible routes
      // through the `!show` branch, which re-shows correctly on restore.
      document.visibilityState === "visible" &&
      visibleRef.current &&
      !paneDragActiveRef.current &&
      !!currentRef.current &&
      !selfBlockedRef.current &&
      !!el;
    let r: DOMRect | null = null;
    if (show && el) {
      r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) {
        show = false;
      } else if (anyOverlayOpenRef.current) {
        if (IS_WINDOWS) {
          // Cut each overlay out instead of yielding the whole page. Rounded
          // outward by a pixel so an antialiased edge cannot leave a sliver of
          // page showing through under the menu's own border. An overlay that
          // covers the pane entirely leaves an empty region, which is the same
          // result as hiding, so that case needs no branch of its own.
          const pane = r;
          holes = overlayRectsOver(pane).map((o) => ({
            x: Math.floor((o.left - pane.left) * dpr) - 1,
            y: Math.floor((o.top - pane.top) * dpr) - 1,
            width: Math.ceil(o.width * dpr) + 2,
            height: Math.ceil(o.height * dpr) + 2,
          }));
        } else if (anyOverlayIntersects(r)) {
          show = false;
        }
      }
    }

    if (!show || !r) {
      if (sentRef.current?.visible !== false) {
        if (inFlightRef.current) {
          // A create/update is mid-flight; the hide can't go out now. Mark it so
          // that send's `.finally` re-runs syncBounds and issues the hide.
          pendingHideRef.current = true;
        } else {
          sentRef.current = { visible: false, key: "" };
          inFlightRef.current = true;
          void previewEmbedUpdate(
            id,
            currentRef.current,
            { x: 0, y: 0, width: 0, height: 0 },
            [],
            false,
            transparentRef.current,
          )
            .catch(() => {})
            .finally(() => {
              inFlightRef.current = false;
            });
        }
      }
      return;
    }

    const bounds = {
      x: Math.round(r.left * dpr),
      y: Math.round(r.top * dpr),
      width: Math.round(r.width * dpr),
      height: Math.round(r.height * dpr),
    };
    // Holes are part of the identity of what was sent: a menu opening, moving or
    // closing changes nothing about the bounds, and without this the pane would
    // keep whatever region it was last given.
    const boundsKey = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    const key = boundsKey + holes.map((h) => `|${h.x},${h.y},${h.width},${h.height}`).join("");
    if (sentRef.current?.visible === true && sentRef.current.key === key) return;
    if (inFlightRef.current) return;
    const now = performance.now();
    // Bounds move because the user is dragging something and expects the page to
    // keep up, so they stay at ~25fps. Holes move because an overlay is playing
    // its entrance animation, which nobody is waiting on and which re-clips the
    // pane - a forced repaint - on every frame of it. A quarter of the rate is
    // still well inside one animation, and the loop keeps running, so the final
    // resting position always lands on a later tick.
    const holesOnly =
      sentRef.current?.visible === true && sentRef.current.key.startsWith(boundsKey);
    if (now - lastSendRef.current < (holesOnly ? 160 : 40)) return;
    lastSendRef.current = now;
    const prev = sentRef.current;
    sentRef.current = { visible: true, key };
    // The first visible send for this leaf is the create (Rust has no webview
    // yet); record whether it was alpha-capable, keyed by leaf id so it
    // survives this component remounting on pane moves. Idempotent afterwards.
    markPreviewCreated(id, transparentRef.current);
    inFlightRef.current = true;
    void previewEmbedUpdate(id, currentRef.current, bounds, holes, true, transparentRef.current)
      .catch(() => {
        sentRef.current = prev; // let the next tick retry
      })
      .finally(() => {
        inFlightRef.current = false;
        // A hide requested while this send was in flight (tab switched away
        // mid-create) was deferred; issue it now so the webview doesn't stay
        // shown over the now-active pane.
        if (pendingHideRef.current) {
          pendingHideRef.current = false;
          syncBounds();
        }
      });
  }, [id]);

  // Drive bounds from a rAF loop while visible (catches pane moves from
  // splitter drags / sidebar resizes a ResizeObserver alone would miss). When
  // hidden the loop stops entirely, so background preview tabs cost nothing
  // beyond a single hide call.
  useEffect(() => {
    if (!visible) {
      syncBounds(); // shouldShow is false -> hides the webview once
      return;
    }
    let raf = 0;
    const tick = () => {
      syncBounds();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, syncBounds]);

  // The rAF loop above is throttled the instant the window is minimized, so it
  // may not get one more frame to issue the hide. Force a sync on the "hidden"
  // edge so the always-on-top webview is hidden immediately; on restore the rAF
  // loop resumes and reclaims the correct bounds (avoids a stale-rect re-show).
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) syncBounds();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [syncBounds]);

  // NOTE: the webview is intentionally NOT destroyed on unmount. Moving a pane
  // to a new split parent remounts this component; destroying + recreating the
  // webview there would reload the page. Instead PaneStack closes the webview
  // only when the leaf truly disappears (see its prune effect). On remount,
  // the bounds sync below finds the existing webview and just repositions it.

  // Navigation reports from the native webview (load start / finish).
  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | undefined;
    void listen<BrowserNavEvent>(BROWSER_NAV_EVENT, (e) => {
      const p = e.payload;
      if (!p || p.tabId !== id) return;
      if (p.kind === "navigated") {
        setLoading(true);
        reconcile(p.url);
      } else if (p.kind === "loaded") {
        setLoading(false);
        // A freshly loaded document resets inline styles, so re-apply the
        // transparent backdrop at the current opacity level.
        if (wasPreviewCreatedTransparent(id)) {
          void previewEmbedSetBg(id, canvasBgRgba(appOpacityRef.current)).catch(() => {});
        }
        // Re-sync the zoom readout against the page. This is the one moment we
        // are guaranteed a live JS context, and it also picks up any change the
        // webview's own Ctrl+plus / Ctrl+scroll made while TEDI was not looking.
        // Only while visible: the agent drives background panes through page
        // after page, and a readout nobody can see is not worth an eval round
        // trip on that loop. A step or a reset reads the live value anyway.
        if (visibleRef.current) {
          void previewEmbedZoomGet(id)
            .then((z) => setZoom(z))
            .catch(() => {});
        }
      } else if (p.kind === "title") {
        // SPA route changes fire a title change with the current URL; reconcile
        // it so the address bar tracks WITHOUT re-navigating (avoids a reload).
        reconcile(p.url);
      }
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [id, reconcile]);

  // Focus the address bar on the browser.focusAddressBar shortcut, delivered as
  // a window event keyed by leaf id so only the focused browser pane reacts.
  useEffect(() => {
    const onFocusAddress = (e: Event) => {
      if ((e as CustomEvent<{ leafId: number }>).detail?.leafId === id) {
        addressRef.current?.focus();
      }
    };
    window.addEventListener(BROWSER_FOCUS_ADDRESS_EVENT, onFocusAddress);
    return () => window.removeEventListener(BROWSER_FOCUS_ADDRESS_EVENT, onFocusAddress);
  }, [id]);

  // Live-follow the app-opacity slider: drive the transparent browser backdrop
  // to the canvas color at the current alpha. Only for alpha-capable webviews
  // (created transparent); opaque-created panes keep their own page background.
  useEffect(() => {
    if (!wasPreviewCreatedTransparent(id)) return;
    void previewEmbedSetBg(id, canvasBgRgba(appOpacity)).catch(() => {});
  }, [id, appOpacity]);

  // Mirror the current url back to the owning tab (title + persistence),
  // seeded so the first render doesn't echo it straight back.
  const lastEmittedRef = useRef(url);
  useEffect(() => {
    if (current && current !== lastEmittedRef.current) {
      lastEmittedRef.current = current;
      onUrlChangeRef.current(current);
    }
  }, [current]);

  // External url changes (AI tool, detected-localhost chip, workspace restore)
  // that aren't the echo of our own onUrlChange above.
  useEffect(() => {
    if (!url || url === currentRef.current) return;
    lastEmittedRef.current = url;
    reconcile(url); // updates the address bar + seeds creation url
    if (!isSelfReferenceUrl(url)) {
      setLoading(true);
      void previewEmbedNavigate(id, url).catch(() => {});
    }
  }, [url, id, reconcile]);

  // The webview outlives this component: a pane move remounts the component, and
  // floating hands the webview to another window and back. So on mount, adopt
  // whatever page it is REALLY on instead of trusting the url this leaf was last
  // told about - otherwise docking a float back shows a stale address (and a
  // stale tab title) for whatever the user browsed to while it was popped out.
  // Resolves to null when no webview exists yet, which is the ordinary first
  // open, and then this is a no-op.
  useEffect(() => {
    let alive = true;
    const seeded = currentRef.current;
    void previewEmbedUrl(id)
      .then((live) => {
        // Only when nothing moved since mount. A navigation that landed while
        // this was in flight - the AI calling control_browser on a pane it just
        // moved, say - is NEWER than the answer we asked for, and adopting the
        // stale one would walk that navigation back.
        if (alive && live && currentRef.current === seeded) {
          reconcile(live); // the mirror effect above pushes it up to the tab
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, reconcile]);

  // Watchdog so a page that never reports "loaded" doesn't spin forever.
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => setLoading(false), 20000);
    return () => clearTimeout(t);
  }, [loading]);

  const handleSubmit = useCallback(
    (next: string) => {
      setLoading(true);
      reconcile(next); // optimistic: also seeds the creation url for first nav
      void previewEmbedNavigate(id, next).catch(() => {});
    },
    [id, reconcile],
  );

  const handleReload = useCallback(() => {
    setLoading(true);
    void previewEmbedDispatch(id, "reload").catch(() => {});
  }, [id]);

  /** Cancel a load in progress. `loading` is cleared here rather than waiting for
   *  a "loaded" report, because a stopped load does not necessarily produce one -
   *  otherwise the button would stay a spinner until the watchdog gave up. */
  const handleStop = useCallback(() => {
    setLoading(false);
    void previewEmbedDispatch(id, "stop").catch(() => {});
  }, [id]);

  /** Step the zoom, or reset it with `dir` 0. Reads the live factor first so a
   *  step after the user pressed Ctrl+plus in the page continues from where the
   *  page actually is instead of jumping back to our last known value. */
  const handleZoom = useCallback(
    async (dir: 1 | -1 | 0) => {
      let current = zoomRef.current;
      try {
        current = await previewEmbedZoomGet(id);
      } catch {
        /* no webview yet, or the page has no JS context - step from our copy */
      }
      const next = dir === 0 ? 1 : nextBrowserZoom(current, dir);
      setZoom(next);
      try {
        await previewEmbedZoom(id, next);
      } catch {
        /* pane closed mid-click */
      }
    },
    [id],
  );

  useImperativeHandle(
    ref,
    () => ({
      reload: handleReload,
      focusAddressBar: () => addressRef.current?.focus(),
      getUrl: () => currentRef.current,
    }),
    [handleReload],
  );

  return (
    <div
      className="border-border/60 bg-background flex h-full w-full flex-col overflow-hidden rounded-md border"
      style={{
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <BrowserAddressBar
        ref={addressRef}
        paneId={id}
        url={current}
        loading={loading}
        canGoBack={history.index > 0}
        canGoForward={history.index >= 0 && history.index < history.entries.length - 1}
        zoom={zoom}
        onSubmit={handleSubmit}
        onReload={handleReload}
        onStop={handleStop}
        onZoom={(dir) => void handleZoom(dir)}
        onZoomReset={() => void handleZoom(0)}
        onBack={() => void previewEmbedDispatch(id, "back").catch(() => {})}
        onForward={() => void previewEmbedDispatch(id, "forward").catch(() => {})}
      />
      <div ref={contentRef} className="bg-background relative min-h-0 flex-1">
        {/* The native webview floats over this region when a page is loaded;
            these states only render when it is hidden. */}
        {!current ? <EmptyState /> : selfBlocked ? <SelfBlockedState /> : null}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="border-border/60 bg-card text-muted-foreground flex size-12 items-center justify-center rounded-2xl border">
        <Globe size={20} strokeWidth={1.5} />
      </div>
      <div className="space-y-1.5">
        <p className="text-foreground text-sm font-medium">Nothing to preview yet</p>
        <p className="text-muted-foreground max-w-sm text-xs leading-relaxed">
          Type a URL above to start browsing. This is a real browser, so any site - YouTube,
          logged-in apps, or a dev server with hot reload - loads right here in the tab.
        </p>
      </div>
    </div>
  );
}

function SelfBlockedState() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="border-icon-working/30 bg-icon-working/10 text-icon-working flex size-12 items-center justify-center rounded-2xl border">
        <CircleAlert size={20} strokeWidth={1.5} />
      </div>
      <div className="space-y-1.5">
        <p className="text-foreground text-sm font-medium">Browser blocked</p>
        <p className="text-muted-foreground max-w-sm text-xs leading-relaxed">
          {SELF_REFERENCE_NOTICE} Pick a different URL to continue.
        </p>
      </div>
    </div>
  );
}
