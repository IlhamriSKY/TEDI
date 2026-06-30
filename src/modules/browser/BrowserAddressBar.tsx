import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { pathToFileUrl } from "@/lib/path";
import { fmtShortcut, MOD_KEY, ALT_KEY, SHIFT_KEY } from "@/lib/platform";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  File01Icon,
  Globe02Icon,
  InformationCircleIcon,
  LinkSquare02Icon,
  RefreshIcon,
  SquareLock01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { buildSearchUrl } from "@/modules/settings/searchEngines";
import { isSelfReferenceUrl, SELF_REFERENCE_NOTICE } from "./lib/proxy";

export type BrowserAddressBarHandle = {
  focus: () => void;
};

/** Edge-style address-bar security indicator derived from the URL scheme: a
 *  padlock for https, a "not secure" info glyph (amber) for http, and a neutral
 *  globe for a blank or unparseable address. */
function securityFor(url: string): {
  icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
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
      icon: SquareLock01Icon,
      label: "Connection is secure (HTTPS)",
      className: "text-muted-foreground/80",
    };
  }
  if (scheme === "http:") {
    return {
      icon: InformationCircleIcon,
      label: "Not secure (HTTP)",
      className: "text-icon-working",
    };
  }
  if (scheme === "file:") {
    return { icon: File01Icon, label: "Local file", className: "text-muted-foreground/80" };
  }
  return { icon: Globe02Icon, label: "Enter an address", className: "text-muted-foreground/60" };
}

type Props = {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onSubmit: (url: string) => void;
  onReload: () => void;
  onBack: () => void;
  onForward: () => void;
  ref?: Ref<BrowserAddressBarHandle>;
};

export function BrowserAddressBar({
  url,
  loading,
  canGoBack,
  canGoForward,
  onSubmit,
  onReload,
  onBack,
  onForward,
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
      <div className="bg-card/40 flex h-9 items-center gap-1 px-1.5">
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
            <HugeiconsIcon icon={ArrowLeft01Icon} size={15} strokeWidth={1.75} />
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
            <HugeiconsIcon icon={ArrowRight01Icon} size={15} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
        <IconTooltip
          label={loading ? "Loading…" : `Reload (${fmtShortcut(MOD_KEY, SHIFT_KEY, "R")})`}
          side="top"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onReload}
            aria-label="Reload"
            className={`text-muted-foreground ${TOOLBAR_HOVER} size-7 shrink-0 rounded-md`}
          >
            <HugeiconsIcon
              icon={RefreshIcon}
              size={14}
              strokeWidth={1.75}
              className={loading ? "animate-spin" : undefined}
            />
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
              <HugeiconsIcon
                icon={security.icon}
                size={14}
                strokeWidth={1.75}
                className={security.className}
              />
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
            <HugeiconsIcon icon={LinkSquare02Icon} size={14} strokeWidth={1.75} />
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
