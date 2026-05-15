import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  Cancel01Icon,
  Folder01Icon,
  Search01Icon,
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

type SearchHit = {
  path: string;
  rel: string;
  name: string;
  is_dir: boolean;
  score: number;
  /** Byte indices in `name` that matched the fuzzy query. */
  name_match: number[];
};

type Props = {
  rootPath: string;
  onOpenFile: (path: string) => void;
  open: boolean;
  onRequestClose: () => void;
  onActiveChange?: (active: boolean) => void;
};

export type ExplorerSearchHandle = {
  focus: () => void;
  isFocused: () => boolean;
};

const HIGHLIGHT_CLASS =
  "text-foreground font-semibold underline decoration-foreground/40 underline-offset-2";

/**
 * Renders `text` with the byte-offset positions in `matches` (from the Rust
 * backend's UTF-8 fuzzy scorer) wrapped in a highlighted span. Walks the
 * source codepoint-by-codepoint so multi-byte characters (e.g. emoji,
 * accents) and surrogate pairs land on the right UTF-16 indices.
 *
 * The output coalesces adjacent matched codepoints into a single span to
 * keep the DOM lean for typical short filenames.
 */
function Highlighted({
  text,
  matches,
  fallbackQuery,
}: {
  text: string;
  matches: number[];
  fallbackQuery: string;
}) {
  if (matches.length > 0) {
    const encoder = new TextEncoder();
    const matchedBytes = new Set(matches);
    // Each entry: { ch: rendered substring (handles surrogate pairs), hit }.
    const cells: { ch: string; hit: boolean }[] = [];
    let byteIdx = 0;
    for (const cp of text) {
      // cp is a single Unicode codepoint; on the JS side it may be 1 or 2
      // UTF-16 code units (surrogate pair). Render it as-is.
      cells.push({ ch: cp, hit: matchedBytes.has(byteIdx) });
      byteIdx += encoder.encode(cp).length;
    }
    // Coalesce runs of same `hit` into one span each.
    const out: React.ReactNode[] = [];
    let i = 0;
    while (i < cells.length) {
      const hit = cells[i].hit;
      let j = i;
      let buf = "";
      while (j < cells.length && cells[j].hit === hit) {
        buf += cells[j].ch;
        j++;
      }
      out.push(
        hit ? (
          <span key={i} className={HIGHLIGHT_CLASS}>
            {buf}
          </span>
        ) : (
          <span key={i}>{buf}</span>
        ),
      );
      i = j;
    }
    return <>{out}</>;
  }

  // Fallback: case-insensitive substring highlight for the path column when
  // the backend's per-name match indices don't apply.
  const q = fallbackQuery.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className={HIGHLIGHT_CLASS}>{text.slice(idx, idx + q.length)}</span>
      {text.slice(idx + q.length)}
    </>
  );
}

export const ExplorerSearch = forwardRef<ExplorerSearchHandle, Props>(function ExplorerSearch({
  rootPath,
  onOpenFile,
  open,
  onRequestClose,
  onActiveChange,
}: Props,
  ref,
) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const showHiddenFiles = usePreferencesStore((s) => s.showHiddenFiles);

  const active = query.trim().length > 0;

  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      setQuery("");
      setResults([]);
      setSearching(false);
      setActiveIdx(0);
    }
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      setActiveIdx(0);
      return;
    }
    setSearching(true);
    let alive = true;
    const handle = setTimeout(async () => {
      try {
        const hits = await invoke<SearchHit[]>("fs_search", {
          root: rootPath,
          query: q,
          limit: 200,
          includeHidden: showHiddenFiles,
        });
        if (alive) {
          setResults(hits);
          setActiveIdx(0);
        }
      } catch (e) {
        if (alive) {
          console.error("fs_search failed:", e);
          setResults([]);
          setActiveIdx(0);
        }
      } finally {
        if (alive) setSearching(false);
      }
    }, 120);

    return () => {
      alive = false;
      clearTimeout(handle);
    };
  }, [query, rootPath, showHiddenFiles]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        requestAnimationFrame(() => {
          inputRef.current?.focus();
        });
      },
      isFocused: () => document.activeElement === inputRef.current,
    }),
    [],
  );

  const clampedActive = useMemo(() => {
    if (results.length === 0) return 0;
    return Math.min(activeIdx, results.length - 1);
  }, [activeIdx, results.length]);

  // Keep the active row in view when navigating with arrow keys.
  useEffect(() => {
    if (results.length === 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-result-idx="${clampedActive}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [clampedActive, results.length]);

  const openHit = (hit: SearchHit) => {
    if (hit.is_dir) return;
    onOpenFile(hit.path);
  };

  return (
    <div className="flex flex-col">
      {open ? (
        <motion.div
          className="relative shrink-0 px-2 py-1.5"
          initial={{ opacity: 0, transform: "translateY(-15px)" }}
          animate={{ opacity: 1, transform: "translateY(0px)" }}
        >
          <HugeiconsIcon
            icon={Search01Icon}
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
                if (results.length === 0) return;
                setActiveIdx((i) =>
                  i + 1 >= results.length ? 0 : i + 1,
                );
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                if (results.length === 0) return;
                setActiveIdx((i) =>
                  i - 1 < 0 ? results.length - 1 : i - 1,
                );
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                const target = results[clampedActive];
                if (target && !target.is_dir) openHit(target);
              }
            }}
            placeholder="Go to file by name…"
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
        <ScrollArea className="min-h-0 flex-1">
          <div className="py-1" ref={listRef}>
            {searching && results.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                Searching…
              </div>
            ) : results.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-muted-foreground">
                No matches
              </div>
            ) : (
              results.map((hit, index) => {
                const url = hit.is_dir ? null : fileIconUrl(hit.name);
                const isActive = index === clampedActive;
                return (
                  <button
                    key={hit.path}
                    type="button"
                    data-result-idx={index}
                    onMouseEnter={() => setActiveIdx(index)}
                    onClick={() => openHit(hit)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left text-xs",
                      isActive
                        ? "bg-accent text-foreground"
                        : "hover:bg-accent/60",
                    )}
                    title={hit.path}
                  >
                    {url ? (
                      <img src={url} alt="" className="size-3.5 shrink-0" />
                    ) : (
                      <HugeiconsIcon
                        icon={Folder01Icon}
                        size={13}
                        strokeWidth={1.75}
                        className="shrink-0 text-muted-foreground"
                      />
                    )}
                    <span className="truncate">
                      <Highlighted
                        text={hit.name}
                        matches={hit.name_match ?? []}
                        fallbackQuery={query}
                      />
                    </span>
                    <span className="ml-auto truncate text-[10px] text-muted-foreground">
                      <Highlighted
                        text={hit.rel}
                        matches={[]}
                        fallbackQuery={query}
                      />
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>
      ) : null}
    </div>
  );
});
