import { native } from "./native";

/**
 * Per-session "restore-to-last-checkpoint" support.
 *
 * Semantics: ONE checkpoint per session, always pointing at the most recent
 * user turn. When the user sends a new message, the previous checkpoint is
 * discarded (only "undo my last command" is supported - not arbitrary
 * history travel). Mutating tools (`edit`, `multi_edit`, `write_file`,
 * `create_directory`) record file originals into the active checkpoint
 * before the on-disk write happens. On restore we replay those originals
 * and trim chat history back to before the user's last message.
 *
 * Memory: snapshots live in-process only. They're bounded by the # of files
 * touched in the current turn (typically ≤10), with full original content
 * for each (capped by the read-file 200KB safety net). A new turn drops the
 * old checkpoint immediately - no growth over a long session.
 *
 * Not persisted to disk: checkpoints are intentionally ephemeral. Restoring
 * across app restarts would require an on-disk content store with its own
 * GC story; the user-visible feature is "undo the agent's last turn", which
 * is satisfied with in-memory.
 */

export type FileSnapshot =
  | {
      /** File existed before the agent touched it. Restore writes
       *  `originalContent` back, but ONLY if the on-disk content still
       *  matches `writtenContent` - i.e. the user hasn't manually edited
       *  the file since the agent last wrote to it. */
      kind: "modify";
      originalContent: string;
      writtenContent: string;
    }
  | {
      /** File didn't exist before the agent created it via write_file.
       *  Restore deletes it, but only if the on-disk content still matches
       *  `writtenContent` - preserves manual user edits made afterwards. */
      kind: "create-file";
      writtenContent: string;
    }
  | {
      /** Directory created by the agent. Restore deletes it ONLY if it's
       *  empty at restore time - preserves anything the user (or another
       *  process) put into it afterwards. */
      kind: "create-dir";
    };

export type Checkpoint = {
  /** Message count just BEFORE the user's message was appended. Restoring
   *  trims `messages.slice(0, baselineMessageCount)` - everything from the
   *  user turn onwards (user msg + assistant streams + tool results) is
   *  dropped together. */
  baselineMessageCount: number;
  createdAt: number;
  /** Files mutated since this checkpoint opened. `originalContent` is
   *  captured on the FIRST touch and never updated; `writtenContent` is
   *  refreshed on every subsequent mutation so user-modify detection
   *  compares against the agent's latest write. */
  files: Map<string, FileSnapshot>;
};

const checkpoints = new Map<string, Checkpoint>();

// Minimal external-store contract for `useSyncExternalStore`. Each mutation
// bumps `version` and notifies subscribers - the UI re-reads via the
// getters below.
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
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
  // Drop any prior checkpoint outright - only the LAST is retained.
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
  // Path already tracked: preserve `originalContent` from the FIRST touch
  // (so restore reverts all the way back), but refresh `writtenContent` so
  // the user-modify check at restore-time compares against what the agent
  // most recently wrote.
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
  // Kind mismatch (e.g. agent created a dir then wrote inside it as a
  // separate path) - keep the earliest snapshot, don't transition.
}

export function getCheckpoint(sessionId: string): Checkpoint | null {
  return checkpoints.get(sessionId) ?? null;
}

export type RestoreOutcome = {
  baselineMessageCount: number;
  /** Files where the recorded change was successfully reverted. */
  restoredCount: number;
  /** Files left alone because the user (or another process) had modified
   *  them since the agent wrote - preserving manual edits is more important
   *  than full revert. Paths are surfaced so the UI can hint at them. */
  skipped: { path: string; reason: "user-modified" | "dir-non-empty" }[];
  failures: { path: string; error: string }[];
};

/** Replay the recorded originals and return the trim point. The checkpoint
 *  is consumed (deleted) regardless of partial failures - leaving a stale
 *  one around would record further mutations into a checkpoint the UI no
 *  longer surfaces.
 *
 *  Files are reverted ONLY if their on-disk content still matches what the
 *  agent last wrote. If the user has manually edited a file in the
 *  meantime, that file is skipped (their changes win). This applies
 *  per-path - other files in the checkpoint are still reverted. */
export async function restoreCheckpoint(sessionId: string): Promise<RestoreOutcome | null> {
  const cp = checkpoints.get(sessionId);
  if (!cp) return null;

  const failures: { path: string; error: string }[] = [];
  const skipped: RestoreOutcome["skipped"] = [];
  let restoredCount = 0;

  for (const [path, snap] of cp.files) {
    try {
      if (snap.kind === "modify") {
        const cur = await native.readFile(path);
        if (cur.kind !== "text") {
          // Either deleted, became binary, or grew past the read cap.
          // Any of those means the file diverged from what the agent
          // wrote; skip to preserve the user's intent.
          skipped.push({ path, reason: "user-modified" });
          continue;
        }
        if (cur.content !== snap.writtenContent) {
          skipped.push({ path, reason: "user-modified" });
          continue;
        }
        await native.writeFile(path, snap.originalContent);
        restoredCount++;
        continue;
      }

      if (snap.kind === "create-file") {
        let needsDelete = false;
        try {
          const cur = await native.readFile(path);
          if (cur.kind !== "text" || cur.content !== snap.writtenContent) {
            // User has overwritten or replaced the file - preserve.
            skipped.push({ path, reason: "user-modified" });
            continue;
          }
          needsDelete = true;
        } catch {
          // File already missing - state matches the restore goal.
        }
        if (needsDelete) {
          try {
            await native.deletePath(path);
          } catch (e) {
            failures.push({ path, error: String(e) });
            continue;
          }
        }
        restoredCount++;
        continue;
      }

      // create-dir: only delete if it's still empty. Anything the user
      // put inside should be preserved.
      try {
        const entries = await native.readDir(path);
        if (entries.length > 0) {
          skipped.push({ path, reason: "dir-non-empty" });
          continue;
        }
        await native.deletePath(path);
      } catch {
        // Directory already gone - nothing to undo.
      }
      restoredCount++;
    } catch (e) {
      failures.push({ path, error: String(e) });
    }
  }

  const baselineMessageCount = cp.baselineMessageCount;
  checkpoints.delete(sessionId);
  notify();
  return { baselineMessageCount, restoredCount, skipped, failures };
}
