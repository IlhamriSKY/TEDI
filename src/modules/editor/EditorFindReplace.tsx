import { findNext, findPrevious, replaceAll, replaceNext, SearchQuery, setSearchQuery } from "@codemirror/search";
import type { EditorView } from "@codemirror/view";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Cancel01Icon,
  ReplaceAllIcon,
  ReplaceIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";

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

function countMatches(view: EditorView, query: SearchQuery): number {
  if (!query.valid) return 0;
  try {
    const cursor = query.getCursor(view.state, 0, view.state.doc.length);
    let n = 0;
    while (true) {
      const r = cursor.next();
      if (r.done) break;
      n += 1;
      if (n >= MAX_MATCH_COUNT) break;
    }
    return n;
  } catch {
    return 0;
  }
}

export function EditorFindReplace({ getView, ref }: Props) {
    const [visible, setVisible] = useState(false);
    const [query, setQuery] = useState("");
    const [replace, setReplace] = useState("");
    const [caseSensitive, setCaseSensitive] = useState(false);
    const [useRegex, setUseRegex] = useState(false);
    const [wholeWord, setWholeWord] = useState(false);
    const [matchCount, setMatchCount] = useState(0);
    const findInputRef = useRef<HTMLInputElement>(null);
    const replaceInputRef = useRef<HTMLInputElement>(null);

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
        setMatchCount(0);
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
      setMatchCount(countMatches(view, sq));
    }, [visible, query, replace, caseSensitive, useRegex, wholeWord, getView]);

    useImperativeHandle(
      ref,
      () => ({
        open: (opts) => {
          setVisible(true);
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
      if (view) findNext(view);
    };
    const runFindPrev = () => {
      const view = getView();
      if (view) findPrevious(view);
    };
    const runReplaceNext = () => {
      const view = getView();
      if (!view) return;
      replaceNext(view);
      // Re-count after replacement.
      const sq = new SearchQuery({
        search: query,
        caseSensitive,
        regexp: useRegex,
        wholeWord,
        replace,
      });
      setMatchCount(countMatches(view, sq));
    };
    const runReplaceAll = () => {
      const view = getView();
      if (!view) return;
      replaceAll(view);
      setMatchCount(0);
    };

    // Position: top-right overlay, VSCode-style. Stays inside the editor
    // pane via the relative container in EditorPane.
    const noMatches = useMemo(
      () => query.length > 0 && matchCount === 0,
      [query, matchCount],
    );

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
              className={cn(
                "h-7 pr-22 pl-2 text-xs",
                noMatches && "border-destructive/60",
              )}
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

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={runFindPrev}
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
                onClick={runFindNext}
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
                onClick={closeAndFocusEditor}
                aria-label="Close"
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0 cursor-pointer rounded p-1"
              >
                <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
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
                disabled={matchCount === 0}
                aria-label="Replace"
                className={cn(
                  "shrink-0 cursor-pointer rounded p-1 transition-colors",
                  "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
                )}
              >
                <HugeiconsIcon icon={ReplaceIcon} size={11} strokeWidth={2} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Replace next (Enter)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={runReplaceAll}
                disabled={matchCount === 0}
                aria-label="Replace all"
                className={cn(
                  "shrink-0 cursor-pointer rounded p-1 transition-colors",
                  "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
                )}
              >
                <HugeiconsIcon icon={ReplaceAllIcon} size={11} strokeWidth={2} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Replace all (Mod+Enter)</TooltipContent>
          </Tooltip>
          {/* Invisible placeholder matching the find row's close (×) button
              slot so both inputs share the same flex-1 width and the
              right-side button columns line up. */}
          <div className="invisible shrink-0 rounded p-1" aria-hidden>
            <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
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
            {matchCount >= MAX_MATCH_COUNT
              ? `${MAX_MATCH_COUNT}+ matches`
              : matchCount === 0
                ? "No matches"
                : `${matchCount} match${matchCount === 1 ? "" : "es"}`}
          </div>
        ) : null}
      </div>
    );
  }
