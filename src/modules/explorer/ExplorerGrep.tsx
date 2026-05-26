import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  FileSearchIcon,
  ReplaceAllIcon,
  ReplaceIcon,
  UnfoldLessIcon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { fileIconUrl } from "./lib/iconResolver";

type GrepHit = {
  path: string;
  rel: string;
  line: number;
  text: string;
};

type GrepResponse = {
  hits: GrepHit[];
  truncated: boolean;
  files_scanned: number;
};

type GrepReplaceResponse = {
  files_changed: number;
  total_replacements: number;
  edits: { path: string; rel: string; replacements: number }[];
  truncated: boolean;
};

type Props = {
  rootPath: string;
  onOpenFile: (path: string) => void;
  open: boolean;
  onRequestClose: () => void;
  onActiveChange?: (active: boolean) => void;
};

export type ExplorerGrepHandle = {
  focus: () => void;
  isFocused: () => boolean;
  /** Expand the replace row + focus the search input. Used by Ctrl+Shift+H. */
  focusWithReplace: () => void;
};

const HIGHLIGHT_CLASS = "bg-icon-working/30 text-foreground rounded-[2px] px-[1px]";

const MAX_LINE_CHARS = 240;

/** Escapes user input so it matches as a literal substring, not regex. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

/**
 * Tries to compile the user's regex client-side so we can show a "bad regex"
 * hint without round-tripping to Rust. JS regex isn't identical to Rust's
 * `regex` crate (no lookbehind in older browsers, slightly different
 * character-class semantics) but the common syntax overlaps - good enough
 * for early validation.
 */
function tryCompileRegex(pattern: string): string | null {
  try {
    new RegExp(pattern);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "invalid regex";
  }
}

function HighlightLine({
  text,
  needle,
  useRegex,
  caseInsensitive,
}: {
  text: string;
  needle: string;
  useRegex: boolean;
  caseInsensitive: boolean;
}) {
  const trimmed = text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + "…" : text;
  const re = useMemo(() => {
    if (!needle) return null;
    try {
      const src = useRegex ? needle : escapeRegex(needle);
      return new RegExp(src, caseInsensitive ? "gi" : "g");
    } catch {
      return null;
    }
  }, [needle, useRegex, caseInsensitive]);
  if (!needle || !re) return <>{trimmed}</>;
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let k = 0;
  for (const m of trimmed.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > lastIdx) out.push(trimmed.slice(lastIdx, start));
    out.push(
      <span key={k++} className={HIGHLIGHT_CLASS}>
        {m[0]}
      </span>,
    );
    lastIdx = start + m[0].length;
    // Zero-width match guard: advance one char so we don't loop forever.
    if (m[0].length === 0) lastIdx = start + 1;
  }
  if (lastIdx < trimmed.length) out.push(trimmed.slice(lastIdx));
  return <>{out}</>;
}

type Row =
  | { kind: "file"; rel: string; path: string; count: number }
  | { kind: "hit"; hit: GrepHit; hitIdx: number };

export const ExplorerGrep = forwardRef<ExplorerGrepHandle, Props>(function ExplorerGrep(
  { rootPath, onOpenFile, open, onRequestClose, onActiveChange }: Props,
  ref,
) {
  const [query, setQuery] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [hits, setHits] = useState<GrepHit[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [activeHitIdx, setActiveHitIdx] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Two-step confirm: first Enter on the Replace input (or first click on
  // the Replace All button) arms; second actually writes to disk. Disarmed
  // whenever the query/replace/options change so a re-run starts fresh.
  const [replaceArmed, setReplaceArmed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const active = query.trim().length > 0;
  const regexError = useRegex ? tryCompileRegex(query.trim()) : null;

  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      setQuery("");
      setReplaceText("");
      setHits([]);
      setTruncated(false);
      setSearching(false);
      setActiveHitIdx(0);
      setCollapsed(new Set());
      setReplaceArmed(false);
    }
  }, [open]);

  // Any change to the inputs/options resets the confirm arm so the user
  // never replaces text against a stale match set.
  useEffect(() => {
    setReplaceArmed(false);
  }, [query, replaceText, useRegex, caseSensitive, hits]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setTruncated(false);
      setSearching(false);
      setActiveHitIdx(0);
      return;
    }
    if (useRegex && regexError) {
      // Skip the backend call while the regex is invalid; banner explains it.
      setHits([]);
      setTruncated(false);
      setSearching(false);
      setActiveHitIdx(0);
      return;
    }
    setSearching(true);
    let alive = true;
    const handle = setTimeout(async () => {
      try {
        const resp = await invoke<GrepResponse>("fs_grep", {
          pattern: useRegex ? q : escapeRegex(q),
          root: rootPath,
          caseInsensitive: !caseSensitive,
          maxResults: 200,
        });
        if (alive) {
          setHits(resp.hits);
          setTruncated(resp.truncated);
          setActiveHitIdx(0);
        }
      } catch (e) {
        if (alive) {
          console.error("fs_grep failed:", e);
          setHits([]);
          setTruncated(false);
          setActiveHitIdx(0);
        }
      } finally {
        if (alive) setSearching(false);
      }
    }, 220);

    return () => {
      alive = false;
      clearTimeout(handle);
    };
  }, [query, rootPath, useRegex, caseSensitive, regexError]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      },
      isFocused: () => document.activeElement === inputRef.current,
      focusWithReplace: () => {
        // Replace row is always visible now (no accordion). Behave like
        // plain `focus` so Ctrl+Shift+H still puts the caret on the search
        // input.
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      },
    }),
    [],
  );

  const { rows, hitCount, fileCount, allCollapsed } = useMemo(() => {
    const groups = new Map<string, { path: string; hits: GrepHit[] }>();
    for (const h of hits) {
      const g = groups.get(h.rel);
      if (g) g.hits.push(h);
      else groups.set(h.rel, { path: h.path, hits: [h] });
    }
    const out: Row[] = [];
    let hitIdx = 0;
    let allClosed = groups.size > 0;
    for (const [rel, g] of groups) {
      const isCollapsed = collapsed.has(rel);
      if (!isCollapsed) allClosed = false;
      out.push({ kind: "file", rel, path: g.path, count: g.hits.length });
      if (isCollapsed) continue;
      for (const h of g.hits) {
        out.push({ kind: "hit", hit: h, hitIdx });
        hitIdx++;
      }
    }
    return {
      rows: out,
      hitCount: hitIdx,
      fileCount: groups.size,
      allCollapsed: allClosed,
    };
  }, [hits, collapsed]);

  const clampedActive = useMemo(() => {
    if (hitCount === 0) return 0;
    return Math.min(Math.max(0, activeHitIdx), hitCount - 1);
  }, [activeHitIdx, hitCount]);

  useEffect(() => {
    if (hitCount === 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-hit-idx="${clampedActive}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [clampedActive, hitCount]);

  const openHit = (h: GrepHit) => onOpenFile(h.path);

  const toggleGroup = (rel: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  };

  const toggleAllGroups = () => {
    if (allCollapsed) {
      setCollapsed(new Set());
    } else {
      const all = new Set<string>();
      for (const h of hits) all.add(h.rel);
      setCollapsed(all);
    }
  };

  /**
   * Two-step replace gate. First call arms the action and returns without
   * writing; the UI shows an inline "press Enter again to confirm" banner.
   * The second call (next Enter / button click) actually invokes the
   * backend. Any change to inputs/options between the two clears the arm.
   */
  const requestReplaceAll = () => {
    const q = query.trim();
    if (!q || replacing) return;
    if (useRegex && regexError) return;
    if (hits.length === 0) return;
    if (!replaceArmed) {
      setReplaceArmed(true);
      return;
    }
    setReplaceArmed(false);
    void runReplaceAll();
  };

  const runReplaceAll = async () => {
    const q = query.trim();
    if (!q || replacing) return;
    if (useRegex && regexError) return;
    if (hits.length === 0) return;
    setReplacing(true);
    try {
      const resp = await invoke<GrepReplaceResponse>("fs_grep_replace", {
        pattern: useRegex ? q : escapeRegex(q),
        replacement: replaceText,
        root: rootPath,
        caseInsensitive: !caseSensitive,
      });
      // Re-run the search so the panel reflects the post-replace state.
      const refreshed = await invoke<GrepResponse>("fs_grep", {
        pattern: useRegex ? q : escapeRegex(q),
        root: rootPath,
        caseInsensitive: !caseSensitive,
        maxResults: 200,
      });
      setHits(refreshed.hits);
      setTruncated(refreshed.truncated);
      setActiveHitIdx(0);
      console.info(
        `[fs_grep_replace] ${resp.total_replacements} replacement(s) across ${resp.files_changed} file(s)`,
      );
    } catch (e) {
      console.error("fs_grep_replace failed:", e);
      window.alert(`Replace failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setReplacing(false);
    }
  };

  return (
    <div className="@container flex flex-col">
      {open ? (
        <motion.div
          className="relative shrink-0 px-2 py-1.5"
          initial={{ opacity: 0, transform: "translateY(-15px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)" }}
        >
          <div className="flex items-center gap-1">
            <div className="relative flex-1">
              <HugeiconsIcon
                icon={FileSearchIcon}
                size={13}
                strokeWidth={2}
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 -translate-y-1/2"
              />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    onRequestClose();
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    if (hitCount === 0) return;
                    setActiveHitIdx((i) => (i + 1 >= hitCount ? 0 : i + 1));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    if (hitCount === 0) return;
                    setActiveHitIdx((i) => (i - 1 < 0 ? hitCount - 1 : i - 1));
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    let n = 0;
                    for (const r of rows) {
                      if (r.kind === "hit") {
                        if (n === clampedActive) {
                          openHit(r.hit);
                          return;
                        }
                        n++;
                      }
                    }
                  }
                }}
                placeholder={useRegex ? "Regex" : "Find text in files…"}
                className={cn(
                  "h-7 pl-7 text-xs",
                  // Right padding scales with how many toggle buttons are
                  // floating inside the input (clear + Aa + .*).
                  query ? "pr-22" : "pr-15",
                  useRegex && regexError && "border-destructive/60",
                )}
              />
              <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
                {query ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setQuery("")}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive cursor-pointer rounded p-0.5"
                        aria-label="Clear search"
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">Clear</TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setCaseSensitive((v) => !v)}
                      aria-label="Match case"
                      aria-pressed={caseSensitive}
                      className={cn(
                        "cursor-pointer rounded px-1 py-0.5 font-mono text-[10px] transition-colors",
                        caseSensitive
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      Aa
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Match case</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => setUseRegex((v) => !v)}
                      aria-label="Use regular expression"
                      aria-pressed={useRegex}
                      className={cn(
                        "cursor-pointer rounded px-1 py-0.5 font-mono text-[10px] transition-colors",
                        useRegex
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      )}
                    >
                      .*
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Use regular expression</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>
          {useRegex && regexError ? (
            <div className="text-destructive mt-1 pl-7 text-[10px]">{regexError}</div>
          ) : null}

          {/* Replace row: always rendered (no accordion). Two-Enter confirm
              prevents accidental folder-wide writes. */}
          <div className="mt-1.5 flex items-center gap-1">
            <div className="relative flex-1">
              <HugeiconsIcon
                icon={ReplaceIcon}
                size={13}
                strokeWidth={2}
                className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 -translate-y-1/2"
              />
              <Input
                ref={replaceInputRef}
                value={replaceText}
                onChange={(e) => setReplaceText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    if (replaceArmed) {
                      // First Escape disarms without closing the panel.
                      setReplaceArmed(false);
                      return;
                    }
                    onRequestClose();
                    return;
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    requestReplaceAll();
                  }
                }}
                placeholder={useRegex ? "Replace ($1 for groups)" : "Replace"}
                className={cn(
                  "h-7 pr-9 pl-7 text-xs",
                  replaceArmed && "border-icon-working/70 focus-visible:ring-icon-working/40",
                )}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={requestReplaceAll}
                    disabled={
                      replacing || hits.length === 0 || (useRegex && !!regexError) || !active
                    }
                    aria-label={replaceArmed ? "Confirm replace all" : "Replace all"}
                    className={cn(
                      "absolute top-1/2 right-1 -translate-y-1/2 cursor-pointer rounded p-1 transition-colors",
                      replaceArmed
                        ? "bg-icon-working/15 text-icon-working hover:bg-icon-working/25 text-icon-working"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                      "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
                    )}
                  >
                    <HugeiconsIcon icon={ReplaceAllIcon} size={11} strokeWidth={2} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {replacing
                    ? "Replacing…"
                    : hits.length === 0
                      ? "No matches to replace"
                      : replaceArmed
                        ? `Press Enter again to confirm (${hits.length} in ${fileCount})`
                        : `Replace all (${hits.length} in ${fileCount})`}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          {replaceArmed && hits.length > 0 ? (
            <div className="mt-1 text-[10px] text-icon-working">
              Press Enter again to replace {hits.length} match{hits.length === 1 ? "" : "es"} in{" "}
              {fileCount} file{fileCount === 1 ? "" : "s"}. Esc to cancel.
            </div>
          ) : null}
        </motion.div>
      ) : null}

      {active ? (
        <>
          {fileCount > 0 ? (
            <div className="border-border/40 text-muted-foreground flex h-6 shrink-0 items-center justify-between gap-2 border-b px-2 text-[10px]">
              <span className="min-w-0 truncate">
                {hits.length} {hits.length === 1 ? "result" : "results"} in {fileCount}{" "}
                {fileCount === 1 ? "file" : "files"}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={toggleAllGroups}
                    className="hover:bg-accent hover:text-accent-foreground flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 py-0.5"
                    aria-label={allCollapsed ? "Expand all" : "Collapse all"}
                  >
                    <HugeiconsIcon
                      icon={allCollapsed ? UnfoldMoreIcon : UnfoldLessIcon}
                      size={11}
                      strokeWidth={2}
                    />
                    <span className="hidden @[180px]:inline">
                      {allCollapsed ? "Expand all" : "Collapse all"}
                    </span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {allCollapsed ? "Expand all" : "Collapse all"}
                </TooltipContent>
              </Tooltip>
            </div>
          ) : null}
          <ScrollArea className="min-h-0 flex-1">
            <div className="w-full py-1" ref={listRef}>
              {searching && hits.length === 0 ? (
                <div className="text-muted-foreground px-3 py-2 text-[11px]">Searching…</div>
              ) : hits.length === 0 ? (
                <div className="text-muted-foreground px-3 py-2 text-[11px]">No matches</div>
              ) : (
                <>
                  {rows.map((r, idx) => {
                    if (r.kind === "file") {
                      const name = basename(r.rel);
                      const url = fileIconUrl(name);
                      const isCollapsed = collapsed.has(r.rel);
                      return (
                        <Tooltip key={`f-${r.rel}-${idx}`}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => toggleGroup(r.rel)}
                              className="text-muted-foreground hover:bg-accent/40 flex w-full min-w-0 cursor-pointer items-center gap-1 px-2 py-1 text-left text-[11px]"
                              aria-expanded={!isCollapsed}
                            >
                              <HugeiconsIcon
                                icon={isCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                                size={11}
                                strokeWidth={2}
                                className="shrink-0"
                              />
                              {url ? <img src={url} alt="" className="size-3.5 shrink-0" /> : null}
                              <span className="text-foreground/80 shrink truncate">{name}</span>
                              <span className="hidden min-w-0 shrink truncate text-[10px] opacity-70 @[200px]:inline">
                                {r.rel}
                              </span>
                              <span className="bg-muted ml-auto shrink-0 rounded px-1 text-[10px] tabular-nums opacity-80">
                                {r.count}
                              </span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right">{r.rel}</TooltipContent>
                        </Tooltip>
                      );
                    }
                    const isActive = r.hitIdx === clampedActive;
                    return (
                      <Tooltip key={`h-${r.hit.path}-${r.hit.line}-${idx}`}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            data-hit-idx={r.hitIdx}
                            onMouseEnter={() => setActiveHitIdx(r.hitIdx)}
                            onClick={() => openHit(r.hit)}
                            className={cn(
                              "flex w-full cursor-pointer items-start gap-2 px-2 py-0.5 pl-7 text-left text-xs",
                              isActive
                                ? "bg-accent text-accent-foreground"
                                : "hover:bg-accent/60",
                            )}
                          >
                            <span className="text-muted-foreground w-8 shrink-0 pt-[1px] text-right text-[10px] leading-relaxed tabular-nums">
                              {r.hit.line}
                            </span>
                            <span className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
                              <HighlightLine
                                text={r.hit.text}
                                needle={query.trim()}
                                useRegex={useRegex}
                                caseInsensitive={!caseSensitive}
                              />
                            </span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right">{`${r.hit.rel}:${r.hit.line}`}</TooltipContent>
                      </Tooltip>
                    );
                  })}
                  {truncated ? (
                    <div className="text-muted-foreground px-3 py-2 text-[10px] italic">
                      Showing first 200 matches. Refine your query for more.
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </ScrollArea>
        </>
      ) : null}
    </div>
  );
});
