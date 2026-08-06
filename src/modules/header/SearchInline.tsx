import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import type { EditorPaneHandle, MatchPos } from "@/modules/editor";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { shortcutHint } from "@/modules/shortcuts/shortcuts";
import type { SearchAddon } from "@xterm/addon-search";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

const NO_MATCHES: MatchPos = { current: 0, total: 0 };

// Shared look for the prev/next/clear buttons crowded into the field's right edge.
const FIELD_BUTTON = cn(
  "shrink-0 cursor-pointer rounded p-0.5 transition-colors",
  "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
);

/**
 * Resolves xterm search decoration colours from the active theme. xterm's
 * canvas renderer needs concrete rgb strings (not `var(...)`), so we probe
 * the live CSS custom properties on demand. Active match tracks
 * `--tedi-icon-working` (gold/amber in default; canonical per preset),
 * inactive matches use `--muted-foreground` so they read as "found but not
 * focused". Recomputed per call so theme switches re-tint immediately.
 */
function termDecorations(): {
  matchBackground: string;
  activeMatchBackground: string;
  matchOverviewRuler: string;
  activeMatchColorOverviewRuler: string;
} {
  const probe = document.createElement("div");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  document.body.appendChild(probe);
  const resolve = (varName: string, fallback: string): string => {
    probe.style.color = `var(${varName}, ${fallback})`;
    return getComputedStyle(probe).color || fallback;
  };
  const active = resolve("--tedi-icon-working", "#d18616");
  const match = resolve("--muted-foreground", "#515c6a");
  probe.remove();
  return {
    matchBackground: match,
    activeMatchBackground: active,
    matchOverviewRuler: active,
    activeMatchColorOverviewRuler: active,
  };
}

export type SearchTarget =
  | { kind: "terminal"; addon: SearchAddon; focus: () => void }
  | { kind: "editor"; handle: EditorPaneHandle; focus: () => void }
  | null;

export type SearchInlineHandle = { focus: () => void };

type Props = {
  target: SearchTarget;
  /** Collapse to an icon-only button until opened. */
  compact?: boolean;
  ref?: Ref<SearchInlineHandle>;
};

export function SearchInline({ target, compact, ref }: Props) {
  const [q, setQ] = useState("");
  const [matches, setMatches] = useState<MatchPos>(NO_MATCHES);
  // Compact mode hides the field behind an icon until activated.
  const [openInCompact, setOpenInCompact] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingFocusRef = useRef(false);
  const setInputRef = useCallback((el: HTMLInputElement | null) => {
    inputRef.current = el;
    if (!el || !pendingFocusRef.current) return;
    pendingFocusRef.current = false;
    el.focus();
  }, []);

  const userShortcuts = usePreferencesStore((s) => s.shortcuts);

  const shortcutText = useMemo(() => shortcutHint("search.focus", userShortcuts), [userShortcuts]);

  const placeholder = "Search";
  const tooltipTitle = shortcutText ? `Search (${shortcutText})` : "Search";

  const expanded = !compact || openInCompact;

  const focus = useCallback(() => {
    pendingFocusRef.current = true;
    if (compact) setOpenInCompact(true);
    else inputRef.current?.focus();
    if (inputRef.current) pendingFocusRef.current = false;
  }, [compact]);

  useImperativeHandle(ref, () => ({ focus }), [focus]);

  const clearTarget = useCallback(() => {
    if (!target) return;
    if (target.kind === "terminal") target.addon.clearDecorations();
    else target.handle.clearQuery();
  }, [target]);

  const restoreTargetFocus = useCallback(() => {
    if (!target) return;
    target.focus();
  }, [target]);

  // Drop highlights when target switches or is removed.
  useEffect(() => clearTarget, [clearTarget]);

  // "{current}/{total}", VS Code style. Both engines push it: xterm fires
  // onDidChangeResults (decorations are always on), and the editor pane feeds
  // CodeMirror's count — or the markdown preview's, when previewing.
  useEffect(() => {
    setMatches(NO_MATCHES);
    if (!target) return;
    if (target.kind === "editor") {
      const handle = target.handle;
      handle.setMatchListener(setMatches);
      return () => handle.setMatchListener(null);
    }
    // resultIndex is -1 once xterm's highlight threshold is exceeded.
    const sub = target.addon.onDidChangeResults(({ resultIndex, resultCount }) =>
      setMatches({ current: resultIndex + 1, total: resultCount }),
    );
    return () => sub.dispose();
  }, [target]);

  const applyIncremental = (next: string) => {
    if (!next) setMatches(NO_MATCHES);
    if (!target) return;
    if (target.kind === "terminal") {
      if (next) {
        target.addon.findNext(next, {
          incremental: true,
          decorations: termDecorations(),
        });
      } else {
        target.addon.clearDecorations();
      }
    } else {
      target.handle.setQuery(next);
    }
  };

  const findDirection = (forward: boolean) => {
    if (!target || !q) return;
    if (target.kind === "terminal") {
      const opts = { decorations: termDecorations() };
      if (forward) target.addon.findNext(q, opts);
      else target.addon.findPrevious(q, opts);
    } else {
      if (forward) target.handle.findNext();
      else target.handle.findPrevious();
    }
  };

  // The match counter and its nav arrows only exist once something is typed,
  // so the field widens then rather than reserving the space up front.
  const noMatches = q.length > 0 && matches.total === 0;

  return (
    <motion.div
      layout
      initial={false}
      animate={{ width: expanded ? (q ? 268 : 168) : 28 }}
      transition={{ type: "spring", stiffness: 380, damping: 34 }}
      className="relative h-7 shrink-0"
    >
      <AnimatePresence initial={false} mode="wait">
        {expanded ? (
          <motion.div
            key="input"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="absolute inset-0"
          >
            <Search
              size={13}
              strokeWidth={1.75}
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 -translate-y-1/2"
            />
            <Input
              ref={setInputRef}
              value={q}
              placeholder={placeholder}
              className={cn(
                "bg-muted/80 border-border placeholder:text-muted-foreground/70 h-7 w-full pl-7 text-[12.5px]! focus-visible:ring-0",
                q ? "pr-[86px]" : "pr-12",
                noMatches && "border-destructive/60",
              )}
              onChange={(e) => {
                const next = e.target.value;
                setQ(next);
                applyIncremental(next);
              }}
              onBlur={() => {
                if (compact && !q) setOpenInCompact(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  findDirection(!e.shiftKey);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  clearTarget();
                  setQ("");
                  setMatches(NO_MATCHES);
                  if (compact) {
                    setOpenInCompact(false);
                  }
                  restoreTargetFocus();
                }
              }}
            />
            {q ? (
              <div className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-0.5">
                <span
                  className={cn(
                    "px-0.5 font-mono text-[10px] tabular-nums",
                    noMatches ? "text-destructive" : "text-muted-foreground",
                  )}
                  aria-live="polite"
                >
                  {matches.total === 0 ? "0/0" : `${matches.current}/${matches.total}`}
                </span>
                <button
                  type="button"
                  // Keep the caret in the field so Enter keeps stepping matches.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => findDirection(false)}
                  disabled={matches.total === 0}
                  className={FIELD_BUTTON}
                  aria-label="Previous match"
                  title="Previous match (Shift+Enter)"
                >
                  <ChevronUp size={11} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => findDirection(true)}
                  disabled={matches.total === 0}
                  className={FIELD_BUTTON}
                  aria-label="Next match"
                  title="Next match (Enter)"
                >
                  <ChevronDown size={11} strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setQ("");
                    clearTarget();
                    setMatches(NO_MATCHES);
                    inputRef.current?.focus();
                  }}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0 cursor-pointer rounded p-0.5"
                  aria-label="Clear search"
                  title="Clear (Esc)"
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
            ) : shortcutText ? (
              // Shortcut hint as a kbd badge pinned to the far right (hidden once
              // the user starts typing, where the clear button takes its place).
              <kbd className="border-border/70 bg-background/50 text-muted-foreground/70 pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded border px-1 py-px font-mono text-[9.5px] leading-none font-medium">
                {shortcutText}
              </kbd>
            ) : null}
          </motion.div>
        ) : (
          <motion.div
            key="icon"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="absolute inset-0 flex items-center justify-end"
          >
            <IconTooltip label={tooltipTitle} side="bottom">
              <Button
                variant="ghost"
                size="icon"
                className={cn("text-muted-foreground", TOOLBAR_HOVER, "size-7 shrink-0 rounded-md")}
                onClick={focus}
                aria-label={tooltipTitle}
              >
                <Search size={15} strokeWidth={1.75} />
              </Button>
            </IconTooltip>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
