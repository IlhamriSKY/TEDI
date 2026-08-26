import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import type { GitOps } from "../api";
import {
  buildHunkPatch,
  isSelectableLine,
  parseFileDiff,
  patchLineKind,
  type FileDiff,
} from "../patch";
import type { GitChange } from "../types";
import { CornerUpLeft, Minus, Plus } from "lucide-react";

type Props = {
  ops: GitOps;
  change: GitChange;
  /**
   * Bumped by the panel after any write, so the hunks are re-read rather than
   * left describing a file that has moved on. A hunk is addressed by its INDEX,
   * and an index into a stale list is the one way this can act on the wrong
   * hunk, so nothing here is allowed to act on a diff it has not just read.
   */
  reloadKey: number;
  /** Re-read the panel's status once a hunk has been applied. */
  onApplied: () => void;
  busy?: boolean;
};

/** Cap the rows a single expanded file can add to the panel. A generated file
 *  can have thousands of hunks and none of them are being reviewed by hand. */
const MAX_HUNKS = 60;

/**
 * The hunks of one changed file, each stageable on its own.
 *
 * Everything here reads `git diff` for a single path and hands a one-hunk patch
 * back to `git apply`. git decides whether the patch still applies; a stale one
 * fails loudly rather than landing in the wrong place, which is why
 * `--unidiff-zero` is not used on the Rust side.
 */
export function HunkList({ ops, change, reloadKey, onApplied, busy }: Props) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  /** `hunkIndex -> chosen line indices`. Absent or empty means the whole hunk. */
  const [picked, setPicked] = useState<Map<number, Set<number>>>(() => new Map());
  const reqRef = useRef(0);

  const staged = change.staged;

  useEffect(() => {
    const req = ++reqRef.current;
    setLoading(true);
    void ops.fileDiff(change.relative, staged).then(
      (raw) => {
        if (reqRef.current !== req) return;
        setDiff(parseFileDiff(raw));
        setError(null);
        // The line picks belong to the diff they were made against, so a
        // re-read drops them instead of re-applying indices to new hunks.
        setPicked(new Map());
        setLoading(false);
      },
      (e: unknown) => {
        if (reqRef.current !== req) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  }, [ops, change.relative, staged, reloadKey]);

  const toggleLine = useCallback((hunkIndex: number, lineIndex: number) => {
    setPicked((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(hunkIndex) ?? []);
      if (set.has(lineIndex)) set.delete(lineIndex);
      else set.add(lineIndex);
      if (set.size === 0) next.delete(hunkIndex);
      else next.set(hunkIndex, set);
      return next;
    });
  }, []);

  /**
   * Apply one hunk. `discard` writes the working tree instead of the index;
   * unstaging is the same patch applied in reverse.
   */
  const apply = useCallback(
    async (hunkIndex: number, mode: "stage" | "unstage" | "discard") => {
      if (!diff || running || busy) return;
      setRunning(true);
      try {
        const patch = buildHunkPatch(diff, hunkIndex, picked.get(hunkIndex) ?? null);
        await ops.applyPatch(patch, mode !== "discard", mode !== "stage");
        toast(
          mode === "stage"
            ? "Hunk staged."
            : mode === "unstage"
              ? "Hunk unstaged."
              : "Hunk discarded.",
          { variant: "success" },
        );
        onApplied();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), { variant: "error" });
      } finally {
        setRunning(false);
      }
    },
    [diff, running, busy, picked, ops, onApplied],
  );

  const hunks = useMemo(() => diff?.hunks.slice(0, MAX_HUNKS) ?? [], [diff]);
  const hidden = (diff?.hunks.length ?? 0) - hunks.length;

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-1.5 py-1 pl-8 text-[10.5px]">
        <Spinner className="size-3" />
        Reading hunks…
      </div>
    );
  }
  if (error) {
    return <p className="text-muted-foreground py-1 pl-8 text-[10.5px]">{error}</p>;
  }
  if (!diff) {
    return (
      <p className="text-muted-foreground py-1 pl-8 text-[10.5px]">
        Nothing to stage piecemeal in this file.
      </p>
    );
  }

  return (
    <div className="border-border/60 bg-muted/20 border-y">
      {hunks.map((hunk, hi) => {
        const chosen = picked.get(hi);
        const partial = chosen !== undefined && chosen.size > 0;
        const label = partial ? `${chosen.size} line${chosen.size === 1 ? "" : "s"}` : "hunk";
        return (
          <div key={hi} className="border-border/40 border-b last:border-b-0">
            <div className="text-muted-foreground flex min-h-6 items-center gap-1 px-2 py-0.5 text-[10px]">
              <span className="min-w-0 flex-1 truncate font-mono">{hunk.header}</span>
              <span className="shrink-0 tabular-nums">
                <span className="text-diff-added">+{hunk.additions}</span>{" "}
                <span className="text-diff-removed">−{hunk.deletions}</span>
              </span>
              {staged ? (
                <IconTooltip label={`Unstage this ${label}`} side="left">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="hover:text-foreground size-5"
                    disabled={running || busy}
                    onClick={() => void apply(hi, "unstage")}
                    aria-label={`Unstage ${label} of ${change.relative}`}
                  >
                    <Minus size={11} strokeWidth={2.5} />
                  </Button>
                </IconTooltip>
              ) : (
                <>
                  <IconTooltip label={`Stage this ${label}`} side="left">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="hover:text-foreground size-5"
                      disabled={running || busy}
                      onClick={() => void apply(hi, "stage")}
                      aria-label={`Stage ${label} of ${change.relative}`}
                    >
                      <Plus size={11} strokeWidth={2.5} />
                    </Button>
                  </IconTooltip>
                  {/* No confirmation: a discarded hunk is one hunk of one file,
                      and the whole-file discard the panel already guards is the
                      destructive one. */}
                  <IconTooltip label={`Discard this ${label}`} side="left">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="hover:text-destructive size-5"
                      disabled={running || busy}
                      onClick={() => void apply(hi, "discard")}
                      aria-label={`Discard ${label} of ${change.relative}`}
                    >
                      <CornerUpLeft size={11} strokeWidth={2} />
                    </Button>
                  </IconTooltip>
                </>
              )}
            </div>
            <div className="overflow-x-auto">
              <pre className="min-w-full font-mono text-[10.5px] leading-[1.45]">
                {hunk.lines.map((line, li) => {
                  const kind = patchLineKind(line);
                  const selectable = isSelectableLine(line) && !hunk.hasNoNewline;
                  const on = chosen?.has(li) ?? false;
                  return (
                    <div
                      key={li}
                      role={selectable ? "button" : undefined}
                      tabIndex={selectable ? 0 : undefined}
                      onClick={selectable ? () => toggleLine(hi, li) : undefined}
                      onKeyDown={
                        selectable
                          ? (e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                toggleLine(hi, li);
                              }
                            }
                          : undefined
                      }
                      className={cn(
                        "px-2 whitespace-pre",
                        kind === "add" && "bg-diff-added/10 text-diff-added",
                        kind === "del" && "bg-diff-removed/10 text-diff-removed",
                        kind === "meta" && "text-muted-foreground/70 italic",
                        selectable && "hover:bg-accent/40 cursor-pointer",
                        // A picked line is the one that will be in the patch, so
                        // it reads as selected text rather than as a hover.
                        on && "ring-primary/60 bg-accent/60 ring-1 ring-inset",
                      )}
                    >
                      {line || " "}
                    </div>
                  );
                })}
              </pre>
            </div>
            {hunk.hasNoNewline ? (
              <p className="text-muted-foreground/70 px-2 py-0.5 text-[10px]">
                This hunk changes the final newline, so it stages whole.
              </p>
            ) : null}
          </div>
        );
      })}
      {hidden > 0 ? (
        <p className="text-muted-foreground px-2 py-1 text-[10px]">
          {hidden} more hunks not shown. Stage the whole file, or open its diff.
        </p>
      ) : null}
    </div>
  );
}
