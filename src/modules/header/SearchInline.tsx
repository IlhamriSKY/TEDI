import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { KEY_SEP } from "@/lib/platform";
import type { EditorPaneHandle } from "@/modules/editor";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getBindingTokens, SHORTCUTS } from "@/modules/shortcuts/shortcuts";
import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { SearchAddon } from "@xterm/addon-search";
import { AnimatePresence, motion } from "motion/react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

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
};

export const SearchInline = forwardRef<SearchInlineHandle, Props>(function SearchInline(
  { target, compact },
  ref,
) {
  const [q, setQ] = useState("");
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

  const shortcutText = useMemo(() => {
    const s = SHORTCUTS.find((s) => s.id === "search.focus");
    if (!s) return "";
    const bindings = userShortcuts["search.focus"] || s.defaultBindings;
    if (!bindings || bindings.length === 0) return "";
    const tokens = getBindingTokens(bindings[0]);
    return tokens.join(KEY_SEP);
  }, [userShortcuts]);

  const placeholder = useMemo(() => {
    return shortcutText ? `Search (${shortcutText})` : "Search";
  }, [shortcutText]);

  const tooltipTitle = useMemo(() => {
    return shortcutText ? `Search (${shortcutText})` : "Search";
  }, [shortcutText]);

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

  const applyIncremental = (next: string) => {
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

  return (
    <motion.div
      layout
      initial={false}
      animate={{ width: expanded ? 192 : 28 }}
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
            <HugeiconsIcon
              icon={Search01Icon}
              size={13}
              strokeWidth={1.75}
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 -translate-y-1/2"
            />
            <Input
              ref={setInputRef}
              value={q}
              placeholder={placeholder}
              className="bg-muted/80 placeholder:text-muted-foreground/70 h-7 w-full pr-7 pl-7 text-[13px]! focus-visible:ring-0"
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
                  if (compact) {
                    setOpenInCompact(false);
                  }
                  restoreTargetFocus();
                }
              }}
            />
            {q && (
              <button
                type="button"
                onClick={() => {
                  setQ("");
                  clearTarget();
                  inputRef.current?.focus();
                }}
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer rounded p-0.5"
                aria-label="Clear search"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </button>
            )}
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
                className="text-muted-foreground hover:bg-accent hover:text-accent-foreground size-7 shrink-0 rounded-md"
                onClick={focus}
                aria-label={tooltipTitle}
              >
                <HugeiconsIcon icon={Search01Icon} size={15} strokeWidth={1.75} />
              </Button>
            </IconTooltip>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
});
