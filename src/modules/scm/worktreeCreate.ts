/**
 * Create a worktree and start working in it, from wherever it was asked for.
 *
 * Its own module because TWO surfaces offer this now: Source Control's header
 * menu, and the Workspaces panel's project row. The thing it exists to hold is
 * the rule that cost three separate bugs during the build - every worktree
 * WRITE resolves the MAIN worktree first and works from there, never trusting
 * the root it was handed. Both callers pass whichever checkout the user is
 * looking at, and once anyone has opened a worktree that is routinely a linked
 * one; creating from inside it would nest the new worktree under it and save
 * the setup command under its path instead of the repository's.
 *
 * Resolving `mainWorktreePath` in HERE rather than in each caller is what makes
 * that unrepeatable: a second caller cannot forget a step it never performs.
 *
 * Not part of `worktrees.ts`, which stays free of the toast and the tab bridge
 * so `scripts/scm/worktree-verify.ts` can load it on its own.
 */
import { toast } from "@/components/ui/toast";
import { basename } from "@/lib/path";
import { agentToolKind, type CliAgent } from "@/modules/terminal/lib/cliAgents";
import { openWorktreeTab } from "./worktreeBridge";
import {
  ignoreWorktreesFolder,
  localWorktreeOps,
  mainWorktreePath,
  type Worktree,
} from "./worktrees";
import { setSetupCommand, worktreeLaunchLine } from "./worktreeSetup";

/** What the create dialog submits. */
export type WorktreeCreate = {
  /** Absolute folder to create. */
  path: string;
  branch: string;
  /** Create `branch` rather than checking out an existing one. */
  create: boolean;
  /** Only meaningful when `create`: what the new branch starts from. */
  startPoint?: string;
  /**
   * The setup command as TYPED, whether or not it runs this time. Always the
   * text to remember for the repository.
   */
  setup: string;
  /**
   * Whether to run `setup` in the new worktree.
   *
   * Separate from `setup` on purpose. Sending `""` for "do not run it" made the
   * two facts one, and the save path treats an empty command as "forget this
   * repository's command" - so turning the toggle off for a single worktree
   * silently deleted a setup command the user had saved.
   */
  runSetup: boolean;
  /** Agent to start after setup, or null for a plain shell. */
  agent: CliAgent | null;
};

/**
 * Add the worktree, make its folder invisible to git, remember the setup
 * command for the repository, and open the worktree as a terminal tab.
 *
 * `repoRoot` is any checkout of the repository; the main one is resolved from
 * it. Returns the repository's worktrees AFTER the add, so a caller holding a
 * list in state can drop it in rather than issuing a second `worktree list`.
 *
 * Throws on a failed add, so the dialog can keep the form open and show why.
 */
export async function createWorktreeAndOpen(
  repoRoot: string,
  { path, branch, create, startPoint, setup, runSetup, agent }: WorktreeCreate,
): Promise<Worktree[]> {
  const mainRoot = mainWorktreePath(await localWorktreeOps(repoRoot).list(), repoRoot);
  const ops = localWorktreeOps(mainRoot);
  await ops.add({ path, branch, create, startPoint });
  // After the add, because the folder it writes into is what the add creates.
  // Never fatal: the worktree exists either way.
  await ignoreWorktreesFolder(mainRoot, path);
  // The typed text is remembered whether or not it runs this time: an empty
  // command is how the store is told to FORGET one, so saving `""` for a
  // skipped run would delete the repository's setup command.
  await setSetupCommand(mainRoot, setup);
  openWorktreeTab({
    path,
    // The PROJECT's name. `path` is named after the branch, so a tab left to
    // label itself would drop the only word saying which project this is.
    title: basename(mainRoot),
    command: worktreeLaunchLine(runSetup ? setup : "", agent?.command ?? ""),
    tool: agent ? agentToolKind(agent) : null,
  });
  toast(`Created worktree ${branch}`, { variant: "success" });
  return ops.list();
}
