/**
 * Check out a pull request into a worktree of its own, and the tidy-up after a
 * merge.
 *
 * Its own file rather than more of `worktrees.ts` because it is the one place
 * the two features meet, and because `worktrees.ts` stays free of `gh` and of
 * the tab bridge so `scripts/scm/worktree-verify.ts` can load it on its own.
 */
import { toast } from "@/components/ui/toast";
import { ghFor } from "./gh";
import { openWorktreeTab, removeWorktreeAt } from "./worktreeBridge";
import {
  ignoreWorktreesFolder,
  localWorktreeOps,
  mainWorktreePath,
  suggestWorktreePath,
  worktreeHolding,
  type Worktree,
} from "./worktrees";

/**
 * Bring PR `number` up in a new worktree instead of moving this checkout's HEAD.
 *
 * The worktree is created DETACHED and `gh pr checkout` is then run inside it.
 * Naming the branch here instead would mean reimplementing what gh already
 * does: the head branch may not exist locally, and for a PR from a fork it does
 * not exist on this remote under that name at all. Detaching first means the
 * only thing this function has to know is a path.
 *
 * A failed checkout removes the worktree it just made. Leaving a stray detached
 * worktree behind would be a second thing for the user to notice and clean up,
 * on top of the failure they already have to read.
 */
export async function checkoutPrInWorktree(
  repoRoot: string,
  number: number,
  headRefName: string,
): Promise<void> {
  // Everything below runs from the MAIN worktree - see `mainWorktreePath`.
  // `repoRoot` is whichever checkout the panel is pointed at, which after a
  // review started inside a worktree is not the repository's own root.
  const list = await localWorktreeOps(repoRoot).list();
  // ONE resolution, used for the runner AND for the path. Deriving the path from
  // `repoRoot` instead was a real bug: reviewing a PR from a terminal already
  // inside a worktree put the new one at `<worktree>/.worktrees/<branch>`, and
  // `git worktree remove --force` on the outer one then deleted the nested
  // checkout with rc=0 and no warning, taking whatever was uncommitted in it.
  // The user had only confirmed removing the outer one.
  const mainRoot = mainWorktreePath(list, repoRoot);
  const ops = localWorktreeOps(mainRoot);
  const existing = worktreeHolding(list, headRefName);
  // Already checked out somewhere: opening it is what the user wanted, and a
  // second worktree on the same branch is something git refuses anyway.
  if (existing) {
    openWorktreeTab({ path: existing.path });
    toast(`#${number} is already checked out in a worktree`, { variant: "info" });
    return;
  }

  const path = suggestWorktreePath(mainRoot, headRefName);
  await ops.add({ path, detach: true });
  await ignoreWorktreesFolder(mainRoot, path);
  try {
    await ghFor(path).checkoutPr(number);
  } catch (e) {
    await ops.remove(path, true).catch(() => {});
    throw e;
  }
  openWorktreeTab({ path });
}

/**
 * The worktree left stranded on a branch that was just merged, or null.
 *
 * Called after a merge so the panel can offer to clean it up. It is worth
 * offering rather than doing: the worktree may still hold uncommitted work the
 * merge knew nothing about, and `gh pr merge --delete-branch` cannot delete the
 * local branch while a worktree holds it - so removing this is also what
 * unblocks that.
 */
export async function worktreeAfterMerge(
  repoRoot: string,
  headRefName: string,
): Promise<Worktree | null> {
  try {
    return worktreeHolding(await localWorktreeOps(repoRoot).list(), headRefName);
  } catch {
    // A merge that worked must not report a failure because the follow-up
    // question could not be asked.
    return null;
  }
}

/**
 * Remove a worktree from the repository's main one rather than from `repoRoot`.
 *
 * The removal offered after a merge is the case `mainWorktreePath` exists for:
 * the review was very likely opened from inside the worktree being removed, so
 * `repoRoot` and the target are the same folder.
 */
export async function removeWorktreeSafely(repoRoot: string, path: string): Promise<void> {
  // Forced: a merged branch's worktree routinely holds build output, and the
  // user has already confirmed this one by name. `removeWorktreeAt` still
  // resolves the main worktree and refuses one a terminal is sitting in, which
  // force cannot fix anyway.
  await removeWorktreeAt(repoRoot, path, true);
}
