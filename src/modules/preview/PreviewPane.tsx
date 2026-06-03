import { AlertCircleIcon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  markPreviewCreated,
  PREVIEW_NAV_EVENT,
  previewEmbedDispatch,
  previewEmbedNavigate,
  previewEmbedSetBg,
  previewEmbedUpdate,
  type PreviewNavEvent,
  wasPreviewCreatedTransparent,
} from "./lib/native";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { anyOverlayIntersects, useAnyOverlayOpen, usePaneDragActive } from "./lib/overlaySuppress";
import { isSelfReferenceUrl, SELF_REFERENCE_NOTICE } from "./lib/proxy";
import { PreviewAddressBar, type PreviewAddressBarHandle } from "./PreviewAddressBar";

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

export type PreviewPaneHandle = {
  reload: () => void;
  focusAddressBar: () => void;
  getUrl: () => string;
};

type Props = {
  id: number;
  url: string;
  visible: boolean;
  onUrlChange: (url: string) => void;
  ref?: Ref<PreviewPaneHandle>;
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
 *   - tracks navigation via the `PREVIEW_NAV_EVENT` Tauri event to drive the
 *     address bar + back/forward history;
 *   - destroys the webview on unmount (tab close).
 */
export function PreviewPane({ id, url, visible, onUrlChange, ref }: Props) {
  const [history, setHistory] = useState<History>(() =>
    url ? { entries: [url], index: 0 } : { entries: [], index: -1 },
  );
  const [loading, setLoading] = useState(false);
  const anyOverlayOpen = useAnyOverlayOpen();
  const paneDragActive = usePaneDragActive();
  // Follow whole-app transparency: a transparent TEDI makes the browser
  // backdrop transparent too. `transparent` (read at create) enables the alpha
  // webview; `appOpacity` then drives the backdrop level live (see below).
  const appOpacity = usePreferencesStore((s) => s.appOpacity);
  const transparent = appOpacity < 1;
  const addressRef = useRef<PreviewAddressBarHandle>(null);
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

  const syncBounds = useCallback(() => {
    const el = contentRef.current;
    let show =
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
      } else if (anyOverlayOpenRef.current && anyOverlayIntersects(r)) {
        // A dropdown / dialog / popover is covering the pane - yield to the DOM
        // by hiding the always-on-top native webview while it's open.
        show = false;
      }
    }

    if (!show || !r) {
      if (sentRef.current?.visible !== false && !inFlightRef.current) {
        sentRef.current = { visible: false, key: "" };
        inFlightRef.current = true;
        void previewEmbedUpdate(
          id,
          currentRef.current,
          { x: 0, y: 0, width: 0, height: 0 },
          false,
          transparentRef.current,
        )
          .catch(() => {})
          .finally(() => {
            inFlightRef.current = false;
          });
      }
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const bounds = {
      x: Math.round(r.left * dpr),
      y: Math.round(r.top * dpr),
      width: Math.round(r.width * dpr),
      height: Math.round(r.height * dpr),
    };
    const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    if (sentRef.current?.visible === true && sentRef.current.key === key) return;
    if (inFlightRef.current) return;
    const now = performance.now();
    if (now - lastSendRef.current < 40) return; // throttle to ~25fps
    lastSendRef.current = now;
    const prev = sentRef.current;
    sentRef.current = { visible: true, key };
    // The first visible send for this leaf is the create (Rust has no webview
    // yet); record whether it was alpha-capable, keyed by leaf id so it
    // survives this component remounting on pane moves. Idempotent afterwards.
    markPreviewCreated(id, transparentRef.current);
    inFlightRef.current = true;
    void previewEmbedUpdate(id, currentRef.current, bounds, true, transparentRef.current)
      .catch(() => {
        sentRef.current = prev; // let the next tick retry
      })
      .finally(() => {
        inFlightRef.current = false;
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

  // NOTE: the webview is intentionally NOT destroyed on unmount. Moving a pane
  // to a new split parent remounts this component; destroying + recreating the
  // webview there would reload the page. Instead PaneStack closes the webview
  // only when the leaf truly disappears (see its prune effect). On remount,
  // the bounds sync below finds the existing webview and just repositions it.

  // Navigation reports from the native webview (load start / finish).
  useEffect(() => {
    let alive = true;
    let unlisten: UnlistenFn | undefined;
    void listen<PreviewNavEvent>(PREVIEW_NAV_EVENT, (e) => {
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
      <PreviewAddressBar
        ref={addressRef}
        url={current}
        loading={loading}
        canGoBack={history.index > 0}
        canGoForward={history.index >= 0 && history.index < history.entries.length - 1}
        onSubmit={handleSubmit}
        onReload={handleReload}
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
        <HugeiconsIcon icon={Globe02Icon} size={20} strokeWidth={1.5} />
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
      <div className="flex size-12 items-center justify-center rounded-2xl border border-icon-working/30 bg-icon-working/10 text-icon-working">
        <HugeiconsIcon icon={AlertCircleIcon} size={20} strokeWidth={1.5} />
      </div>
      <div className="space-y-1.5">
        <p className="text-foreground text-sm font-medium">Preview blocked</p>
        <p className="text-muted-foreground max-w-sm text-xs leading-relaxed">
          {SELF_REFERENCE_NOTICE} Pick a different URL to continue.
        </p>
      </div>
    </div>
  );
}
