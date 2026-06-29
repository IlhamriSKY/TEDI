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
 *  edits since are preserved per-path. Other files still revert. */
export async function restoreCheckpoint(sessionId: string): Promise<RestoreOutcome | null> {
  const cp = checkpoints.get(sessionId);
  if (!cp) return null;

  const failures: { path: string; error: string }[] = [];
  const skipped: RestoreOutcome["skipped"] = [];
  let restoredCount = 0;

  // sequential disk writes with running restoredCount/failures tallies
  for (const [path, snap] of cp.files) {
    try {
      if (snap.kind === "modify") {
        const cur = await native.readFile(path);
        if (cur.kind !== "text") {
          // Deleted, became binary, or exceeded the read cap. File diverged;
          // skip to preserve the user's state.
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
            // User overwrote or replaced the file; preserve.
            skipped.push({ path, reason: "user-modified" });
            continue;
          }
          needsDelete = true;
        } catch {
          // File already missing; matches the restore goal.
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

      if (snap.kind === "delete") {
        // Recreate the file only if nothing exists at the path again.
        try {
          await native.readFilePortion(path, 0, 1);
          // Something is at the path now (user recreated it); preserve.
          skipped.push({ path, reason: "user-modified" });
          continue;
        } catch {
          // Still missing — safe to recreate.
        }
        await native.writeFile(path, snap.content);
        restoredCount++;
        continue;
      }

      if (snap.kind === "move") {
        // Undo by renaming the destination back to the source. The backend
        // refuses if `from` is occupied or `to` is gone; treat that as a
        // diverged state and leave it alone.
        try {
          await native.rename(snap.to, snap.from);
          restoredCount++;
        } catch {
          skipped.push({ path, reason: "user-modified" });
        }
        continue;
      }

      // create-dir: delete only if still empty. Anything inside is preserved.
      try {
        const entries = await native.readDir(path);
        if (entries.length > 0) {
          skipped.push({ path, reason: "dir-non-empty" });
          continue;
        }
        await native.deletePath(path);
      } catch {
        // Directory already gone; nothing to undo.
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
