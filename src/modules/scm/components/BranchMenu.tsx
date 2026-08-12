import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { invalidBranchName } from "../api";
import type { GitBranch, GitStatus } from "../types";
import {
  Check,
  ChevronDown,
  Cloud,
  GitBranch as GitBranchIcon,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";

type Props = {
  status: GitStatus;
  /** Loads on open, not on every status poll: `for-each-ref` is a subprocess
   *  and the list only changes when the user acts on it. */
  loadBranches: () => Promise<GitBranch[]>;
  onCheckout: (name: string, create?: boolean) => Promise<void>;
  onDeleteBranch: (name: string, force?: boolean) => Promise<void>;
  onRenameBranch: (from: string, to: string) => Promise<void>;
  disabled?: boolean;
};

export function BranchMenu({
  status,
  loadBranches,
  onCheckout,
  onDeleteBranch,
  onRenameBranch,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<GitBranch | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /** Branch being renamed, and the name being typed for it. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  // Dropped rather than applied when the menu is reopened for another repo.
  const reqRef = useRef(0);

  const refresh = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    try {
      const list = await loadBranches();
      if (reqRef.current === req) setBranches(list);
    } catch {
      if (reqRef.current === req) setBranches([]);
    } finally {
      if (reqRef.current === req) setLoading(false);
    }
  }, [loadBranches]);

  useEffect(() => {
    if (!open) return;
    setFilter("");
    void refresh();
  }, [open, refresh]);

  const { locals, remotes } = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (b: GitBranch) => !q || b.name.toLowerCase().includes(q);
    const all = (branches ?? []).filter(match);
    return {
      locals: all.filter((b) => !b.remote),
      // A remote branch already checked out locally is reachable from the local
      // list; showing it twice just makes the menu longer.
      remotes: all.filter(
        (b) => b.remote && !(branches ?? []).some((l) => !l.remote && l.upstream === b.name),
      ),
    };
  }, [branches, filter]);

  const run = async (fn: () => Promise<void>) => {
    setOpen(false);
    await fn();
  };

  const label = status.isRepo ? (status.branch ?? "HEAD") : "Source Control";

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild disabled={disabled || !status.isRepo}>
          {/* Reads as a control, not a caption: fills the header the way a
              select does, with a border on hover/open and a chevron on the far
              edge. Without them the branch was styled exactly like the static
              label it replaced, so nothing said it could be clicked. Radix
              supplies aria-haspopup / aria-expanded. */}
          <Button
            variant="ghost"
            className="text-foreground/80 hover:border-border aria-expanded:border-border h-6 min-w-0 flex-1 justify-start gap-1 rounded-md px-1.5 text-xs font-medium"
            aria-label={`Branch ${label}. Switch branch`}
          >
            <GitBranchIcon size={13} strokeWidth={2} className="text-icon-branch shrink-0" />
            <span className="truncate">{label}</span>
            {/* ml-auto parks the chevron on the right edge the way a select
                does, so the affordance is where the eye looks for it however
                short the branch name is. */}
            <ChevronDown
              size={11}
              strokeWidth={2.5}
              className="text-muted-foreground ml-auto shrink-0 transition-transform group-aria-expanded/button:rotate-180"
            />
          </Button>
        </DropdownMenuTrigger>
        {/* Matches the trigger's width, with the old fixed width as a floor so a
            narrow sidebar does not squeeze the branch names. */}
        <DropdownMenuContent
          align="start"
          className="max-h-[60vh] w-[var(--radix-dropdown-menu-trigger-width)] min-w-64 overflow-y-auto"
        >
          <div className="p-1">
            <Input
              autoFocus
              placeholder="Filter branches"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              // Radix menus type-ahead on printable keys and would steal every
              // keystroke from this field.
              onKeyDown={(e) => e.stopPropagation()}
              className="h-7 text-[11.5px]"
            />
          </div>
          <DropdownMenuItem
            onSelect={() => {
              setNewName("");
              setCreating(true);
            }}
          >
            <Plus size={12} strokeWidth={2} />
            Create new branch…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {loading && branches === null ? (
            <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-[11.5px]">
              <Spinner className="size-3" /> Loading branches…
            </div>
          ) : locals.length === 0 && remotes.length === 0 ? (
            <div className="text-muted-foreground px-2 py-3 text-[11.5px]">No branches found.</div>
          ) : null}
          {locals.length > 0 ? <DropdownMenuLabel>Local</DropdownMenuLabel> : null}
          {locals.map((b) => (
            <DropdownMenuItem
              key={`l:${b.name}`}
              className="group/branch"
              onSelect={() => void run(() => onCheckout(b.name))}
            >
              <Check
                size={12}
                strokeWidth={2.5}
                className={cn("shrink-0", !b.current && "invisible")}
              />
              <span className="min-w-0 flex-1 truncate">{b.name}</span>
              {/* Rename works on the current branch too - it is the one you
                  most often want to rename, right after realising the name was
                  wrong. Delete stays off it, because git refuses that anyway. */}
              <span
                role="button"
                tabIndex={-1}
                aria-label={`Rename branch ${b.name}`}
                className="hover:bg-muted hover:text-foreground shrink-0 rounded-md p-0.5 opacity-0 transition-[background-color,opacity] group-hover/branch:opacity-100"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setRenameTo(b.name);
                  setRenaming(b.name);
                }}
              >
                <Pencil size={11} strokeWidth={2} />
              </span>
              {!b.current ? (
                <span
                  role="button"
                  tabIndex={-1}
                  aria-label={`Delete branch ${b.name}`}
                  className={cn(
                    DESTRUCTIVE_ACTION,
                    "shrink-0 opacity-0 transition-[background-color,opacity] group-hover/branch:opacity-100",
                  )}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDeleteError(null);
                    setConfirmDelete(b);
                  }}
                >
                  <Trash2 size={11} strokeWidth={2} />
                </span>
              ) : null}
            </DropdownMenuItem>
          ))}
          {remotes.length > 0 ? <DropdownMenuLabel>Remote</DropdownMenuLabel> : null}
          {remotes.map((b) => (
            <DropdownMenuItem
              key={`r:${b.name}`}
              onSelect={() => void run(() => onCheckout(b.name))}
            >
              <Cloud size={12} strokeWidth={2} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{b.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create branch</DialogTitle>
            <DialogDescription>
              Branches from {status.branch ?? "HEAD"} and switches to the new branch.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="branch-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !invalidBranchName(newName)) {
                e.preventDefault();
                setCreating(false);
                void onCheckout(newName.trim(), true);
              }
            }}
          />
          {newName.trim() && invalidBranchName(newName) ? (
            <p className="text-destructive text-[11px]">{invalidBranchName(newName)}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!!invalidBranchName(newName)}
              onClick={() => {
                setCreating(false);
                void onCheckout(newName.trim(), true);
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renaming !== null}
        onOpenChange={(o) => {
          if (!o) setRenaming(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename branch</DialogTitle>
            <DialogDescription>
              Renames {renaming} locally. A branch already pushed keeps its old name on the remote
              until you push the new one.
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="branch-name"
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                renaming &&
                renameTo.trim() &&
                !invalidBranchName(renameTo)
              ) {
                e.preventDefault();
                const from = renaming;
                setRenaming(null);
                void onRenameBranch(from, renameTo.trim()).then(refresh);
              }
            }}
          />
          {renameTo.trim() && invalidBranchName(renameTo) ? (
            <p className="text-destructive text-[11px]">{invalidBranchName(renameTo)}</p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={
                !renameTo.trim() || !!invalidBranchName(renameTo) || renameTo.trim() === renaming
              }
              onClick={() => {
                const from = renaming;
                if (!from) return;
                setRenaming(null);
                void onRenameBranch(from, renameTo.trim()).then(refresh);
              }}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmDelete(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete branch {confirmDelete?.name}?</DialogTitle>
            <DialogDescription>
              {deleteError
                ? deleteError
                : "Deletes the local branch. Its commits stay reachable from any branch that already contains them."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const b = confirmDelete;
                if (!b) return;
                // `-d` refuses a branch whose commits are not merged anywhere.
                // Surfacing that and offering `-D` on the retry keeps the
                // unmerged-work warning instead of force-deleting up front.
                void onDeleteBranch(b.name, deleteError !== null)
                  .then(() => {
                    setConfirmDelete(null);
                    setDeleteError(null);
                    void refresh();
                  })
                  .catch((e: unknown) => setDeleteError(String(e)));
              }}
            >
              {deleteError ? "Force delete" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
