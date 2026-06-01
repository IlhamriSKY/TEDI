import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  FileSearchIcon,
  ReplaceAllIcon,
  ReplaceIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { motion } from "motion/react";
import { type Dispatch, type Ref, type SetStateAction } from "react";
import { type GrepHit, type Row } from "./grepUtils";

type GrepSearchBarProps = {
  inputRef: Ref<HTMLInputElement>;
  replaceInputRef: Ref<HTMLInputElement>;
  query: string;
  setQuery: Dispatch<SetStateAction<string>>;
  useRegex: boolean;
  setUseRegex: Dispatch<SetStateAction<boolean>>;
  regexError: string | null;
  caseSensitive: boolean;
  setCaseSensitive: Dispatch<SetStateAction<boolean>>;
  replaceText: string;
  setReplaceText: Dispatch<SetStateAction<string>>;
  replaceArmed: boolean;
  setReplaceArmed: Dispatch<SetStateAction<boolean>>;
  replacing: boolean;
  hits: GrepHit[];
  active: boolean;
  fileCount: number;
  hitCount: number;
  clampedActive: number;
  rows: Row[];
  setActiveHitIdx: Dispatch<SetStateAction<number>>;
  onRequestClose: () => void;
  openHit: (h: GrepHit) => void;
  requestReplaceAll: () => void;
};

export function GrepSearchBar({
  inputRef,
  replaceInputRef,
  query,
  setQuery,
  useRegex,
  setUseRegex,
  regexError,
  caseSensitive,
  setCaseSensitive,
  replaceText,
  setReplaceText,
  replaceArmed,
  setReplaceArmed,
  replacing,
  hits,
  active,
  fileCount,
  hitCount,
  clampedActive,
  rows,
  setActiveHitIdx,
  onRequestClose,
  openHit,
  requestReplaceAll,
}: GrepSearchBarProps) {
  return (
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
                disabled={replacing || hits.length === 0 || (useRegex && !!regexError) || !active}
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
        <div className="text-icon-working mt-1 text-[10px]">
          Press Enter again to replace {hits.length} match{hits.length === 1 ? "" : "es"} in{" "}
          {fileCount} file{fileCount === 1 ? "" : "s"}. Esc to cancel.
        </div>
      ) : null}
    </motion.div>
  );
}
