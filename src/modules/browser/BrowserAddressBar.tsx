import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { pathToFileUrl } from "@/lib/path";
import { fmtShortcut, MOD_KEY, ALT_KEY, SHIFT_KEY } from "@/lib/platform";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildSearchUrl } from "@/modules/settings/searchEngines";
import { isSelfReferenceUrl, SELF_REFERENCE_NOTICE } from "./lib/proxy";
import { BrowserExtensionsMenu } from "./BrowserExtensionsMenu";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  File,
  Globe,
  Info,
  Lock,
  RefreshCw,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { BROWSER_ZOOM_STEPS } from "./lib/native";

const ZOOM_MIN = BROWSER_ZOOM_STEPS[0];
const ZOOM_MAX = BROWSER_ZOOM_STEPS[BROWSER_ZOOM_STEPS.length - 1];

export type BrowserAddressBarHandle = {
  focus: () => void;
};

/** Edge-style address-bar security indicator derived from the URL scheme: a
 *  padlock for https, a "not secure" info glyph (amber) for http, and a neutral
 *  globe for a blank or unparseable address. */
function securityFor(url: string): {
  icon: LucideIcon;
  label: string;
  className: string;
} {
  let scheme = "";
  try {
    scheme = new URL(url).protocol;
  } catch {
    scheme = "";
  }
  if (scheme === "https:") {
    return {
      icon: Lock,
      label: "Connection is secure (HTTPS)",
      className: "text-muted-foreground/80",
    };
  }
  if (scheme === "http:") {
    return {
      icon: Info,
      label: "Not secure (HTTP)",
      className: "text-icon-working",
    };
  }
  if (scheme === "file:") {
    return { icon: File, label: "Local file", className: "text-muted-foreground/80" };
  }
  return { icon: Globe, label: "Enter an address", className: "text-muted-foreground/60" };
}

type Props = {
  /** Leaf id of the owning pane. The extensions menu needs it to ask the engine
   *  what it has loaded, and to open store / settings pages in this same pane. */
  paneId: number;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Current page zoom; 1 is 100%. */
  zoom: number;
  onSubmit: (url: string) => void;
  onReload: () => void;
  /** Cancel a load in progress. The reload control becomes this while loading. */
  onStop: () => void;
  onBack: () => void;
  onForward: () => void;
  onZoom: (dir: 1 | -1) => void;
  onZoomReset: () => void;
  ref?: Ref<BrowserAddressBarHandle>;
};

export function BrowserAddressBar({
  paneId,
  url,
  loading,
  canGoBack,
  canGoForward,
  zoom,
  onSubmit,
  onReload,
  onStop,
  onBack,
  onForward,
  onZoom,
  onZoomReset,
  ref,
}: Props) {
  const [draft, setDraft] = useState(url);
  const inputRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Keep draft in sync when the parent updates the URL externally
  // (AI tool, detected localhost chip, in-page navigation, etc.).
  useEffect(() => {
    setDraft(url);
  }, [url]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        const el = inputRef.current;
        if (!el) return;
        el.focus();
        el.select();
      },
    }),
    [],
  );

  const security = securityFor(url);
  const SecurityIcon = security.icon;
  const searchEngine = usePreferencesStore((s) => s.searchEngine);

  const submit = () => {
    const next = normalizeUrl(draft, searchEngine);
    if (!next) {
      setNotice("Enter a URL or search term.");
      return;
    }
    if (isSelfReferenceUrl(next)) {
      setNotice(SELF_REFERENCE_NOTICE);
      return;
    }
    setNotice(null);
    if (next !== url) onSubmit(next);
    else onReload();
  };

  return (
    <div className="border-border/60 shrink-0 border-b">
      {/* @container so the toolbar can shed controls instead of crushing the
          address field: a browser pane in a three or four way split gets narrow,
          and six icon buttons plus a field do not fit. */}
      <div className="bg-card/40 @container flex h-9 items-center gap-1 px-1.5">
        <IconTooltip label={`Back (${fmtShortcut(ALT_KEY, "←")})`} side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onBack}
            disabled={!canGoBack}
            aria-label="Back"
            className={`text-muted-foreground ${TOOLBAR_HOVER} size-7 shrink-0 rounded-md disabled:opacity-40`}
          >
            <ChevronLeft size={15} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
        <IconTooltip label={`Forward (${fmtShortcut(ALT_KEY, "→")})`} side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onForward}
            disabled={!canGoForward}
            aria-label="Forward"
            className={`text-muted-foreground ${TOOLBAR_HOVER} size-7 shrink-0 rounded-md disabled:opacity-40`}
          >
            <ChevronRight size={15} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
        {/* One control, two jobs, exactly like every browser's: reload when idle,
            stop while loading. A spinning reload icon you cannot click to cancel
            leaves a hung page with no way out. */}
        <IconTooltip
          label={loading ? "Stop loading" : `Reload (${fmtShortcut(MOD_KEY, SHIFT_KEY, "R")})`}
          side="top"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={loading ? onStop : onReload}
            aria-label={loading ? "Stop loading" : "Reload"}
            className={`text-muted-foreground ${TOOLBAR_HOVER} size-7 shrink-0 rounded-md`}
          >
            {/* Both render at 16px regardless of `size` (the Button's
                `[&_svg:not([class*='size-'])]:size-4` beats the attribute), so
                only strokeWidth has to be kept in step. */}
            {loading ? (
              <X size={15} strokeWidth={1.75} />
            ) : (
              <RefreshCw size={14} strokeWidth={1.75} />
            )}
          </Button>
        </IconTooltip>
        {/* Icon + URL share one rounded field (Edge-style): the wrapper carries
            the box, the input itself is transparent and borderless. */}
        <div className="bg-muted/60 focus-within:ring-ring/50 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 focus-within:ring-1">
          <IconTooltip label={security.label} side="top">
            <span
              className="flex size-4 shrink-0 cursor-default items-center justify-center"
              aria-label={security.label}
            >
              <SecurityIcon size={14} strokeWidth={1.75} className={security.className} />
            </span>
          </IconTooltip>
          <Input
            ref={inputRef}
            value={draft}
            placeholder="Search or enter address"
            spellCheck={false}
            autoComplete="off"
            className="placeholder:text-muted-foreground/70 h-full w-full border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(url);
                inputRef.current?.blur();
              }
            }}
          />
        </div>
        {/* Zoom. Two steppers with the current level between them, and the level
            is shown only when it is not 100% so the toolbar stays quiet at the
            default (Edge behaves the same). Clicking the level resets it.
            Ctrl+plus / Ctrl+minus / Ctrl+scroll also work, but those are the
            webview's own accelerators acting on the focused page - TEDI never
            sees them, which is why the readout is re-read rather than assumed. */}
        <div className="hidden shrink-0 items-center @[22rem]:flex">
          <IconTooltip label={`Zoom out (${fmtShortcut(MOD_KEY, "-")})`} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onZoom(-1)}
              disabled={!url || zoom <= ZOOM_MIN + 1e-6}
              aria-label="Zoom out"
              className={`text-muted-foreground ${TOOLBAR_HOVER} size-7 shrink-0 rounded-md disabled:opacity-40`}
            >
              <ZoomOut size={14} strokeWidth={1.75} />
            </Button>
          </IconTooltip>
          {Math.abs(zoom - 1) > 1e-6 ? (
            <IconTooltip label="Reset zoom to 100%" side="top">
              <button
                type="button"
                onClick={onZoomReset}
                aria-label={`Zoom ${Math.round(zoom * 100)} percent, click to reset`}
                className={`text-muted-foreground hover:text-foreground ${TOOLBAR_HOVER} h-7 shrink-0 cursor-pointer rounded-md px-1 text-[11px] tabular-nums`}
              >
                {Math.round(zoom * 100)}%
              </button>
            </IconTooltip>
          ) : null}
          <IconTooltip label={`Zoom in (${fmtShortcut(MOD_KEY, "+")})`} side="top">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onZoom(1)}
              disabled={!url || zoom >= ZOOM_MAX - 1e-6}
              aria-label="Zoom in"
              className={`text-muted-foreground ${TOOLBAR_HOVER} size-7 shrink-0 rounded-md disabled:opacity-40`}
            >
              <ZoomIn size={14} strokeWidth={1.75} />
            </Button>
          </IconTooltip>
        </div>
        {/* Where every browser puts it, and so where anyone goes looking.
            Renders nothing off Windows, whose engines can't load extensions. */}
        <BrowserExtensionsMenu paneId={paneId} url={url} onNavigate={onSubmit} />
        <IconTooltip label="Open in system browser" side="top">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              if (url) void openUrl(url).catch(console.error);
            }}
            aria-label="Open in system browser"
            className={`text-muted-foreground ${TOOLBAR_HOVER} size-7 shrink-0 rounded-md`}
            disabled={!url}
          >
            <ExternalLink size={14} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
      </div>
      {notice ? (
        <div className="bg-icon-working/8 text-icon-working flex items-center gap-1.5 px-3 py-1 text-[11px]">
          <span className="truncate">{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="hover:bg-accent ml-auto cursor-pointer rounded px-1 text-[10px] opacity-80 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Turn raw address-bar input into a navigable URL. Explicit schemes pass
 * through; localhost / IPs / single-token domains (no spaces, has a dot + TLD)
 * get an http(s) scheme. A `file://` URL or a bare local filesystem path opens
 * the file directly. Anything else (a bare word like "youtube", or any text with
 * spaces) is treated as a query and routed to the default search engine,
 * mirroring Chrome/Edge omnibox behaviour.
 */
function normalizeUrl(raw: string, searchEngineId: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // A local file URL typed directly (file:///… or file://host/…) - pass through.
  if (/^file:\/\//i.test(trimmed)) return trimmed;
  // An installed browser extension's own page. A webview has no toolbar, so an
  // extension's popup has nowhere to appear and its dashboard is the only way to
  // configure it - without this the omnibox would search for the URL instead.
  if (/^chrome-extension:\/\//i.test(trimmed)) return trimmed;
  // A bare local path (Windows drive / UNC / POSIX absolute) -> a file:// URL so
  // a local HTML file opens directly. Checked BEFORE the whitespace test below,
  // since a real path may contain spaces (e.g. "TEDI - terax-ai").
  const fileUrl = pathToFileUrl(trimmed);
  if (fileUrl) return fileUrl;
  // A URL candidate has no whitespace; with a space it's always a search.
  if (!/\s/.test(trimmed)) {
    if (/^localhost(:|\/|$)/i.test(trimmed)) return `http://${trimmed}`;
    if (/^\d{1,3}(\.\d{1,3}){3}(:|\/|$)/.test(trimmed)) return `http://${trimmed}`;
    // word(.word)+ optionally :port and /path -> a domain (needs at least one dot).
    if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]\S*)?$/.test(trimmed)) return `https://${trimmed}`;
  }
  return buildSearchUrl(searchEngineId, trimmed);
}
