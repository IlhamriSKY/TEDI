import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ChevronDown, ChevronsDownUp, ChevronsUpDown, ChevronUp } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { requestReveal } from "@/modules/editor/lib/reveal";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { GrepFileRow } from "./components/GrepFileRow";
import { GrepHitRow } from "./components/GrepHitRow";
import { GrepSearchBar } from "./components/GrepSearchBar";
import {
  escapeRegex,
  tryCompileRegex,
  type GrepHit,
  type GrepReplaceResponse,
  type GrepResponse,
  type Row,
} from "./components/grepUtils";

type Props = {
  rootPath: string;
  onOpenFile: (path: string) => void;
  open: boolean;
  onRequestClose: () => void;
  onActiveChange?: (active: boolean) => void;
  ref?: Ref<ExplorerGrepHandle>;
};

export type ExplorerGrepHandle = {
  focus: () => void;
  isFocused: () => boolean;
  /** Expand the replace row + focus the search input. Used by Ctrl+Shift+H. */
  focusWithReplace: () => void;
};

export function ExplorerGrep({
  rootPath,
  onOpenFile,
  open,
  onRequestClose,
  onActiveChange,
  ref,
}: Props) {
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

  const openHit = (h: GrepHit) => {
    // Ask the editor to jump to + highlight this exact line/match, then open
    // the file. Order is safe either way: the target is keyed by path and the
    // EditorPane consumes it once mounted (new file) or immediately (already open).
    requestReveal(h.path, {
      line: h.line,
      needle: query.trim(),
      useRegex,
      caseInsensitive: !caseSensitive,
    });
    onOpenFile(h.path);
  };

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
      toast(`Replace failed: ${e instanceof Error ? e.message : String(e)}`, { variant: "error" });
    } finally {
      setReplacing(false);
    }
  };

  const patternForBackend = () => {
    const q = query.trim();
    return useRegex ? q : escapeRegex(q);
  };

  // Replace every match on a single hit's line (VS Code's per-match "Replace").
  // Grep hits are per-line, so this rewrites that one line only. Optimistically
  // drops the row; ponytail: if the replacement itself still matches the
  // pattern the row would re-surface on the next search, rare enough to accept
  // over a full re-grep after every single replace.
  const replaceHit = async (hit: GrepHit) => {
    const q = query.trim();
    if (!q || replacing) return;
    if (useRegex && regexError) return;
    try {
      const n = await invoke<number>("fs_replace_in_file", {
        path: hit.path,
        pattern: patternForBackend(),
        replacement: replaceText,
        line: hit.line,
        caseInsensitive: !caseSensitive,
      });
      if (n > 0) {
        setHits((prev) => prev.filter((h) => !(h.path === hit.path && h.line === hit.line)));
      }
    } catch (e) {
      console.error("fs_replace_in_file (hit) failed:", e);
      toast(`Replace failed: ${e instanceof Error ? e.message : String(e)}`, { variant: "error" });
    }
  };

  // Replace all matches within one file (VS Code's per-file "Replace All").
  const replaceFile = async (path: string) => {
    const q = query.trim();
    if (!q || replacing) return;
    if (useRegex && regexError) return;
    try {
      const n = await invoke<number>("fs_replace_in_file", {
        path,
        pattern: patternForBackend(),
        replacement: replaceText,
        line: null,
        caseInsensitive: !caseSensitive,
      });
      if (n > 0) {
        setHits((prev) => prev.filter((h) => h.path !== path));
      }
    } catch (e) {
      console.error("fs_replace_in_file (file) failed:", e);
      toast(`Replace failed: ${e instanceof Error ? e.message : String(e)}`, { variant: "error" });
    }
  };

  const gotoHit = (delta: 1 | -1) => {
    if (hitCount === 0) return;
    setActiveHitIdx((i) => {
      const next = i + delta;
      if (next >= hitCount) return 0;
      if (next < 0) return hitCount - 1;
      return next;
    });
  };

  return (
    // When results are showing, fill the remaining height of the explorer
    // column so the inner `min-h-0 flex-1` ScrollArea has a bounded box to
    // scroll within. Hug-height while inactive so the tree layout is untouched.
    <div className={cn("@container flex flex-col", active && "min-h-0 flex-1")}>
      {open ? (
        <GrepSearchBar
          inputRef={inputRef}
          replaceInputRef={replaceInputRef}
          query={query}
          setQuery={setQuery}
          useRegex={useRegex}
          setUseRegex={setUseRegex}
          regexError={regexError}
          caseSensitive={caseSensitive}
          setCaseSensitive={setCaseSensitive}
          replaceText={replaceText}
          setReplaceText={setReplaceText}
          replaceArmed={replaceArmed}
          setReplaceArmed={setReplaceArmed}
          replacing={replacing}
          hits={hits}
          active={active}
          fileCount={fileCount}
          hitCount={hitCount}
          clampedActive={clampedActive}
          rows={rows}
          setActiveHitIdx={setActiveHitIdx}
          onRequestClose={onRequestClose}
          openHit={openHit}
          requestReplaceAll={requestReplaceAll}
        />
      ) : null}

      {active ? (
        <>
          {fileCount > 0 ? (
            <div className="border-border/40 text-muted-foreground flex h-6 shrink-0 items-center justify-between gap-2 border-b px-2 text-[10px]">
              <span className="min-w-0 truncate">
                {hitCount > 0 ? (
                  <span className="text-foreground/80 tabular-nums">
                    {clampedActive + 1} of {hitCount}
                    <span className="opacity-50"> · </span>
                  </span>
                ) : null}
                {hits.length} {hits.length === 1 ? "result" : "results"} in {fileCount}{" "}
                {fileCount === 1 ? "file" : "files"}
              </span>
              <div className="flex shrink-0 items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => gotoHit(-1)}
                      disabled={hitCount === 0}
                      aria-label="Previous match"
                      className="hover:bg-accent hover:text-accent-foreground cursor-pointer rounded p-0.5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <ChevronUp size={11} strokeWidth={2} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Previous match (↑)</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => gotoHit(1)}
                      disabled={hitCount === 0}
                      aria-label="Next match"
                      className="hover:bg-accent hover:text-accent-foreground cursor-pointer rounded p-0.5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <ChevronDown size={11} strokeWidth={2} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Next match (↓)</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={toggleAllGroups}
                      className="hover:bg-accent hover:text-accent-foreground flex cursor-pointer items-center gap-1 rounded px-1 py-0.5"
                      aria-label={allCollapsed ? "Expand all" : "Collapse all"}
                    >
                      {allCollapsed ? (
                        <ChevronsUpDown size={11} strokeWidth={2} />
                      ) : (
                        <ChevronsDownUp size={11} strokeWidth={2} />
                      )}
                      <span className="hidden @[220px]:inline">
                        {allCollapsed ? "Expand all" : "Collapse all"}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {allCollapsed ? "Expand all" : "Collapse all"}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          ) : null}
          <ScrollArea className="min-h-0 flex-1">
            {/* pr-2.5 reserves the 10px Radix ScrollArea overlay-thumb width so the
                per-row Replace buttons and file match-count badge clear the scrollbar. */}
            <div className="w-full py-1 pr-2.5" ref={listRef}>
              {searching && hits.length === 0 ? (
                <div className="text-muted-foreground px-3 py-2 text-[11px]">Searching…</div>
              ) : hits.length === 0 ? (
                <div className="text-muted-foreground px-3 py-2 text-[11px]">No matches</div>
              ) : (
                <>
                  {rows.map((r, idx) => {
                    // Replace actions are offered only while the query is
                    // replaceable (no pending regex error). Passing `undefined`
                    // hides the per-row button rather than showing a dead one.
                    const canReplace = !(useRegex && !!regexError);
                    if (r.kind === "file") {
                      const isCollapsed = collapsed.has(r.rel);
                      return (
                        <GrepFileRow
                          key={`f-${r.rel}-${idx}`}
                          rel={r.rel}
                          count={r.count}
                          isCollapsed={isCollapsed}
                          onToggle={() => toggleGroup(r.rel)}
                          onReplaceFile={canReplace ? () => replaceFile(r.path) : undefined}
                        />
                      );
                    }
                    const isActive = r.hitIdx === clampedActive;
                    return (
                      <GrepHitRow
                        key={`h-${r.hit.path}-${r.hit.line}-${r.hitIdx}`}
                        hit={r.hit}
                        hitIdx={r.hitIdx}
                        isActive={isActive}
                        needle={query.trim()}
                        useRegex={useRegex}
                        caseInsensitive={!caseSensitive}
                        onMouseEnter={() => setActiveHitIdx(r.hitIdx)}
                        onClick={() => openHit(r.hit)}
                        onReplace={canReplace ? () => replaceHit(r.hit) : undefined}
                      />
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
}
