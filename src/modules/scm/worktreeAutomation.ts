/**
 * Worktrees on the automation bridge, which is what puts them on BOTH MCP
 * transports at once.
 *
 * ONE capability, not five, and registered here rather than in each server: the
 * bridge is the single door both transports reach the app through, so this
 * function IS the stdio server's `d.worktree(...)` and the in-process server's
 * `bridge("worktree", ...)` at the same time. Adding an action costs one `case`
 * here instead of a round of plumbing in three files, and the two servers cannot
 * drift because neither of them implements anything.
 *
 * It answers with TEXT rather than an object, which is the other half of that.
 * A tool result is prose in the model's context either way, so formatting it
 * once here is both fewer tokens than pretty-printed JSON and the only way the
 * two transports are guaranteed to say the same thing.
 */
import { callBridge, registerBridge } from "@/modules/automation/bridge";
import { basename, toForwardSlash } from "@/lib/path";
import { localOps } from "./api";
import {
  localWorktreeOps,
  mainWorktreePath,
  suggestWorktreePath,
  worktreeSlug,
  type Worktree,
} from "./worktrees";
import { createWorktreeAndOpen } from "./worktreeCreate";
import { openWorktree, removeWorktreeAt } from "./worktreeBridge";
import { getSetupCommand } from "./worktreeSetup";

type WorktreeArgs = {
  action?: string;
  /** Any folder in the repository. The focused terminal's when omitted. */
  cwd?: string;
  branch?: string;
  /** add: where to put it. Defaults under `<repo>/.worktrees/<branch>`. */
  path?: string;
  /** add: what a created branch starts from. HEAD when omitted. */
  from?: string;
  /** add: one command line typed at the new worktree's prompt. */
  run?: string;
  /** remove: git refuses a worktree holding uncommitted work without this. */
  force?: boolean;
};

/** One pane as `panes` reports it. Only the fields this module reads. */
type PaneInfo = { kind?: string; active?: boolean; cwd?: string };

/**
 * The repository to act on: what the caller named, or the focused terminal's
 * folder.
 *
 * Defaulting matters more here than it looks. Without it every worktree call is
 * two round trips - `state`, then this - and the model pays for the whole pane
 * list to learn one path it could have been handed.
 */
async function repoFor(cwd?: string): Promise<string> {
  if (cwd?.trim()) return toForwardSlash(cwd.trim());
  const panes = (await callBridge("panes")) as PaneInfo[];
  const focused =
    panes.find((p) => p.active && p.kind === "terminal" && p.cwd) ??
    panes.find((p) => p.kind === "terminal" && p.cwd);
  if (!focused?.cwd) throw new Error("No terminal is open, so there is no repository to act on.");
  return toForwardSlash(focused.cwd);
}

/**
 * `<main>/x` printed as `x`; anything outside it stays absolute.
 *
 * The main worktree prints as `.` rather than repeating itself: the header line
 * above already carries its absolute path, and a tool result is tokens.
 */
function shortPath(path: string, main: string): string {
  if (path === main) return ".";
  return path.startsWith(`${main}/`) ? path.slice(main.length + 1) : path;
}

/** One line per worktree. `*` marks the main one, which cannot be removed. */
function render(list: Worktree[], main: string): string {
  if (list.length === 0) return "(not a git repository)";
  const lines = list.map((w) => {
    const name = w.branch ?? (w.bare ? "(bare)" : `(detached ${w.head.slice(0, 7)})`);
    const flags = [w.locked && "locked", w.prunable && "MISSING"].filter(Boolean).join(" ");
    return `${w.main ? "*" : " "} ${name}\t${shortPath(w.path, main)}${flags ? `\t${flags}` : ""}`;
  });
  return `${basename(main)} (${main})\n${lines.join("\n")}`;
}

/**
 * Whether `branch` already exists locally, so the caller does not have to say.
 *
 * Costs one `git branch` and saves a failed round trip: `worktree add -b` on an
 * existing branch and `worktree add <branch>` on a missing one both fail, and an
 * agent that guessed wrong has to read the error and try the other one.
 */
async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    return (await localOps(repo).branches()).some((b) => !b.remote && b.name === branch);
  } catch {
    return false;
  }
}

async function worktree(rawArgs: WorktreeArgs = {}): Promise<string> {
  const args = rawArgs ?? {};
  const action = args.action ?? "list";
  const repo = await repoFor(args.cwd);
  const list = await localWorktreeOps(repo).list();
  // Every WRITE runs from the MAIN worktree; see `mainWorktreePath`. The caller
  // hands us whichever checkout it is looking at, which is routinely a linked
  // one once anyone has opened a worktree at all.
  const main = mainWorktreePath(list, repo);

  switch (action) {
    case "list":
      return render(list, main);

    case "add": {
      const branch = args.branch?.trim();
      if (!branch) throw new Error("`add` needs a `branch`.");
      const held = list.find((w) => w.branch === branch);
      if (held) return `${branch} is already checked out at ${held.path}.`;
      const path = args.path?.trim()
        ? toForwardSlash(args.path.trim())
        : suggestWorktreePath(main, branch);
      // The repository's saved setup command is passed back UNCHANGED, never
      // "". An empty string is how the store is told to forget it, so a worktree
      // made over MCP would otherwise wipe a command the user had saved.
      const setup = await getSetupCommand(main);
      const fresh = await createWorktreeAndOpen(main, {
        path,
        branch,
        create: !(await branchExists(main, branch)),
        startPoint: args.from?.trim() || undefined,
        setup,
        runSetup: setup !== "",
        // `agent` is the field that means "typed at the prompt and NOT
        // remembered", which is exactly what an ad-hoc `run` is.
        agent: args.run?.trim()
          ? { id: "mcp", name: "mcp", command: args.run.trim(), builtIn: false }
          : null,
      });
      return `Created ${branch} at ${path} and opened it in a new tab.\n${render(fresh, main)}`;
    }

    case "remove": {
      // Either identifier, the same as `open`. The schema offers both, and a
      // caller that has just read `list` has the BRANCH in hand more often than
      // the path - refusing it there was a promise the code did not keep.
      const target = args.path?.trim() || args.branch?.trim();
      if (!target)
        throw new Error("`remove` needs the `path` or `branch` of the worktree (see `list`).");
      const hit = list.find(
        (w) =>
          toForwardSlash(target) === w.path ||
          shortPath(w.path, main) === target ||
          w.branch === target,
      );
      if (!hit) throw new Error(`No worktree at ${target}. Call \`list\` first.`);
      if (hit.main) throw new Error("The main worktree holds .git and cannot be removed.");
      await removeWorktreeAt(main, hit.path, args.force);
      return `Removed ${hit.branch ?? hit.path}.`;
    }

    case "prune":
      await localWorktreeOps(main).prune();
      return render(await localWorktreeOps(main).list(), main);

    case "open": {
      const target = args.path?.trim() || args.branch?.trim();
      if (!target) throw new Error("`open` needs a `path` or a `branch` (see `list`).");
      const hit = list.find(
        (w) =>
          toForwardSlash(target) === w.path ||
          shortPath(w.path, main) === target ||
          w.branch === target ||
          (w.branch !== null && worktreeSlug(w.branch) === target),
      );
      if (!hit) throw new Error(`No worktree matching ${target}. Call \`list\` first.`);
      openWorktree(hit, list);
      return `Opened ${hit.branch ?? hit.path} in a new tab.`;
    }

    default:
      throw new Error(`Unknown worktree action "${action}".`);
  }
}

registerBridge({ worktree });
