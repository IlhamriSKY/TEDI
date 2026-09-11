/**
 * Git worktrees: several checkouts of one repository, each on its own branch,
 * each in its own folder.
 *
 * WHY THE PANEL CARES. A worktree is what lets two agents work at once. One
 * checkout means one HEAD, so a second agent has to stash, switch, and hand the
 * tree back; two worktrees means two independent working directories sharing
 * one object store and one set of refs, and neither agent can see the other's
 * half-finished edit. That is the whole feature - everything below is the
 * bookkeeping around `git worktree`.
 *
 * WHY THERE IS ALMOST NOTHING HERE. Source Control already follows a worktree
 * without knowing the word: every git command in this module resolves its
 * repository through `rev-parse --show-toplevel`, which inside a linked
 * worktree answers with THAT worktree. So status, diff, staging, commit, push
 * and `gh` were all correct in a worktree before this file existed. What was
 * missing is only the ability to create, list and remove them, and the two
 * places where the one checkout assumption leaks (see `worktreeHolding`).
 *
 * Composed in TypeScript over the `git_run` argument-vector runner, the way the
 * pull-request feature is composed over `gh_run`, so `scripts/scm/worktree-verify.ts`
 * can drive the real sequencing over a recording runner instead of a live repo.
 */
import { invoke } from "@tauri-apps/api/core";
import { joinPath, toForwardSlash } from "@/lib/path";

/** One entry of `git worktree list --porcelain`. */
export type Worktree = {
  /** Absolute path, forward slashes. Git already prints it that way on Windows. */
  path: string;
  /** Commit the worktree is on. Empty for a bare repository, which has no HEAD. */
  head: string;
  /** Short branch name, or null when detached or bare. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  /** `git worktree lock`ed: prune and remove refuse it until it is unlocked. */
  locked: boolean;
  /** Git's reason for the lock, when one was given. */
  lockReason: string | null;
  /** Registered but its folder is gone; `git worktree prune` would drop it. */
  prunable: boolean;
  /**
   * The repository's ORIGINAL checkout - the one holding `.git` - which git
   * always prints first and which cannot be removed. Not a git field: it is
   * that position, named.
   */
  main: boolean;
};

/**
 * Folder new worktrees are created under, relative to the repository root.
 *
 * Inside the repository rather than beside it so a worktree cannot outlive the
 * project it belongs to, and so the whole set travels with one folder. The cost
 * is that git would report it as untracked, which {@link WORKTREES_IGNORE} pays.
 */
const WORKTREES_DIR = ".worktrees";

/**
 * Written to `<repo>/.worktrees/.gitignore` right after the first worktree is
 * created. `*` excludes everything under the folder INCLUDING this file, so the
 * whole thing is invisible to `git status` and to `git add .` with no read, no
 * dedupe, and nothing appended to a `.gitignore` the user has to commit.
 *
 * `.git/info/exclude` would also work and touches no tracked tree, but it needs
 * a read-modify-write plus a `--git-common-dir` resolution to be correct from
 * inside a linked worktree. This is one write that is right from anywhere.
 */
const WORKTREES_IGNORE = "*\n";

/**
 * A branch name as a folder name. Only the separator needs handling: git allows
 * `feat/x`, which as a path would nest a folder, and `invalidBranchName` has
 * already refused every other character a path could not hold.
 */
export function worktreeSlug(branch: string): string {
  return branch
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\//g, "-");
}

/** Where a new worktree for `branch` goes by default. */
export function suggestWorktreePath(repoRoot: string, branch: string): string {
  return joinPath(joinPath(toForwardSlash(repoRoot), WORKTREES_DIR), worktreeSlug(branch));
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * Records are blank-line separated and every line after `worktree` is an
 * attribute, present only when it applies: `branch` XOR `detached` XOR `bare`,
 * and `locked` / `prunable` each with an OPTIONAL reason (`locked` alone is a
 * lock with no reason given, which is why the reason cannot be required).
 *
 * A `worktree` line also closes the previous record, so a stream missing its
 * blank separators still parses into the right number of entries rather than
 * one merged one.
 */
export function parseWorktrees(raw: string): Worktree[] {
  const out: Worktree[] = [];
  let cur: Worktree | null = null;

  const flush = () => {
    if (cur) out.push(cur);
    cur = null;
  };

  for (const line of raw.split("\n")) {
    const l = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!l.trim()) {
      flush();
      continue;
    }
    const sp = l.indexOf(" ");
    const key = sp === -1 ? l : l.slice(0, sp);
    const value = sp === -1 ? "" : l.slice(sp + 1);
    if (key === "worktree") {
      flush();
      cur = {
        // A path may contain spaces, so the value is the whole rest of the
        // line - splitting on whitespace would truncate "has space" to "has".
        path: toForwardSlash(value),
        head: "",
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
        main: out.length === 0,
      };
      continue;
    }
    if (!cur) continue;
    switch (key) {
      case "HEAD":
        cur.head = value;
        break;
      case "branch":
        cur.branch = value.replace(/^refs\/heads\//, "");
        break;
      case "detached":
        cur.detached = true;
        break;
      case "bare":
        cur.bare = true;
        break;
      case "locked":
        cur.locked = true;
        cur.lockReason = value || null;
        break;
      case "prunable":
        cur.prunable = true;
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

/**
 * The worktree that has `branch` checked out, or null.
 *
 * This is the one lookup the rest of Source Control needs, because a branch
 * checked out somewhere else is the only way a worktree is visible to the
 * single-checkout parts of the panel: `git checkout` refuses it ("already used
 * by worktree at ..."), and so does `git branch -d`. Rather than letting either
 * fail with a raw git error, both ask this first.
 *
 * `self` is the worktree the panel is currently pointed at; its own branch is
 * not a conflict, so it is excluded.
 */
export function worktreeHolding(
  list: Worktree[],
  branch: string,
  self?: string | null,
): Worktree | null {
  const selfPath = self ? toForwardSlash(self) : null;
  return list.find((w) => w.branch === branch && w.path !== selfPath) ?? null;
}

/**
 * The repository's main worktree, which is where every worktree WRITE has to
 * run from.
 *
 * Not a preference. `git worktree remove` on the worktree git is standing in
 * half-succeeds on Windows: it deregisters the worktree, then fails to delete
 * the folder it is inside ("Permission denied"), leaving a directory on disk
 * that `git worktree list` no longer knows about and that `remove` will not
 * touch again ("is not a working tree"). Run from the main worktree the same
 * removal is clean, even with a live shell still sitting in the folder.
 *
 * This matters here because the panel follows whichever checkout the focused
 * terminal is in, so "the repository the panel is pointed at" is routinely the
 * very worktree being removed - and, after merging a PR from its own worktree,
 * that is the most likely case rather than an unlucky one.
 *
 * `fallback` covers the moment before a list has landed. A repository with no
 * linked worktrees IS its own main one, so the fallback is right there too.
 */
export function mainWorktreePath(list: Worktree[], fallback: string): string {
  return list.find((w) => w.main)?.path ?? fallback;
}

type Runner = (args: string[]) => Promise<string>;

/** What a new worktree checks out. */
export type WorktreeAdd = {
  /** Absolute or repo-relative folder to create. */
  path: string;
  /** The branch to be on. Omitted only with `detach`. */
  branch?: string;
  /** Create `branch` rather than checking out an existing one. */
  create?: boolean;
  /** Where a created branch starts from (a branch, tag or SHA). HEAD when absent. */
  startPoint?: string;
  /**
   * Start on a detached HEAD rather than a branch.
   *
   * What the pull-request flow needs: the PR's head branch may not exist
   * locally, and for a fork it does not exist on this remote at all, so there
   * is nothing to name here. Creating the worktree detached and letting
   * `gh pr checkout` run INSIDE it hands the whole fetch-and-name problem back
   * to gh, which already owns it.
   */
  detach?: boolean;
};

export type WorktreeOps = {
  list(): Promise<Worktree[]>;
  add(input: WorktreeAdd): Promise<void>;
  /** `force` is required by git once the worktree has modified or untracked
   *  files, which is the normal state of one an agent has been working in. */
  remove(path: string, force?: boolean): Promise<void>;
  /** Drop registrations whose folder is gone. */
  prune(): Promise<void>;
};

/**
 * Exported for `scripts/scm/worktree-verify.ts`, which drives it over a
 * recording runner. {@link localWorktreeOps} is what the panel uses.
 */
export function makeWorktreeOps(run: Runner): WorktreeOps {
  return {
    list: async () => parseWorktrees(await run(["worktree", "list", "--porcelain"])),
    add: async ({ path, branch, create, startPoint, detach }) => {
      // `--` is not available here: `git worktree add` reads its own path and
      // commit-ish positionally and rejects the separator. The path is built by
      // `suggestWorktreePath` or typed into a dialog that validates it, and the
      // branch has already been through `invalidBranchName`, so neither can
      // arrive looking like an option.
      if (detach) {
        await run(["worktree", "add", "--detach", path]);
        return;
      }
      if (!branch) throw new Error("A worktree needs a branch, or --detach.");
      await run(
        create
          ? ["worktree", "add", path, "-b", branch, ...(startPoint ? [startPoint] : [])]
          : ["worktree", "add", path, branch],
      );
    },
    remove: async (path, force) => {
      await run(["worktree", "remove", ...(force ? ["--force"] : []), path]);
    },
    prune: async () => {
      await run(["worktree", "prune"]);
    },
  };
}

/** Worktree operations on the repository containing `repoPath`. */
export function localWorktreeOps(repoPath: string): WorktreeOps {
  return makeWorktreeOps((args) => invoke<string>("git_run", { repoPath, args }));
}

/**
 * Make the worktree folder invisible to git. Called after a create, not before:
 * `git worktree add` is what brings `.worktrees/` into existence, and writing
 * into a folder that does not exist yet would fail.
 *
 * Only fires for worktrees actually under `<repo>/.worktrees`, so a path the
 * user typed somewhere else is left entirely alone. Failure is swallowed: the
 * worktree itself was created, and a repo that then shows one untracked folder
 * is a cosmetic problem, not a reason to report the create as failed.
 */
export async function ignoreWorktreesFolder(repoRoot: string, worktreePath: string): Promise<void> {
  const dir = joinPath(toForwardSlash(repoRoot), WORKTREES_DIR);
  if (!toForwardSlash(worktreePath).startsWith(`${dir}/`)) return;
  try {
    await invoke<void>("fs_write_file", {
      path: joinPath(dir, ".gitignore"),
      content: WORKTREES_IGNORE,
    });
  } catch {
    // Read-only checkout, or a .gitignore the user made read-only on purpose.
  }
}

/**
 * The worktree path out of git's "already used by worktree at '<path>'" refusal,
 * or null when the error is something else.
 *
 * Matched rather than pre-checked in only ONE direction: the panel asks
 * {@link worktreeHolding} first and never issues a checkout it expects to fail,
 * but a worktree created in a terminal a second ago is not in the list the menu
 * loaded, so the refusal still has to turn into an offer to open it.
 *
 * Covers both wordings, because git uses a different one per command:
 * `fatal: 'x' is already used by worktree at '<path>'` for checkout, and
 * `error: cannot delete branch 'x' used by worktree at '<path>'` for delete.
 */
function worktreeFromError(err: unknown): string | null {
  const m = /used by worktree at '([^']+)'/.exec(String(err));
  return m ? toForwardSlash(m[1]) : null;
}

/**
 * Actionable text for git's second-checkout refusal, or null when the error is
 * about something else.
 *
 * Here rather than in the panel's own `friendlyGitError` because BOTH need it
 * and they cannot share that one: the branch-delete refusal is rendered inside
 * `BranchMenu`, which `SourceControlPanel` imports, so reaching back up for the
 * translator would be a cycle. This is the piece they both reach down to.
 *
 * Says forcing will not help, because it will not: `-D` refuses a branch held
 * by a worktree exactly as `-d` does, and the delete dialog's second button
 * offers a force that would otherwise look like the way out.
 */
export function worktreeConflictMessage(err: unknown): string | null {
  const at = worktreeFromError(err);
  if (!at) return null;
  return `That branch is checked out in another worktree (${at}). Open that worktree, or remove it first - forcing will not help.`;
}
