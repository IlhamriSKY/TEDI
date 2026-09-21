import { native } from "./native";

/**
 * Per-session restore checkpoints, one per user turn, newest last. Rewinding to
 * an earlier prompt undoes every turn after it, newest first, so each file
 * walks back through the states the agent left it in. The last
 * `MAX_CHECKPOINTS` turns are kept; an older turn can no longer be rewound.
 *
 * Mutating fs tools record originals before the write. Sub-agent edits share the
 * parent session, so they land in the SAME checkpoint. NOT undoable:
 * `replace_in_files` and `bash_run` side effects - stage git first.
 *
 * Restore is conservative: a file reverts only if on-disk still matches the
 * agent's last write, so later manual edits survive. In-process only, not
 * persisted across restarts.
 */

export type FileSnapshot =
  | {
      /** File existed before the agent touched it. Restore writes
       *  `originalContent` back, but only if on-disk still matches
       *  `writtenContent` (no manual edits since the agent's last write). */
      kind: "modify";
      originalContent: string;
      writtenContent: string;
    }
  | {
      /** File created by write_file. Restore deletes it only if on-disk
       *  still matches `writtenContent`; preserves manual edits made after. */
      kind: "create-file";
      writtenContent: string;
    }
  | {
      /** Directory created by the agent. Restore deletes it only if empty
       *  at restore time; preserves anything dropped into it afterwards. */
      kind: "create-dir";
    }
  | {
      /** File deleted by delete_file. Restore recreates it with the captured
       *  text content, but only if the path is still empty. Directories and
       *  binary/oversized files carry no content, so they aren't recorded and
       *  thus aren't undoable. */
      kind: "delete";
      content: string;
    }
  | {
      /** Path moved/renamed by move_file. Keyed by the destination. Restore
       *  renames `to` back to `from` when `from` is free and `to` still
       *  exists. */
      kind: "move";
      from: string;
      to: string;
    };

export type Checkpoint = {
  /** Message count just before the user's message was appended. Restore
   *  trims `messages.slice(0, baselineMessageCount)`. */
  baselineMessageCount: number;
  createdAt: number;
  /** Files mutated since this checkpoint opened. `originalContent` is
   *  captured on the first touch; `writtenContent` is refreshed on every
   *  subsequent mutation so user-modify detection compares the latest write. */
  files: Map<string, FileSnapshot>;
};

/** Enough to walk back a long /goal run without holding every file forever. */
const MAX_CHECKPOINTS = 20;

const checkpoints = new Map<string, Checkpoint[]>();

// External-store contract for `useSyncExternalStore`. Each mutation bumps
// `version` and notifies subscribers; UI re-reads via the getters below.
let version = 0;
const listeners = new Set<() => void>();

// Batched notify: multiple synchronous mutations flush as a single notification
// via the microtask queue. Restores (which are async) call notifyDirectly.
let _notifyScheduled = false;

function notify(): void {
  if (_notifyScheduled) return;
  _notifyScheduled = true;
  queueMicrotask(() => {
    _notifyScheduled = false;
    version++;
    for (const l of listeners) l();
  });
}

function notifyDirectly(): void {
  version++;
  for (const l of listeners) l();
}

export function subscribeCheckpoints(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCheckpointsVersion(): number {
  return version;
}

export function openCheckpoint(sessionId: string, baselineMessageCount: number): void {
  // A checkpoint at or past the new baseline points into messages that are gone
  // (a restore or a compaction trimmed them), so it can no longer be rewound to.
  const stack = (checkpoints.get(sessionId) ?? []).filter(
    (c) => c.baselineMessageCount < baselineMessageCount,
  );
  stack.push({ baselineMessageCount, createdAt: Date.now(), files: new Map() });
  if (stack.length > MAX_CHECKPOINTS) stack.shift();
  checkpoints.set(sessionId, stack);
  notify();
}

export function discardCheckpoint(sessionId: string): void {
  if (checkpoints.delete(sessionId)) notify();
}

export function recordFileMutation(sessionId: string, path: string, snapshot: FileSnapshot): void {
  const cp = checkpoints.get(sessionId)?.at(-1);
  if (!cp) return;
  const existing = cp.files.get(path);
  if (!existing) {
    cp.files.set(path, snapshot);
    notify();
    return;
  }
  // Already tracked: keep `originalContent` from the first touch but refresh
  // `writtenContent` so user-modify detection compares the latest agent write.
  if (existing.kind === "modify" && snapshot.kind === "modify") {
    existing.writtenContent = snapshot.writtenContent;
    notify();
    return;
  }
  if (existing.kind === "create-file" && snapshot.kind === "create-file") {
    existing.writtenContent = snapshot.writtenContent;
    notify();
    return;
  }
  // Kind mismatch (e.g. created a dir then wrote inside): keep the earliest.
}

/** The newest checkpoint: the turn in progress or the last one sent. */
export function getCheckpoint(sessionId: string): Checkpoint | null {
  return checkpoints.get(sessionId)?.at(-1) ?? null;
}

/** How many turns a rewind to the prompt at `messageIndex` undoes, or 0 if none can. */
export function turnsSince(sessionId: string, messageIndex: number): number {
  const stack = checkpoints.get(sessionId) ?? [];
  const i = stack.findIndex((c) => c.baselineMessageCount === messageIndex);
  return i < 0 ? 0 : stack.length - i;
}

/** Files a rewind of the newest `turns` turns would try to revert. */
export function filesSince(sessionId: string, turns: number): number {
  const paths = new Set<string>();
  for (const c of (checkpoints.get(sessionId) ?? []).slice(-turns)) {
    for (const p of c.files.keys()) paths.add(p);
  }
  return paths.size;
}

export type RestoreOutcome = {
  /** Where history is trimmed to: the oldest turn fully undone. Null when a
   *  failure stopped the walk before even the newest turn was complete. */
  baselineMessageCount: number | null;
  /** Files where the recorded change was successfully reverted. */
  restoredCount: number;
  /** Files left alone because they were modified since the agent wrote.
   *  Preserving manual edits beats full revert. */
  skipped: { path: string; reason: "user-modified" | "dir-non-empty" }[];
  failures: { path: string; error: string }[];
};

/** Undo the newest `turns` turns, newest first, and return the trim point.
 *  A turn is consumed only once all its files are back; on a failure the walk
 *  stops there, that turn and the older ones stay for a retry, and the outcome
 *  trims only what WAS undone. Null when there is nothing to undo.
 *  Files revert only if on-disk still matches the agent's last write; user
 *  edits since are preserved per-path. Other files still revert.
 *
 *  Restored in dependency-safe phases: move undos first (free a `from` path a
 *  later modify reverts against), then file ops in parallel, then create-dir
 *  undos last (deepest first) so a parent isn't kept as non-empty before its
 *  child files are removed. */
export async function restoreCheckpoints(
  sessionId: string,
  turns = 1,
): Promise<RestoreOutcome | null> {
  const stack = checkpoints.get(sessionId);
  if (!stack || stack.length === 0 || turns < 1) return null;
  let outcome: RestoreOutcome | null = null;
  const skipped: RestoreOutcome["skipped"] = [];
  let restoredCount = 0;
  for (let n = 0; n < turns && stack.length > 0; n++) {
    const cp = stack[stack.length - 1];
    const one = await restoreOneCheckpoint(cp);
    restoredCount += one.restoredCount;
    skipped.push(...one.skipped);
    if (one.failures.length > 0) {
      notifyDirectly();
      return {
        baselineMessageCount: outcome?.baselineMessageCount ?? null,
        restoredCount,
        skipped,
        failures: one.failures,
      };
    }
    stack.pop();
    outcome = {
      baselineMessageCount: cp.baselineMessageCount,
      restoredCount,
      skipped,
      failures: [],
    };
  }
  if (stack.length === 0) checkpoints.delete(sessionId);
  notifyDirectly();
  return outcome;
}

async function restoreOneCheckpoint(cp: Checkpoint): Promise<RestoreOutcome> {
  type RestoreResult =
    | { path: string; restored: true }
    | { path: string; skipped: { reason: "user-modified" | "dir-non-empty" } }
    | { path: string; failed: string };

  async function restoreOne(path: string, snap: FileSnapshot): Promise<RestoreResult> {
    try {
      if (snap.kind === "modify") {
        const cur = await native.readFile(path);
        if (cur.kind !== "text") {
          return { path, skipped: { reason: "user-modified" } };
        }
        if (cur.content !== snap.writtenContent) {
          return { path, skipped: { reason: "user-modified" } };
        }
        await native.writeFile(path, snap.originalContent);
        return { path, restored: true };
      }

      if (snap.kind === "create-file") {
        let needsDelete = false;
        try {
          const cur = await native.readFile(path);
          if (cur.kind !== "text" || cur.content !== snap.writtenContent) {
            return { path, skipped: { reason: "user-modified" } };
          }
          needsDelete = true;
        } catch {
          // File already missing; matches the restore goal.
        }
        if (needsDelete) {
          try {
            await native.deletePath(path);
          } catch (e) {
            return { path, failed: String(e) };
          }
        }
        return { path, restored: true };
      }

      if (snap.kind === "delete") {
        try {
          await native.readFilePortion(path, 0, 1);
          return { path, skipped: { reason: "user-modified" } };
        } catch {
          // Still missing — safe to recreate.
        }
        await native.writeFile(path, snap.content);
        return { path, restored: true };
      }

      if (snap.kind === "move") {
        try {
          await native.rename(snap.to, snap.from);
          return { path, restored: true };
        } catch {
          return { path, skipped: { reason: "user-modified" } };
        }
      }

      // create-dir: delete only if still empty.
      try {
        const entries = await native.readDir(path);
        if (entries.length > 0) {
          return { path, skipped: { reason: "dir-non-empty" } };
        }
        await native.deletePath(path);
      } catch {
        // Directory already gone.
      }
      return { path, restored: true };
    } catch (e) {
      return { path, failed: String(e) };
    }
  }

  // Dependency-safe phased restore (see doc above). Entries are NOT fully
  // independent: a move's `from` can be a modify's path, and a create-dir's
  // child can be a separate create-file entry.
  const entries = Array.from(cp.files.entries());
  const moves = entries.filter(([, s]) => s.kind === "move");
  const files = entries.filter(
    ([, s]) => s.kind === "modify" || s.kind === "create-file" || s.kind === "delete",
  );
  const dirs = entries
    .filter(([, s]) => s.kind === "create-dir")
    .sort((a, b) => b[0].length - a[0].length); // deepest path first

  const results: RestoreResult[] = [];
  results.push(...(await Promise.all(moves.map(([path, snap]) => restoreOne(path, snap)))));
  results.push(...(await Promise.all(files.map(([path, snap]) => restoreOne(path, snap)))));
  for (const [path, snap] of dirs) results.push(await restoreOne(path, snap));

  const failures: { path: string; error: string }[] = [];
  const skipped: RestoreOutcome["skipped"] = [];
  let restoredCount = 0;
  for (const r of results) {
    if ("restored" in r) restoredCount++;
    else if ("skipped" in r) skipped.push({ path: r.path, reason: r.skipped.reason });
    else failures.push({ path: r.path, error: r.failed });
  }

  return { baselineMessageCount: cp.baselineMessageCount, restoredCount, skipped, failures };
}
