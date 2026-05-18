import { create } from "zustand";
import { recordFileMutation } from "../lib/checkpoint";
import { native } from "../lib/native";

export type QueuedEdit = {
  id: string;
  /** Tool that produced the queued mutation. */
  kind: "write_file" | "edit" | "multi_edit" | "create_directory";
  path: string;
  /** Original file content (empty for new files / create_directory). */
  originalContent: string;
  /** Proposed full content after edit (empty for create_directory). */
  proposedContent: string;
  /** True if the file did not exist when the edit was queued. */
  isNewFile: boolean;
  /** Human-readable description, used for create_directory. */
  description?: string;
};

type PlanState = {
  active: boolean;
  queue: QueuedEdit[];
  toggle: () => void;
  enable: () => void;
  disable: () => void;
  enqueue: (q: QueuedEdit) => void;
  removeOne: (id: string) => void;
  clear: () => void;
  /** Apply queued edits in order. Pass the active sessionId so applied
   *  mutations get recorded into its restore checkpoint - without this,
   *  plan-applied files would be invisible to the restore action. */
  applyAll: (sessionId: string | null) => Promise<{ id: string; ok: boolean; error?: string }[]>;
};

let nextId = 1;
export function newQueuedEditId(): string {
  return `q-${Date.now().toString(36)}-${(nextId++).toString(36)}`;
}

export const usePlanStore = create<PlanState>((set, get) => ({
  active: false,
  queue: [],
  toggle: () => set((s) => ({ active: !s.active, queue: s.active ? [] : s.queue })),
  enable: () => set({ active: true }),
  disable: () => set({ active: false, queue: [] }),
  enqueue: (q) => set((s) => ({ queue: [...s.queue, q] })),
  removeOne: (id) => set((s) => ({ queue: s.queue.filter((q) => q.id !== id) })),
  clear: () => set({ queue: [] }),
  async applyAll(sessionId) {
    const items = get().queue;
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const q of items) {
      try {
        if (q.kind === "create_directory") {
          if (sessionId) {
            // Mirror the create_directory tool: only record if the dir
            // didn't already exist (otherwise restore would delete a
            // pre-existing dir of the user's).
            let alreadyExists = false;
            try {
              await native.readDir(q.path);
              alreadyExists = true;
            } catch {
              // doesn't exist - safe to record
            }
            if (!alreadyExists) {
              recordFileMutation(sessionId, q.path, { kind: "create-dir" });
            }
          }
          await native.createDir(q.path);
        } else {
          if (sessionId) {
            if (q.isNewFile) {
              recordFileMutation(sessionId, q.path, {
                kind: "create-file",
                writtenContent: q.proposedContent,
              });
            } else {
              recordFileMutation(sessionId, q.path, {
                kind: "modify",
                originalContent: q.originalContent,
                writtenContent: q.proposedContent,
              });
            }
          }
          await native.writeFile(q.path, q.proposedContent);
        }
        results.push({ id: q.id, ok: true });
      } catch (e) {
        results.push({ id: q.id, ok: false, error: String(e) });
      }
    }
    set({ queue: [] });
    return results;
  },
}));
