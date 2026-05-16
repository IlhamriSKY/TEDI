import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  FileSearchIcon,
  UnfoldLessIcon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
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
};

const HIGHLIGHT_CLASS =
  "bg-amber-400/30 text-foreground rounded-[2px] px-[1px]";

const MAX_LINE_CHARS = 240;

/** Escape user input so it's treated as a literal substring, not regex. */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function HighlightLine({ text, needle }: { text: string; needle: string }) {
  const trimmed =
    text.length > MAX_LINE_CHARS ? text.slice(0, MAX_LINE_CHARS) + "…" : text;
  if (!needle) return <>{trimmed}</>;
  const lowerHay = trimmed.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < trimmed.length) {
    const idx = lowerHay.indexOf(lowerNeedle, i);
    if (idx < 0) {
      out.push(trimmed.slice(i));
      break;
    }
    if (idx > i) out.push(trimmed.slice(i, idx));
    out.push(
      <span key={k++} className={HIGHLIGHT_CLASS}>
        {trimmed.slice(idx, idx + needle.length)}
      </span>,
    );
    i = idx + needle.length;
  }
  return <>{out}</>;
}

type Row =
  | { kind: "file"; rel: string; path: string; count: number }
  | { kind: "hit"; hit: GrepHit; hitIdx: number };

export const ExplorerGrep = forwardRef<ExplorerGrepHandle, Props>(
  function ExplorerGrep(
    { rootPath, onOpenFile, open, onRequestClose, onActiveChange }: Props,
    ref,
  ) {
    const [query, setQuery] = useState("");
    const [hits, setHits] = useState<GrepHit[]>([]);
    const [truncated, setTruncated] = useState(false);
    const [searching, setSearching] = useState(false);
    const [activeHitIdx, setActiveHitIdx] = useState(0);
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const inputRef = useRef<HTMLInputElement>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const active = query.trim().length > 0;

    useEffect(() => {
      onActiveChange?.(active);
    }, [active, onActiveChange]);

    useEffect(() => {
      if (open) {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        setQuery("");
        setHits([]);
        setTruncated(false);
        setSearching(false);
        setActiveHitIdx(0);
        setCollapsed(new Set());
      }
    }, [open]);

    useEffect(() => {
      const q = query.trim();
      if (!q) {
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
            pattern: escapeRegex(q),
            root: rootPath,
            caseInsensitive: true,
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
    }, [query, rootPath]);

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
      }),
      [],
    );

    const { rows, hitCount, fileCount, allCollapsed } = useMemo(() => {
      // Group by file (rel path). Keep file insertion order from backend.
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
      const el = listRef.current?.querySelector<HTMLElement>(
        `[data-hit-idx="${clampedActive}"]`,
      );
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

    return (
      <div className="@container flex flex-col">
        {open ? (
          <motion.div
            className="relative shrink-0 px-2 py-1.5"
            initial={{ opacity: 0, transform: "translateY(-15px)" }}
            animate={{ opacity: 1, transform: "translateY(0px)" }}
          >
            <HugeiconsIcon
              icon={FileSearchIcon}
              size={13}
              strokeWidth={2}
              className="absolute top-1/2 left-4 -translate-y-1/2 text-muted-foreground"
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
              placeholder="Find text in files…"
              className="h-7 pr-7 pl-6.5 text-xs"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute top-1/2 right-3.5 -translate-y-1/2 cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                aria-label="Clear search"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
              </button>
            ) : null}
          </motion.div>
        ) : null}

        {active ? (
          <>
            {fileCount > 0 ? (
              <div className="flex h-6 shrink-0 items-center justify-between gap-2 border-b border-border/40 px-2 text-[10px] text-muted-foreground">
                <span className="min-w-0 truncate">
                  {hits.length} {hits.length === 1 ? "result" : "results"} in{" "}
                  {fileCount} {fileCount === 1 ? "file" : "files"}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={toggleAllGroups}
                      className="flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
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
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    Searching…
                  </div>
                ) : hits.length === 0 ? (
                  <div className="px-3 py-2 text-[11px] text-muted-foreground">
                    No matches
                  </div>
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
                                className="flex w-full min-w-0 cursor-pointer items-center gap-1 px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent/40"
                                aria-expanded={!isCollapsed}
                              >
                                <HugeiconsIcon
                                  icon={
                                    isCollapsed ? ArrowRight01Icon : ArrowDown01Icon
                                  }
                                  size={11}
                                  strokeWidth={2}
                                  className="shrink-0"
                                />
                                {url ? (
                                  <img
                                    src={url}
                                    alt=""
                                    className="size-3.5 shrink-0"
                                  />
                                ) : null}
                                <span className="shrink truncate text-foreground/80">
                                  {name}
                                </span>
                                <span className="hidden min-w-0 shrink truncate text-[10px] opacity-70 @[200px]:inline">
                                  {r.rel}
                                </span>
                                <span className="ml-auto shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums opacity-80">
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
                                ? "bg-accent text-foreground"
                                : "hover:bg-accent/60",
                            )}
                          >
                            <span className="w-8 shrink-0 pt-[1px] text-right text-[10px] leading-relaxed text-muted-foreground tabular-nums">
                              {r.hit.line}
                            </span>
                            <span className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
                              <HighlightLine
                                text={r.hit.text}
                                needle={query.trim()}
                              />
                            </span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          {`${r.hit.rel}:${r.hit.line}`}
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                  {truncated ? (
                    <div className="px-3 py-2 text-[10px] text-muted-foreground italic">
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
  },
);
