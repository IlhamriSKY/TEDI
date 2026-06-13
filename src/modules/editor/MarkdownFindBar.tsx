import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";

export type MarkdownFindBarHandle = {
  /** Open the in-pane overlay. `initialQuery` seeds the find input. */
  open: (opts?: { initialQuery?: string }) => void;
  close: () => void;
  isOpen: () => boolean;
  /** Header search-box entry points: drive the same highlight engine without
   *  showing the in-pane overlay, so Ctrl+F works in markdown preview too. */
  setQuery: (q: string) => void;
  findNext: () => void;
  findPrevious: () => void;
  clearQuery: () => void;
};

type Props = {
  /** Returns the scrollable preview container whose rendered text is searched.
   *  May be null before the preview mounts. The bar itself must live OUTSIDE
   *  this element so its own UI text isn't matched. */
  getContainer: () => HTMLElement | null;
  /** Live markdown source. Re-runs the search when the rendered output changes. */
  content: string;
  ref?: Ref<MarkdownFindBarHandle>;
};

// Registry keys for the CSS Custom Highlight API (see globals.css).
const HL_ALL = "md-find";
const HL_CURRENT = "md-find-current";

// Cap match collection so a query like "a" on a huge doc can't freeze the UI.
const MAX_MATCH_COUNT = 999;

function highlightRegistry(): HighlightRegistry | null {
  if (typeof CSS === "undefined") return null;
  return CSS.highlights ?? null;
}

function clearHighlights(): void {
  const reg = highlightRegistry();
  if (!reg) return;
  reg.delete(HL_ALL);
  reg.delete(HL_CURRENT);
}

/** Concatenated text of the container plus a per-text-node offset map, so a
 *  match that straddles element boundaries (e.g. "foo **bar**") maps back to
 *  real DOM Ranges. `starts[i]` is `nodes[i]`'s offset in `text`. */
type TextMap = { text: string; nodes: Text[]; starts: number[] };

function collectText(root: HTMLElement): TextMap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === "SCRIPT" || tag === "STYLE") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "";
  const nodes: Text[] = [];
  const starts: number[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    if (t.data.length === 0) continue;
    nodes.push(t);
    starts.push(text.length);
    text += t.data;
  }
  return { text, nodes, starts };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatcher(
  query: string,
  opts: { caseSensitive: boolean; useRegex: boolean; wholeWord: boolean },
): RegExp | null {
  if (!query) return null;
  let source = opts.useRegex ? query : escapeRegExp(query);
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;
  try {
    return new RegExp(source, opts.caseSensitive ? "g" : "gi");
  } catch {
    // Invalid user-typed regex — treat as "no matches" rather than throwing.
    return null;
  }
}

/** Largest node index whose start offset is <= `offset` (binary search). */
function nodeIndexAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= offset) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function mapToRange(map: TextMap, start: number, end: number): Range | null {
  const { nodes, starts } = map;
  if (nodes.length === 0) return null;
  const si = nodeIndexAt(starts, start);
  const ei = nodeIndexAt(starts, end - 1);
  const startOffset = start - starts[si];
  const endOffset = end - starts[ei];
  if (startOffset < 0 || startOffset > nodes[si].length) return null;
  if (endOffset < 0 || endOffset > nodes[ei].length) return null;
  try {
    const range = document.createRange();
    range.setStart(nodes[si], startOffset);
    range.setEnd(nodes[ei], endOffset);
    return range;
  } catch {
    return null;
  }
}

function findRanges(map: TextMap, re: RegExp): Range[] {
  const ranges: Range[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(map.text)) !== null) {
    if (m[0].length === 0) {
      // Guard against zero-width matches (e.g. a bare `a*` regex) spinning.
      re.lastIndex += 1;
      continue;
    }
    const range = mapToRange(map, m.index, m.index + m[0].length);
    if (range) ranges.push(range);
    if (ranges.length >= MAX_MATCH_COUNT) break;
  }
  return ranges;
}

function scrollRangeIntoView(container: HTMLElement | null, range: Range): void {
  if (!container) return;
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  const cRect = container.getBoundingClientRect();
  // Only scroll when the match sits outside the comfortable viewport band.
  if (rect.top >= cRect.top + 8 && rect.bottom <= cRect.bottom - 8) return;
  const target =
    container.scrollTop + (rect.top - cRect.top) - container.clientHeight / 2 + rect.height / 2;
  container.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
}

export function MarkdownFindBar({ getContainer, content, ref }: Props) {
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matchCount, setMatchCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const rangesRef = useRef<Range[]>([]);
  // Keep getContainer reachable from stable callbacks without re-subscribing.
  const getContainerRef = useRef(getContainer);
  getContainerRef.current = getContainer;

  // Focus + highlight a match by index (wraps around). Reads ranges from the
  // ref so navigation never depends on a recompute.
  const focusMatch = useCallback((index: number) => {
    const ranges = rangesRef.current;
    const reg = highlightRegistry();
    if (ranges.length === 0) {
      setCurrentIndex(-1);
      reg?.delete(HL_CURRENT);
      return;
    }
    const clamped = ((index % ranges.length) + ranges.length) % ranges.length;
    setCurrentIndex(clamped);
    const range = ranges[clamped];
    if (reg) reg.set(HL_CURRENT, new Highlight(range));
    scrollRangeIntoView(getContainerRef.current(), range);
  }, []);

  // Recompute matches whenever the query, options, or rendered content change.
  // Not gated on `visible`: the header search box drives the same engine while
  // the in-pane overlay stays closed.
  useEffect(() => {
    const container = getContainer();
    const re = container ? buildMatcher(query, { caseSensitive, useRegex, wholeWord }) : null;
    const reg = highlightRegistry();
    if (!container || !re) {
      rangesRef.current = [];
      reg?.delete(HL_ALL);
      reg?.delete(HL_CURRENT);
      setMatchCount(0);
      setCurrentIndex(-1);
      return;
    }
    const ranges = findRanges(collectText(container), re);
    rangesRef.current = ranges;
    setMatchCount(ranges.length);
    if (reg) {
      if (ranges.length) reg.set(HL_ALL, new Highlight(...ranges));
      else reg.delete(HL_ALL);
    }
    focusMatch(0);
  }, [query, caseSensitive, useRegex, wholeWord, content, getContainer, focusMatch]);

  // Drop highlights when the preview is toggled off or the pane is closed.
  useEffect(() => () => clearHighlights(), []);

  const goNext = useCallback(() => focusMatch(currentIndex + 1), [focusMatch, currentIndex]);
  const goPrev = useCallback(() => focusMatch(currentIndex - 1), [focusMatch, currentIndex]);

  const close = useCallback(() => {
    setVisible(false);
    setQuery("");
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      open: (opts) => {
        setVisible(true);
        if (typeof opts?.initialQuery === "string") setQuery(opts.initialQuery);
        // Focus on the next frame so the input is mounted.
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      },
      close,
      isOpen: () => visible,
      setQuery: (q) => setQuery(q),
      findNext: goNext,
      findPrevious: goPrev,
      clearQuery: () => setQuery(""),
    }),
    [visible, close, goNext, goPrev],
  );

  if (!visible) return null;

  const noMatches = query.length > 0 && matchCount === 0;

  return (
    <div
      className={cn(
        "absolute top-1 right-4 z-20 flex items-center gap-1 rounded-md border p-1 shadow-md",
        "bg-popover/95 text-popover-foreground backdrop-blur-sm",
        "border-border w-[360px] max-w-[calc(100%-2rem)]",
      )}
      // Keep the global key shortcuts (and CodeMirror behind the preview) from
      // grabbing keys the inputs need (e.g. Ctrl+A to select the find text).
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div className="relative flex-1">
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.shiftKey) goPrev();
              else goNext();
            }
          }}
          placeholder="Find in preview"
          className={cn("h-7 pr-22 pl-2 text-xs", noMatches && "border-destructive/60")}
        />
        <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
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
                onClick={() => setWholeWord((v) => !v)}
                aria-label="Whole word"
                aria-pressed={wholeWord}
                className={cn(
                  "cursor-pointer rounded px-1 py-0.5 font-mono text-[10px] transition-colors",
                  wholeWord
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                ab
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Whole word</TooltipContent>
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

      <div
        className={cn(
          "shrink-0 px-1 font-mono text-[10px] tabular-nums",
          noMatches ? "text-destructive" : "text-muted-foreground",
        )}
        aria-live="polite"
      >
        {query.length === 0
          ? ""
          : matchCount === 0
            ? "0/0"
            : `${currentIndex + 1}/${matchCount >= MAX_MATCH_COUNT ? `${MAX_MATCH_COUNT}+` : matchCount}`}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={goPrev}
            disabled={matchCount === 0}
            aria-label="Previous match"
            className={cn(
              "shrink-0 cursor-pointer rounded p-1 transition-colors",
              "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
            )}
          >
            <HugeiconsIcon icon={ArrowUp01Icon} size={11} strokeWidth={2} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Previous match (Shift+Enter)</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={goNext}
            disabled={matchCount === 0}
            aria-label="Next match"
            className={cn(
              "shrink-0 cursor-pointer rounded p-1 transition-colors",
              "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
            )}
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={11} strokeWidth={2} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Next match (Enter)</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0 cursor-pointer rounded p-1"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Close (Esc)</TooltipContent>
      </Tooltip>
    </div>
  );
}
