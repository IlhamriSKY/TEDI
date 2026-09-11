import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { CliAgentIcon } from "@/components/CliAgentIcon";
import { cn } from "@/lib/utils";
import { toForwardSlash } from "@/lib/path";
import { effectiveCliAgents, useCliAgentsStore } from "@/modules/terminal/lib/cliAgents";
import { invalidBranchName } from "../api";
import type { GitBranch } from "../types";
import { suggestWorktreePath, worktreeSlug, type Worktree } from "../worktrees";
import type { WorktreeCreate } from "../worktreeCreate";
import { getSetupCommand } from "../worktreeSetup";
import { BranchCombobox, Field } from "./FormControls";

/**
 * What this dialog submits. Defined by `worktreeCreate.ts`, which is what acts
 * on it, so the two cannot drift - the `setup` / `runSetup` split in particular
 * is a rule of the SAVE path, not a shape this form invented.
 */
export type WorktreeSubmit = WorktreeCreate;

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Repository root the worktree is created from. */
  repoRoot: string;
  /** Existing worktrees, so a path or branch already taken is refused up front. */
  worktrees: Worktree[];
  /** Loaded on open, for the "existing branch" and "branch from" pickers. */
  loadBranches: () => Promise<GitBranch[]>;
  onSubmit: (input: WorktreeSubmit) => Promise<void>;
};

/**
 * Create a worktree, and start working in it in the same click.
 *
 * The three fields under the branch name are the difference between a worktree
 * you can use and one you have to set up by hand: the folder it lands in, the
 * install command a fresh checkout needs (no `node_modules`, no `vendor`, no
 * `.env` - all of them gitignored, so a worktree is checked out without them),
 * and the agent that should be running in it when you look at the new tab.
 *
 * The path is DERIVED from the branch until the user types into it, at which
 * point it stops following - editing a field only to have it rewritten on the
 * next keystroke is the worse half of that trade.
 */
export function WorktreeDialog({
  open,
  onOpenChange,
  repoRoot,
  worktrees,
  loadBranches,
  onSubmit,
}: Props) {
  const hydrate = useCliAgentsStore((s) => s.hydrate);
  const customAgents = useCliAgentsStore((s) => s.customAgents);
  const overrides = useCliAgentsStore((s) => s.overrides);
  const agents = useMemo(
    () => effectiveCliAgents(customAgents, overrides).filter((a) => a.command.trim() !== ""),
    [customAgents, overrides],
  );

  const [branch, setBranch] = useState("");
  const [create, setCreate] = useState(true);
  const [startPoint, setStartPoint] = useState("");
  const [path, setPath] = useState("");
  /** Set once the user edits the path, which stops it following the branch. */
  const [pathEdited, setPathEdited] = useState(false);
  const [setup, setSetup] = useState("");
  const [runSetup, setRunSetup] = useState(false);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [branches, setBranches] = useState<GitBranch[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Start clean on every open, so a previous attempt never leaks into the next
  // one, and load what the fields need: the branch list and the repository's
  // saved setup command.
  useEffect(() => {
    if (!open) return;
    setBranch("");
    setCreate(true);
    setStartPoint("");
    setPath("");
    setPathEdited(false);
    setAgentId(null);
    setBranches(null);
    setError(null);
    setBusy(false);
    void loadBranches().then(setBranches, () => setBranches([]));
    void getSetupCommand(repoRoot).then((cmd) => {
      setSetup(cmd);
      // Pre-armed only when there is something saved to run. A repository
      // nobody has set one for opens with the switch off and the field empty,
      // rather than an armed toggle over a blank command.
      setRunSetup(cmd !== "");
    });
  }, [open, repoRoot, loadBranches]);

  const onBranchChange = (next: string) => {
    setBranch(next);
    if (!pathEdited) setPath(next.trim() ? suggestWorktreePath(repoRoot, next) : "");
  };

  const nameError = branch.trim() ? invalidBranchName(branch) : null;
  const takenBy = worktrees.find((w) => w.branch === branch.trim());
  const pathTaken = worktrees.some((w) => w.path === toForwardSlash(path.trim()));
  const existing = (branches ?? []).filter((b) => !b.remote).map((b) => b.name);
  const branchExists = existing.includes(branch.trim());

  const problem = nameError
    ? nameError
    : takenBy
      ? `${branch.trim()} is already checked out at ${takenBy.path}.`
      : pathTaken
        ? "A worktree already exists at that path."
        : create && branchExists
          ? `${branch.trim()} already exists. Turn off "Create the branch" to check it out here.`
          : !create && branches !== null && !branchExists
            ? `${branch.trim()} is not a local branch. Turn on "Create the branch" to make it.`
            : null;

  const ready = branch.trim() !== "" && path.trim() !== "" && !problem && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        path: toForwardSlash(path.trim()),
        branch: branch.trim(),
        create,
        startPoint: create && startPoint ? startPoint : undefined,
        setup,
        runSetup,
        agent: agents.find((a) => a.id === agentId) ?? null,
      });
      onOpenChange(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New worktree</DialogTitle>
          <DialogDescription>
            A second checkout of this repository in its own folder, on its own branch. Your current
            work stays exactly where it is.
          </DialogDescription>
        </DialogHeader>

        {/* The fields scroll, the footer stays put. `DialogContent` is a capped
            flex column with `overflow-hidden`, so a form this tall (six controls
            plus a roster that grows with every custom agent) otherwise pushes
            the footer past the bottom edge and CLIPS it - taking the Create
            button with it. `min-h-0` is what lets a flex child actually shrink.

            `overflow-x-hidden` is NOT redundant beside `overflow-y-auto`: CSS
            computes a `visible` axis to `auto` as soon as the other one is not
            visible, so asking for vertical scrolling silently grants horizontal
            scrolling too. It had something to scroll, as well - `Switch` carries
            an invisible `after:-inset-x-3` tap target that reaches 12px past its
            own box, so each of the two toggle rows pushed the form 10px wide and
            the whole dialog slid sideways over nothing. */}
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-x-hidden overflow-y-auto">
          <Field label="Branch">
            {create ? (
              <Input
                autoFocus
                placeholder="fix-login"
                value={branch}
                onChange={(e) => onBranchChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && ready) {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            ) : (
              <BranchCombobox
                branches={branches ?? []}
                value={branch}
                onChange={onBranchChange}
                placeholder="Select a branch"
                disabled={busy}
              />
            )}
          </Field>

          <label className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 flex-col">
              <span className="text-[12px]">Create the branch</span>
              <span className="text-muted-foreground text-[11px]">
                {create ? "Branches from the current HEAD." : "Checks out a branch that exists."}
              </span>
            </span>
            <Switch
              checked={create}
              onCheckedChange={(v) => {
                setCreate(v);
                setStartPoint("");
              }}
              disabled={busy}
            />
          </label>

          {create ? (
            <Field label="Branch from (optional)">
              <BranchCombobox
                branches={branches ?? []}
                value={startPoint}
                onChange={setStartPoint}
                noneLabel="Current HEAD"
                placeholder="Current HEAD"
                disabled={busy}
              />
            </Field>
          ) : null}

          <Field label="Folder">
            <Input
              placeholder={suggestWorktreePath(repoRoot, "branch-name")}
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setPathEdited(true);
              }}
              className="font-mono text-[11px]"
            />
          </Field>

          <label className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 flex-col">
              <span className="text-[12px]">Run setup first</span>
              <span className="text-muted-foreground text-[11px]">
                A fresh worktree has no node_modules, vendor or .env.
              </span>
            </span>
            <Switch checked={runSetup} onCheckedChange={setRunSetup} disabled={busy} />
          </label>
          {runSetup ? (
            <Input
              placeholder="pnpm install"
              value={setup}
              onChange={(e) => setSetup(e.target.value)}
              className="font-mono text-[11px]"
              aria-label="Setup command"
            />
          ) : null}

          <Field label="Start an agent (optional)">
            <div className="grid grid-cols-2 gap-2">
              {agents.map((a) => {
                const picked = a.id === agentId;
                return (
                  <button
                    key={a.id}
                    type="button"
                    aria-pressed={picked}
                    // Clicking the picked one clears it: this is a single choice
                    // with no "none" tile, so the tile has to be its own undo.
                    onClick={() => setAgentId(picked ? null : a.id)}
                    className={cn(
                      "flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
                      "focus-visible:ring-ring/50 outline-none focus-visible:ring-2",
                      picked
                        ? "border-primary bg-primary/5"
                        : "border-border/60 bg-card hover:border-border hover:bg-accent/40",
                    )}
                  >
                    <CliAgentIcon
                      agentId={a.id}
                      size={14}
                      className={picked ? "text-foreground" : "text-muted-foreground"}
                    />
                    <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">
                      {a.name || "(unnamed)"}
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>

          {(problem ?? error) ? (
            <p className="text-destructive text-[11px]">{problem ?? error}</p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" disabled={!ready} onClick={() => void submit()}>
            {busy ? <Spinner className="size-3" /> : null}
            Create {branch.trim() ? worktreeSlug(branch) : "worktree"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
