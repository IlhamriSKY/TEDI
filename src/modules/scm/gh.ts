import { invoke } from "@tauri-apps/api/core";

/**
 * Pull requests and stacked pull requests, driven through the GitHub CLI.
 *
 * GitHub's stacked PRs are a chain of ordinary PRs: the bottom one targets the
 * trunk, and every one above targets the branch of the PR below it. The parts
 * that are not ordinary - tracking the chain, cascading a rebase through it,
 * and the stack object on github.com - belong to GitHub's own `gh-stack`
 * extension, so this module drives it instead of reimplementing any of that
 * against the REST API. Same shape as `api.ts`: one `run` (an argument vector
 * to `gh_run`), so `scripts/gh-stack-verify.ts` can drive the real sequencing
 * over a recording runner.
 *
 * Local repositories only. `gh` runs on this machine against this working
 * tree, so the panel's SSH mode has no pull-request view.
 */

/** Exactly what `gh_run` returns when the binary is missing (see `gh.rs`). An
 *  OS "not found" message differs per platform, so the Rust side normalises it
 *  to one token rather than leaving every caller to guess at the wording. */
export const GH_NOT_FOUND = "gh-not-found";

/** One branch of `gh stack view --json`. */
export type StackBranch = {
  name: string;
  isCurrent: boolean;
  isMerged: boolean;
  isQueued: boolean;
  needsRebase: boolean;
};

/** `gh stack view --json`. `branches` runs bottom (nearest the trunk) to top. */
export type StackView = {
  trunk: string;
  currentBranch: string;
  branches: StackBranch[];
};

/** The `gh pr list` fields the view reads. */
export type PullRequest = {
  number: number;
  title: string;
  url: string;
  /** "OPEN" | "CLOSED" | "MERGED". */
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
};

/**
 * One rendered stack layer: the branch, the PR it became once submitted, and
 * the branch it sits on top of.
 */
export type StackRow = StackBranch & {
  pr: PullRequest | null;
  /** The branch this layer targets: the trunk for the bottom layer. */
  parent: string;
};

/** What the panel is allowed to offer, decided once when the view opens. */
export type GhStatus = {
  installed: boolean;
  authenticated: boolean;
  /** GitHub's `gh-stack` extension. Stack operations need it; a plain PR does not. */
  stackExtension: boolean;
};

export type CreatePrInput = {
  /** Branch the PR merges INTO. Another feature branch here is what makes the
   *  PR a stacked one - GitHub derives the stack from this chain. */
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
};

/** Resolves with stdout, rejects with whatever explained a non-zero exit. */
export type GhRunner = (args: string[]) => Promise<string>;

/**
 * `gh stack view --json` prints a plain "not part of a stack" line on stdout
 * AND EXITS 0 when the repository has no stack, so the exit code says nothing
 * and the payload has to be recognised. Anything that is not the object we
 * asked for means "no stack", not an error to show the user.
 */
export function parseStackView(raw: string): StackView | null {
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  try {
    const v = JSON.parse(text) as Partial<StackView>;
    if (typeof v.trunk !== "string" || !Array.isArray(v.branches)) return null;
    return {
      trunk: v.trunk,
      currentBranch: typeof v.currentBranch === "string" ? v.currentBranch : "",
      branches: v.branches,
    };
  } catch {
    return null;
  }
}

/**
 * Join the stack to its pull requests, top layer first - the order
 * `gh stack view` prints, and the order the stack reads on github.com.
 *
 * The `base` field in the stack JSON is a commit SHA rather than a ref, so a
 * layer's parent comes from its position: the bottom sits on the trunk, and
 * every layer above sits on the one below it.
 */
export function stackRows(view: StackView, prs: PullRequest[]): StackRow[] {
  const byHead = new Map(prs.map((p) => [p.headRefName, p]));
  return view.branches
    .map((b, i) => ({
      ...b,
      pr: byHead.get(b.name) ?? null,
      parent: i === 0 ? view.trunk : (view.branches[i - 1]?.name ?? view.trunk),
    }))
    .reverse();
}

/** Open PRs that are not layers of the stack, so neither list repeats the other. */
export function loosePrs(view: StackView | null, prs: PullRequest[]): PullRequest[] {
  if (!view) return prs;
  const inStack = new Set(view.branches.map((b) => b.name));
  return prs.filter((p) => !inStack.has(p.headRefName));
}

/**
 * The URL `gh pr create` printed. It is not always the only line: gh puts
 * warnings and the occasional update notice on stdout too, and handing one of
 * those to the browser opens a garbage tab instead of the new pull request.
 */
export function prUrlFrom(stdout: string): string {
  const lines = stdout.split("\n").map((l) => l.trim());
  return lines.reverse().find((l) => l.startsWith("http")) ?? "";
}

/** Map a gh failure to something the user can act on; unknown errors pass through. */
export function friendlyGhError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const lower = raw.toLowerCase();
  if (raw.includes(GH_NOT_FOUND)) {
    return "GitHub CLI (gh) is not installed.";
  }
  if (lower.includes("not logged in") || lower.includes("gh auth login")) {
    return "Not signed in to GitHub. Run `gh auth login` in a terminal.";
  }
  if (lower.includes("unknown command") && lower.includes("stack")) {
    return "The gh-stack extension is not installed.";
  }
  if (lower.includes("no default remote repository") || lower.includes("not a github repository")) {
    return "This repository has no GitHub remote.";
  }
  if (lower.includes("already exists")) {
    return "A pull request for this branch already exists.";
  }
  if (lower.includes("rebase conflict") || lower.includes("conflict")) {
    return "Rebase conflict - run `gh stack rebase` in a terminal to resolve it.";
  }
  if (lower.includes("must be a collaborator") || lower.includes("permission")) {
    return "Your GitHub account cannot write to this repository.";
  }
  return raw || "gh failed.";
}

/**
 * Every gh call the Pull Requests view can make. Composed from argument
 * vectors so the whole surface is one allowlisted transport.
 */
export function makeGh(run: GhRunner) {
  const ok = async (args: string[]) => {
    await run(args);
  };

  return {
    /**
     * Which of the three preconditions hold. Read once when the view opens
     * rather than on the status poll: each answer is a subprocess and none of
     * them changes while the user works.
     */
    async probe(): Promise<GhStatus> {
      const [auth, ext] = await Promise.allSettled([
        run(["auth", "status"]),
        run(["extension", "list"]),
      ]);
      // Only a missing binary is reported as not-installed. An unauthenticated
      // gh still runs, and saying "not installed" there would send the user to
      // download something they already have.
      const missing = auth.status === "rejected" && String(auth.reason).includes(GH_NOT_FOUND);
      return {
        installed: !missing,
        authenticated: auth.status === "fulfilled",
        stackExtension: ext.status === "fulfilled" && ext.value.includes("gh-stack"),
      };
    },

    /**
     * The GitHub repository this working tree points at, or null when it is
     * not on GitHub yet. Answers "is there anything to publish" without
     * guessing from a branch's upstream, which a fresh branch also lacks.
     */
    async repoInfo(): Promise<{ nameWithOwner: string; url: string } | null> {
      try {
        const raw = await run(["repo", "view", "--json", "nameWithOwner,url"]);
        const v = JSON.parse(raw) as { nameWithOwner?: string; url?: string };
        return v.nameWithOwner && v.url ? { nameWithOwner: v.nameWithOwner, url: v.url } : null;
      } catch {
        return null;
      }
    },

    /**
     * Create the repository on GitHub from this working tree and push it.
     * Resolves with the new repository's URL.
     *
     * `--source=.` adopts the existing local repo (adding `origin`) instead of
     * cloning a fresh one somewhere else, and `--push` means the user does not
     * then have to find a separate "publish" button.
     */
    async createRepo(name: string, isPrivate: boolean, description: string): Promise<string> {
      const args = [
        "repo",
        "create",
        name,
        "--source=.",
        "--remote=origin",
        "--push",
        isPrivate ? "--private" : "--public",
      ];
      if (description.trim()) args.push("--description", description.trim());
      const out = await run(args);
      return prUrlFrom(out) || `https://github.com/${name}`;
    },

    /** The repository's default branch - the base a first PR should target. */
    async defaultBranch(): Promise<string> {
      const raw = await run(["repo", "view", "--json", "defaultBranchRef"]);
      const name = (JSON.parse(raw) as { defaultBranchRef?: { name?: string } }).defaultBranchRef
        ?.name;
      return name || "main";
    },

    /** The current stack, or null when this repository has none. */
    async stack(): Promise<StackView | null> {
      return parseStackView(await run(["stack", "view", "--json"]));
    },

    async prs(limit = 50): Promise<PullRequest[]> {
      const raw = await run([
        "pr",
        "list",
        "--state",
        "open",
        "--limit",
        String(limit),
        "--json",
        "number,title,url,state,isDraft,headRefName,baseRefName",
      ]);
      return JSON.parse(raw || "[]") as PullRequest[];
    },

    installStackExtension: () => ok(["extension", "install", "github/gh-stack"]),

    /** Resolves with the new pull request's URL, which is all gh prints. */
    async createPr({ base, head, title, body, draft }: CreatePrInput): Promise<string> {
      const args = [
        "pr",
        "create",
        "--base",
        base,
        // Passing --head keeps gh from deciding on its own where to push. The
        // branch is published by the panel's existing push path first, so gh
        // only has to open the PR.
        "--head",
        head,
        "--title",
        title,
        "--body",
        body,
      ];
      if (draft) args.push("--draft");
      return prUrlFrom(await run(args));
    },

    /** Start a stack at `branch`, adopting it when it already exists. */
    initStack: (branch: string, base?: string) =>
      ok(["stack", "init", ...(base ? ["--base", base] : []), branch]),

    /** Add a layer on top of the current one. */
    addToStack: (branch: string) => ok(["stack", "add", branch]),

    /**
     * Push every branch and create or update the stack's PRs.
     *
     * `--auto` is not optional: without it gh opens a full-screen editor, and
     * with no terminal attached that is a hang, not a prompt. `--auto` alone
     * creates drafts, so a ready-for-review stack has to say `--open`.
     */
    submitStack: (draft: boolean) =>
      ok(["stack", "submit", "--auto", ...(draft ? [] : ["--open"])]),

    /** Fetch, cascade-rebase onto updated parents, push, and relink on GitHub. */
    syncStack: () => ok(["stack", "sync"]),

    /** Merge the stack bottom-up in one operation. */
    mergeStack: () => ok(["stack", "merge", "--yes"]),

    /** Check out a stack layer, keeping gh's local tracking pointed at it. */
    checkoutStackBranch: (branch: string) => ok(["stack", "checkout", branch]),

    /** Check out a PR by number. Handles a fork's branch, which a plain
     *  `git checkout` of the head name would not find. */
    checkoutPr: (number: number) => ok(["pr", "checkout", String(number)]),
  };
}

export type GhOps = ReturnType<typeof makeGh>;

/** Drive gh against the workspace repository containing `repoPath`. */
export function ghFor(repoPath: string): GhOps {
  return makeGh((args) => invoke<string>("gh_run", { repoPath, args }));
}
