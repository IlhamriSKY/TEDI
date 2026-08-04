import { native } from "./native";

/**
 * Per-session restore-to-last-checkpoint.
 *
 * One checkpoint per session, pointing at the most recent user turn. Sending
 * a new message drops the previous checkpoint; only the last turn is undoable.
 * Mutating tools (`edit`, `multi_edit`, `write_file`, `create_directory`,
 * `move_file`, `copy_file`, `delete_file`) record originals before the on-disk
 * write, so restore can replay them and trim chat history to before the user's
 * last message. Sub-agent edits (the autonomous `odyssey` worker) run under
 * the parent session's context, so they record into the SAME checkpoint and are
 * undoable too.
 *
 * Not undoable (no snapshot): `replace_in_files` (multi-file regex; stage git
 * first) and any side effects of `bash_run` / `bash_background` (guarded by the
 * shell denylist instead). Restore is conservative: a file reverts only if
 * on-disk still matches the agent's last write, so manual edits made after are
 * always preserved.
 *
 * Snapshots live in-process only. They're bounded by files touched this turn
 * (typically <= 10), each capped by the read-file 200KB limit. Not persisted
 * across app restarts.
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

const checkpoints = new Map<string, Checkpoint>();

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
  // Drop any prior checkpoint; only the latest is retained.
  checkpoints.set(sessionId, {
    baselineMessageCount,
    createdAt: Date.now(),
    files: new Map(),
  });
  notify();
}

export function discardCheckpoint(sessionId: string): void {
  if (checkpoints.delete(sessionId)) notify();
}

export function recordFileMutation(sessionId: string, path: string, snapshot: FileSnapshot): void {
  const cp = checkpoints.get(sessionId);
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

export function getCheckpoint(sessionId: string): Checkpoint | null {
  return checkpoints.get(sessionId) ?? null;
}

export type RestoreOutcome = {
  baselineMessageCount: number;
  /** Files where the recorded change was successfully reverted. */
  restoredCount: number;
  /** Files left alone because they were modified since the agent wrote.
   *  Preserving manual edits beats full revert. */
  skipped: { path: string; reason: "user-modified" | "dir-non-empty" }[];
  failures: { path: string; error: string }[];
};

/** Replay recorded originals and return the trim point. The checkpoint is
 *  consumed regardless of partial failures.
 *  Files revert only if on-disk still matches the agent's last write; user
 *  edits since are preserved per-path. Other files still revert.
 *
 *  Restored in dependency-safe phases: move undos first (free a `from` path a
 *  later modify reverts against), then file ops in parallel, then create-dir
 *  undos last (deepest first) so a parent isn't kept as non-empty before its
 *  child files are removed. */
export async function restoreCheckpoint(sessionId: string): Promise<RestoreOutcome | null> {
  const cp = checkpoints.get(sessionId);
  if (!cp) return null;

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

  const baselineMessageCount = cp.baselineMessageCount;
  // Keep the checkpoint when any file could not be restored. Clearing it here
  // made a partial failure irreversible because Retry no longer had snapshots.
  if (failures.length === 0) checkpoints.delete(sessionId);
  notifyDirectly();
  return { baselineMessageCount, restoredCount, skipped, failures };
}
