/**
 * Runtime bridge that lets Source Control open a worktree as a terminal tab.
 *
 * A bridge rather than a prop because the panel has FOUR hosts - the left
 * sidebar, the right slot, the Source Control tab (`ScmStack`) and an `scm`
 * pane leaf - and the last of those sits at the bottom of the pane tree, so a
 * callback would have to be threaded through every split on the way down.
 * Mirrors `browserBridge` / `workspaceMgmtBridge`: App wires the live callback,
 * nothing here imports React, and a call before App mounts is a no-op rather
 * than a crash.
 */
import { toast } from "@/components/ui/toast";
import { basename } from "@/lib/path";
import type { AiCliKind } from "@/modules/terminal/lib/aiCliStatus";
import { callBridge } from "@/modules/automation/bridge";
import { localWorktreeOps, mainWorktreePath, type Worktree } from "./worktrees";

export type OpenWorktreeInput = {
  /** Absolute path of the worktree folder. The tab's shell starts here. */
  path: string;
  /**
   * What the tab should be called.
   *
   * The PROJECT's name, not the worktree folder's. A terminal leaf labels itself
   * `basename(cwd)`, and a worktree folder is named after its branch, so a tab
   * opened on one read `new-layout` with nothing left saying it belonged to
   * `pokehub`. Which branch it is on is already on its own line under the row.
   */
  title?: string;
  /**
   * One command line typed at the new shell's first prompt: the repository's
   * setup command, the agent's start command, or both chained (see
   * `worktreeLaunchLine`). Nothing is typed when absent.
   */
  command?: string | null;
  /**
   * Detector kind to tag the pane with, so a launched CLI lights its status
   * badge. Explicit for the same reason `spawnAgents` passes it: the command
   * bypasses xterm's `onData`, and a setup command chained ahead of the agent
   * matches no detector pattern at all.
   */
  tool?: AiCliKind | null;
};

type OpenWorktreeFn = (input: OpenWorktreeInput) => void;

let opener: OpenWorktreeFn | null = null;

export function setWorktreeOpener(fn: OpenWorktreeFn | null): void {
  opener = fn;
}

/** Open `input.path` in a terminal tab. Silent before App has wired the bridge. */
export function openWorktreeTab(input: OpenWorktreeInput): void {
  if (!opener) {
    console.warn("[scm] openWorktreeTab called before App wired the bridge; ignoring");
    return;
  }
  opener(input);
}

/**
 * Open a worktree from a list, refusing one whose folder is gone.
 *
 * The guard is HERE rather than in each panel because both of them offer this
 * now - Source Control's worktree menu and the Workspaces panel's project row -
 * and a prunable entry is a registration git kept after someone deleted the
 * folder behind its back. Opening it would start a shell in a directory that
 * does not exist, which is a worse answer than saying so.
 */
export function openWorktree(worktree: Worktree, list: Worktree[] = []): void {
  if (worktree.prunable) {
    toast("That worktree's folder is gone. Prune it, or create it again.", { variant: "warning" });
    return;
  }
  // The whole list, not a name, because the project's name is the MAIN
  // worktree's folder and only the list knows which entry that is.
  const main = list.find((w) => w.main)?.path;
  openWorktreeTab({ path: worktree.path, title: main ? basename(main) : undefined });
}

/** One pane as the `panes` capability reports it. Only what this reads. */
type PaneInfo = { kind?: string; cwd?: string; ordinal?: number; agent?: string | null };

/**
 * Remove a worktree, refusing one a terminal is still sitting in.
 *
 * MEASURED, not assumed: removing a worktree whose folder a live shell has as
 * its cwd deregisters it and then fails to delete the directory with "Permission
 * denied" on Windows - leaving a folder `git worktree list` no longer knows
 * about and `remove` will not touch again. `--force` does not help; the lock is
 * the open handle, not the files. Even `rm -rf` answers "Device or resource
 * busy". Running from the MAIN worktree (which this does) avoids the OTHER half
 * of that trap but not this one.
 *
 * So the check has to happen BEFORE the call. Refusing with the pane's number is
 * strictly better than half-removing: the user closes one tab and retries,
 * instead of finding a directory nothing will clean up. This is the case a
 * second agent makes routine - it is working in that worktree, which is the
 * whole reason the worktree exists.
 *
 * Every removal in the app goes through here so the rule cannot be forgotten by
 * whichever surface offers it next.
 */
export async function removeWorktreeAt(
  repoRoot: string,
  path: string,
  force?: boolean,
): Promise<void> {
  const target = path.replace(/[\\/]+$/, "");
  let busy: PaneInfo[] = [];
  try {
    const panes = (await callBridge("panes")) as PaneInfo[];
    busy = panes.filter(
      (p) => p.kind === "terminal" && p.cwd && (p.cwd === target || p.cwd.startsWith(`${target}/`)),
    );
  } catch {
    // No bridge in this window: fall through and let git answer. Refusing a
    // removal because the check itself could not run would be worse.
  }
  if (busy.length > 0) {
    const where = busy
      .map((p) => `#${p.ordinal ?? "?"}${p.agent ? ` (${p.agent})` : ""}`)
      .join(", ");
    throw new Error(
      `A terminal is still open in that worktree (${where}). Close it first, or the folder is left behind: Windows cannot delete a directory a running shell is sitting in, and git deregisters the worktree before it tries.`,
    );
  }
  const list = await localWorktreeOps(repoRoot).list();
  await localWorktreeOps(mainWorktreePath(list, repoRoot)).remove(target, force);
}
