import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { toForwardSlash } from "@/lib/path";
import { gitStatus } from "../api";
import type { Worktree } from "../worktrees";
import { Check, Eraser, GitFork, Lock, Plus, TriangleAlert, Trash2 } from "lucide-react";

/** Per-worktree working-tree summary, filled in after the list renders. */
type Summary = { changes: number; ahead: number };

type Props = {
  /** The worktree the panel is currently pointed at, so its row can be marked.
   *  NOT necessarily the main one - the panel follows the focused terminal. */
  repoRoot: string;
  /** Loads on open, not on every status poll: it is a subprocess, and the list
   *  only changes when someone acts on it. */
  loadWorktrees: () => Promise<Worktree[]>;
  onOpen: (w: Worktree) => void;
  onCreate: () => void;
  onRemove: (path: string, force?: boolean) => Promise<void>;
  onPrune: () => Promise<void>;
  disabled?: boolean;
};

/**
 * The worktree list, and everything you can do to one, from the Source Control
 * header.
 *
 * Why it belongs beside the branch name rather than in its own sidebar section:
 * a worktree IS a branch checkout, and the two menus answer the same question
 * one step apart - "what am I on" and "what else is checked out". Keeping them
 * adjacent is also what makes the hand-off in `BranchMenu` legible, where a
 * branch already held by a worktree opens it instead of failing.
 *
 * Change counts are loaded per worktree AFTER the list paints. Each is a
 * `git status` subprocess, so gathering them first would stall the menu on the
 * slowest repository in the set; arriving late costs one extra render and the
 * list is useful without them.
 */
export function WorktreeMenu({
  repoRoot,
  loadWorktrees,
  onOpen,
  onCreate,
  onRemove,
  onPrune,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Worktree[] | null>(null);
  const [summaries, setSummaries] = useState<Record<string, Summary>>({});
  const [loading, setLoading] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Worktree | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  // Dropped rather than applied when the menu is reopened for another repo.
  const reqRef = useRef(0);

  const refresh = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    try {
      const next = await loadWorktrees();
      if (reqRef.current !== req) return;
      setList(next);
      setSummaries({});
      // Fire and forget, one per worktree. A repository that cannot be read
      // (a prunable entry whose folder is gone) simply keeps no summary.
      for (const w of next) {
        if (w.prunable || w.bare) continue;
        void gitStatus(w.path).then(
          (s) => {
            if (reqRef.current !== req) return;
            // Read through optionals rather than trusting the shape. This is a
            // DECORATION - a count beside a row - and it runs inside a loop with
            // no error boundary above it, so a reply that is not the object this
            // expects would otherwise throw out of the `.then` and take the whole
            // Source Control panel down with it. Caught in the browser preview,
            // where the Tauri shim answers every command with `undefined`.
            const changes = s?.changes?.length ?? 0;
            const ahead = s?.ahead ?? 0;
            setSummaries((curr) => ({ ...curr, [w.path]: { changes, ahead } }));
          },
          () => {},
        );
      }
    } catch {
      if (reqRef.current === req) setList([]);
    } finally {
      if (reqRef.current === req) setLoading(false);
    }
  }, [loadWorktrees]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const root = toForwardSlash(repoRoot);
  const count = list?.length ?? 0;
  const prunable = (list ?? []).some((w) => w.prunable);
  /** Paths are shown relative to the MAIN worktree, not to `repoRoot`: the
   *  panel follows the focused terminal, so `repoRoot` is whichever worktree is
   *  being looked at, and every OTHER row would then print in full. */
  const base = (list ?? []).find((w) => w.main)?.path ?? root;

  /** A worktree's path relative to the repository when it lives inside it,
   *  which is where TEDI puts them. An absolute path elsewhere is shown whole -
   *  shortening it would hide the only thing that distinguishes it. */
  const shortPath = (w: Worktree) =>
    w.path === base ? "." : w.path.startsWith(`${base}/`) ? w.path.slice(base.length + 1) : w.path;

  /** Uncommitted files in the worktree awaiting confirmation. Read from the
   *  summaries the list already loaded, so this costs no extra subprocess. */
  const pendingChanges = confirmRemove ? (summaries[confirmRemove.path]?.changes ?? 0) : 0;

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        {/* The tooltip goes OUTSIDE the trigger. `DropdownMenuTrigger asChild`
            hands its props to its child, and IconTooltip takes only
            label/side/children and forwards nothing - wrapping the Button in it
            swallows every trigger prop and the menu never opens. Radix triggers
            DO compose with each other. Same trap as the Merge button in
            `PrReviewView`. */}
        <IconTooltip label="Worktrees" side="bottom">
          <DropdownMenuTrigger asChild disabled={disabled}>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground relative size-6"
              aria-label={`Worktrees${count > 1 ? ` (${count})` : ""}`}
            >
              <GitFork size={13} strokeWidth={2} />
              {/* Only past one, because every repository has a main worktree
                  and a badge reading "1" would say nothing. */}
              {count > 1 ? (
                <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex size-3 items-center justify-center rounded-full text-[8px] font-semibold tabular-nums">
                  {count}
                </span>
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </IconTooltip>
        <DropdownMenuContent align="end" className="max-h-[60vh] w-80 overflow-y-auto">
          <DropdownMenuLabel>Worktrees</DropdownMenuLabel>
          {loading && list === null ? (
            <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-[11.5px]">
              <Spinner className="size-3" /> Loading worktrees
            </div>
          ) : null}
          {(list ?? []).map((w) => {
            const current = w.path === root;
            const s = summaries[w.path];
            return (
              <DropdownMenuItem
                key={w.path}
                className="group/wt items-start"
                onSelect={() => {
                  setOpen(false);
                  onOpen(w);
                }}
              >
                <Check
                  size={12}
                  strokeWidth={2.5}
                  className={cn("mt-0.5 shrink-0", !current && "invisible")}
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate">
                      {w.branch ?? (w.bare ? "(bare)" : `(detached ${w.head.slice(0, 7)})`)}
                    </span>
                    {w.main ? (
                      <span className="text-muted-foreground shrink-0 text-[10px]">main</span>
                    ) : null}
                    {w.locked ? (
                      <Lock size={10} strokeWidth={2} className="text-muted-foreground shrink-0" />
                    ) : null}
                    {w.prunable ? (
                      <TriangleAlert
                        size={10}
                        strokeWidth={2}
                        className="text-destructive shrink-0"
                      />
                    ) : null}
                  </span>
                  <span className="text-muted-foreground truncate font-mono text-[10px]">
                    {w.prunable ? "folder is gone" : shortPath(w)}
                  </span>
                </span>
                {s && (s.changes > 0 || s.ahead > 0) ? (
                  <span className="text-muted-foreground mt-0.5 shrink-0 text-[10px] tabular-nums">
                    {s.changes > 0 ? `${s.changes} •` : ""}
                    {s.ahead > 0 ? ` ↑${s.ahead}` : ""}
                  </span>
                ) : null}
                {/* The main worktree holds `.git` and git refuses to remove it,
                    so it gets no button rather than one that always errors. A
                    LOCKED one is the same dead end: git refuses `remove --force`
                    on it ("use 'remove -f -f' to override or unlock first"), so
                    Remove and then "Delete anyway" failed identically with no way
                    out. A lock is somebody's deliberate "keep this"; the Lock icon
                    says why the button is gone. */}
                {!w.main && !w.locked ? (
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Remove worktree ${w.branch ?? w.path}`}
                    className={cn(
                      DESTRUCTIVE_ACTION,
                      "mt-0.5 shrink-0 opacity-0 transition-[background-color,opacity] group-hover/wt:opacity-100",
                    )}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setRemoveError(null);
                      setConfirmRemove(w);
                    }}
                  >
                    <Trash2 size={11} strokeWidth={2} />
                  </span>
                ) : null}
              </DropdownMenuItem>
            );
          })}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              setOpen(false);
              onCreate();
            }}
          >
            <Plus size={12} strokeWidth={2} />
            New worktree
          </DropdownMenuItem>
          {prunable ? (
            <DropdownMenuItem
              onSelect={() => {
                setOpen(false);
                void onPrune();
              }}
            >
              <Eraser size={12} strokeWidth={2} />
              Prune worktrees whose folder is gone
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={confirmRemove !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmRemove(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove worktree {confirmRemove?.branch ?? ""}?</DialogTitle>
            <DialogDescription>
              {/* Name the uncommitted work BEFORE the click rather than letting
                  git refuse and turning the button into "Delete anyway". The
                  count is already loaded for the row's own badge, and with an
                  agent working in a second worktree this is the difference
                  between confirming a folder and confirming its work. */}
              {removeError ??
                (pendingChanges > 0
                  ? `${pendingChanges} uncommitted ${pendingChanges === 1 ? "change" : "changes"} in it will be lost. Commits already made stay in the repository, and the branch itself is kept.`
                  : "Deletes the folder. Commits made in it stay in the repository, and the branch itself is kept.")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmRemove(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const w = confirmRemove;
                if (!w) return;
                // git refuses a worktree with modified or untracked files, which
                // is the normal state of one an agent has worked in. Surfacing
                // that first and offering `--force` on the retry keeps the
                // uncommitted-work warning instead of always forcing.
                void onRemove(w.path, removeError !== null)
                  .then(() => {
                    setConfirmRemove(null);
                    setRemoveError(null);
                    void refresh();
                  })
                  .catch((e: unknown) => setRemoveError(String(e)));
              }}
            >
              {removeError ? "Delete anyway" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
