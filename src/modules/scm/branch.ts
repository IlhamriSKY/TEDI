/**
 * The branch a working directory is on, cached per (transport, path).
 *
 * The Workspaces panel labels every terminal row with its folder's branch,
 * which means asking about the same repository once per pane - and several
 * panes in one repo is the normal case, not the exception. So the answer is
 * cached and de-duplicated here: one `git branch` per directory per TTL, no
 * matter how many rows are looking at it.
 *
 * Anything that isn't a branch caches `null` and the panel then renders no
 * branch line at all: a directory outside any repository (`require_root` on the
 * Rust side rejects it), a detached HEAD (`--show-current` prints nothing), an
 * SSH pane whose session is not up, or a remote whose box has no git.
 */
import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { create } from "zustand";

/** One cheap plumbing call. `branch` is on the Rust runner's whitelist, and
 *  `--show-current` needs no parsing: one line, or nothing. */
const ARGS = ["branch", "--show-current"];

/**
 * How long an answer is trusted. Long enough that re-rendering the panel (an
 * agent's status flips several times a second) doesn't spawn git processes,
 * short enough that a `git switch` in the terminal shows up on its own.
 */
const TTL_MS = 15_000;

/** Timestamp per key, so a cached `null` expires like any other answer. */
const fetchedAt = new Map<string, number>();
/** Keys with a call in flight, so N rows in one repo make one call, not N. */
const inFlight = new Set<string>();

const keyFor = (cwd: string, sessionId?: number) => `${sessionId ?? "local"}:${cwd}`;

/**
 * Whether a key is due for a git call. The whole point of this module, and the
 * one piece worth testing on its own: get it wrong in one direction and the
 * panel spawns a git process per row per render, in the other and a branch
 * switch never shows up. `at` is undefined for a key never fetched.
 */
export function shouldFetch(now: number, at: number | undefined, inFlight: boolean): boolean {
  if (inFlight) return false;
  return at === undefined || now - at >= TTL_MS;
}

type BranchState = { branches: Record<string, string | null> };

const useBranchStore = create<BranchState>(() => ({ branches: {} }));

/**
 * Fetch `cwd`'s branch unless a fresh answer is already cached or a call is
 * already out for it. `sessionId` routes through the SSH runner instead of the
 * local one, so a remote pane reads the branch on the box it is actually on.
 */
export async function ensureBranch(cwd: string, sessionId?: number): Promise<void> {
  const key = keyFor(cwd, sessionId);
  if (!shouldFetch(Date.now(), fetchedAt.get(key), inFlight.has(key))) return;
  inFlight.add(key);
  try {
    const raw =
      sessionId === undefined
        ? await invoke<string>("git_run", { repoPath: cwd, args: ARGS })
        : await invoke<string>("ssh_git", { id: sessionId, cwd, args: ARGS });
    setBranch(key, raw.trim() || null);
  } catch {
    // Not a repo, no git, or a dead session. All of them mean "no branch to
    // show" - the panel is decorating a row, so a failure is never surfaced.
    setBranch(key, null);
  } finally {
    inFlight.delete(key);
    fetchedAt.set(key, Date.now());
  }
}

function setBranch(key: string, branch: string | null) {
  useBranchStore.setState((s) =>
    s.branches[key] === branch ? s : { branches: { ...s.branches, [key]: branch } },
  );
}

/**
 * The branch for one row's working directory, or null while unknown / not a
 * repo. Undefined `cwd` (an editor or browser leaf) never asks.
 *
 * The effect deliberately has NO dependency array: the TTL guard above makes a
 * re-run a Map lookup, and piggybacking on the renders the panel already does
 * is what lets a visible row pick up a branch switch without this module owning
 * a timer that would poll git in the background forever.
 */
export function useGitBranch(cwd: string | undefined, sessionId?: number): string | null {
  const key = cwd ? keyFor(cwd, sessionId) : null;
  const branch = useBranchStore((s) => (key ? (s.branches[key] ?? null) : null));
  useEffect(() => {
    if (cwd) void ensureBranch(cwd, sessionId);
  });
  return branch;
}
