import {
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SearchOptionToggle } from "@/components/ui/search-option-toggle";
import { cn } from "@/lib/utils";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { ChevronDown, ChevronUp, Replace, ReplaceAll, X } from "lucide-react";

export type EditorFindReplaceHandle = {
  /** Open the bar. Both rows are always rendered. `initialQuery` seeds
   *  the find input. */
  open: (opts?: { initialQuery?: string }) => void;
  close: () => void;
  isOpen: () => boolean;
};

type Props = {
  /** Live CodeMirror view. May be null while the editor is loading or
   *  showing an image/binary placeholder. */
  getView: () => EditorView | null;
  ref?: Ref<EditorFindReplaceHandle>;
};

// Cap match counting so a query like "a" on a huge file doesn't freeze the UI.
const MAX_MATCH_COUNT = 999;

type MatchPos = { current: number; total: number };

// VS Code-style "{current} of {total}". `current` is the 1-indexed match that
// the editor's selection currently sits on (0 when the selection isn't on a
// match). Counting stops at MAX_MATCH_COUNT so a huge file never freezes the UI.
function matchState(view: EditorView, query: SearchQuery): MatchPos {
  if (!query.valid) return { current: 0, total: 0 };
  try {
    const cursor = query.getCursor(view.state, 0, view.state.doc.length);
    const sel = view.state.selection.main;
    let total = 0;
    let current = 0;
    while (true) {
      const r = cursor.next();
      if (r.done) break;
      total += 1;
      if (current === 0 && r.value.from === sel.from && r.value.to === sel.to) {
        current = total;
      }
      if (total >= MAX_MATCH_COUNT) break;
    }
    return { current, total };
  } catch {
    return { current: 0, total: 0 };
  }
}

// Move the selection onto the first match at/after `anchor`, wrapping to the
// top if none follows. Lets the position indicator read "1 of N" the moment
// the user types, matching VS Code's incremental find.
function seedFirstMatch(view: EditorView, query: SearchQuery, anchor: number): void {
  if (!query.valid) return;
  try {
    const len = view.state.doc.length;
    const a = Math.min(Math.max(0, anchor), len);
    let cursor = query.getCursor(view.state, a, len);
    let r = cursor.next();
    if (r.done) {
      cursor = query.getCursor(view.state, 0, a);
      r = cursor.next();
    }
    if (!r.done) {
      view.dispatch({
        selection: { anchor: r.value.from, head: r.value.to },
        scrollIntoView: true,
      });
    }
  } catch {
    // ignore
  }
}

export function EditorFindReplace({ getView, ref }: Props) {
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [pos, setPos] = useState<MatchPos>({ current: 0, total: 0 });
  const findInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  // Doc position captured when the bar opens; incremental find always anchors
  // its first-match seed here so typing more characters doesn't drift the
  // starting point around the document.
  const anchorRef = useRef(0);

  // Push the current query to CodeMirror's search state whenever any field
  // changes. CM highlights matches automatically once `setSearchQuery` is
  // dispatched.
  useEffect(() => {
    const view = getView();
    if (!view) return;
    if (!visible || query.length === 0) {
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "" })),
      });
      setPos({ current: 0, total: 0 });
      return;
    }
    const sq = new SearchQuery({
      search: query,
      caseSensitive,
      regexp: useRegex,
      wholeWord,
      replace,
    });
    view.dispatch({ effects: setSearchQuery.of(sq) });
    let st = matchState(view, sq);
    // Selection not on a match yet (fresh query / edited term) but matches
    // exist -> jump to the first one so the indicator shows "1 of N". Guarding
    // on current===0 means a mere Replace-text edit won't re-seed the caret.
    if (st.current === 0 && st.total > 0) {
      seedFirstMatch(view, sq, anchorRef.current);
      st = matchState(view, sq);
    }
    setPos(st);
  }, [visible, query, replace, caseSensitive, useRegex, wholeWord, getView]);

  const refreshPos = () => {
    const view = getView();
    if (!view) return;
    const sq = new SearchQuery({
      search: query,
      caseSensitive,
      regexp: useRegex,
      wholeWord,
      replace,
    });
    setPos(matchState(view, sq));
  };

  useImperativeHandle(
    ref,
    () => ({
      open: (opts) => {
        setVisible(true);
        // Anchor incremental find at wherever the caret was when the bar opened.
        anchorRef.current = getView()?.state.selection.main.head ?? 0;
        if (typeof opts?.initialQuery === "string") setQuery(opts.initialQuery);
        // Focus on next frame so the input is mounted.
        requestAnimationFrame(() => {
          findInputRef.current?.focus();
          findInputRef.current?.select();
        });
      },
      close: () => {
        setVisible(false);
        const view = getView();
        if (view) {
          view.dispatch({
            effects: setSearchQuery.of(new SearchQuery({ search: "" })),
          });
          view.focus();
        }
      },
      isOpen: () => visible,
    }),
    [visible, getView],
  );

  const closeAndFocusEditor = () => {
    setVisible(false);
    const view = getView();
    if (view) {
      view.dispatch({
        effects: setSearchQuery.of(new SearchQuery({ search: "" })),
      });
      view.focus();
    }
  };

  const runFindNext = () => {
    const view = getView();
    if (!view) return;
    findNext(view);
    refreshPos();
  };
  const runFindPrev = () => {
    const view = getView();
    if (!view) return;
    findPrevious(view);
    refreshPos();
  };
  const runReplaceNext = () => {
    const view = getView();
    if (!view) return;
    replaceNext(view);
    refreshPos();
  };
  const runReplaceAll = () => {
    const view = getView();
    if (!view) return;
    replaceAll(view);
    setPos({ current: 0, total: 0 });
  };

  // Position: top-right overlay, VSCode-style. Stays inside the editor
  // pane via the relative container in EditorPane.
  const noMatches = useMemo(() => query.length > 0 && pos.total === 0, [query, pos.total]);

  if (!visible) return null;

  return (
    <div
      className={cn(
        // `right-4` clears the 10px-wide scrollbar marker that lives at
        // right:0 of the editor wrapper.
        "absolute top-1 right-4 z-20 flex flex-col gap-1 rounded-md border p-1 shadow-md",
        "bg-popover/95 text-popover-foreground backdrop-blur-sm",
        "border-border w-[420px] max-w-[calc(100%-2rem)]",
      )}
      // Prevent CM from grabbing arrow-key / Mod-key shortcuts the inputs
      // need (e.g. Ctrl+A to select all the find text).
      onKeyDown={(e) => e.stopPropagation()}
    >
      {/* Find row */}
      <div className="flex items-center gap-1">
        <div className="relative flex-1">
          <Input
            ref={findInputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeAndFocusEditor();
                return;
              }
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) runFindPrev();
                else runFindNext();
              }
            }}
            placeholder="Find"
            className={cn("h-7 pr-22 pl-2 text-xs", noMatches && "border-destructive/60")}
          />
          <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
            <SearchOptionToggle
              label="Aa"
              pressed={caseSensitive}
              onToggle={() => setCaseSensitive((v) => !v)}
              tooltip="Match case"
              ariaLabel="Match case"
            />
            <SearchOptionToggle
              label="ab"
              pressed={wholeWord}
              onToggle={() => setWholeWord((v) => !v)}
              tooltip="Whole word"
              ariaLabel="Whole word"
            />
            <SearchOptionToggle
              label=".*"
              pressed={useRegex}
              onToggle={() => setUseRegex((v) => !v)}
              tooltip="Use regular expression"
              ariaLabel="Use regular expression"
            />
          </div>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={runFindPrev}
              disabled={pos.total === 0}
              aria-label="Previous match"
              className={cn(
                "shrink-0 cursor-pointer rounded p-1 transition-colors",
                "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
              )}
            >
              <ChevronUp size={11} strokeWidth={2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Previous match (Shift+Enter)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={runFindNext}
              disabled={pos.total === 0}
              aria-label="Next match"
              className={cn(
                "shrink-0 cursor-pointer rounded p-1 transition-colors",
                "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
              )}
            >
              <ChevronDown size={11} strokeWidth={2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Next match (Enter)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={closeAndFocusEditor}
              aria-label="Close"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0 cursor-pointer rounded p-1"
            >
              <X size={11} strokeWidth={2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Close (Esc)</TooltipContent>
        </Tooltip>
      </div>

      {/* Replace row (always rendered — no accordion). */}
      <div className="flex items-center gap-1">
        <Input
          ref={replaceInputRef}
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              closeAndFocusEditor();
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              if (e.altKey || e.ctrlKey || e.metaKey) runReplaceAll();
              else runReplaceNext();
            }
          }}
          placeholder="Replace"
          className="h-7 flex-1 pl-2 text-xs"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={runReplaceNext}
              disabled={pos.total === 0}
              aria-label="Replace"
              className={cn(
                "shrink-0 cursor-pointer rounded p-1 transition-colors",
                "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
              )}
            >
              <Replace size={11} strokeWidth={2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Replace next (Enter)</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={runReplaceAll}
              disabled={pos.total === 0}
              aria-label="Replace all"
              className={cn(
                "shrink-0 cursor-pointer rounded p-1 transition-colors",
                "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
              )}
            >
              <ReplaceAll size={11} strokeWidth={2} />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Replace all (Mod+Enter)</TooltipContent>
        </Tooltip>
        {/* Invisible placeholder matching the find row's close (×) button
              slot so both inputs share the same flex-1 width and the
              right-side button columns line up. */}
        <div className="invisible shrink-0 rounded p-1" aria-hidden>
          <X size={11} strokeWidth={2} />
        </div>
      </div>

      {/* Status row: appears only after the user types so the form renders
            full first and the match indicator slides in afterwards. */}
      {query.length > 0 ? (
        <div
          className={cn(
            "px-1 pt-0.5 text-right font-mono text-[10px] tabular-nums",
            noMatches ? "text-destructive" : "text-muted-foreground",
          )}
          aria-live="polite"
        >
          {pos.total === 0
            ? "No results"
            : `${pos.current > 0 ? pos.current : 1} of ${
                pos.total >= MAX_MATCH_COUNT ? `${MAX_MATCH_COUNT}+` : pos.total
              }`}
        </div>
      ) : null}
    </div>
  );
}
