import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  clampPrompt,
  loadPromptOverrides,
  savePromptOverrides,
  type PromptId,
  type PromptOverride,
  type PromptOverrides,
} from "../lib/prompts";

const CHANGED_EVENT = "tedi://ai-prompts-changed";

type PromptsState = {
  hydrated: boolean;
  overrides: PromptOverrides;
  hydrate: () => Promise<void>;
  /** Merge a partial override for one prompt id. Empty fields are dropped so
   *  the entry collapses back to the built-in default when nothing remains. */
  setOverride: (id: PromptId, patch: PromptOverride) => void;
  /** Drop an entire override, restoring every default for that id. */
  reset: (id: PromptId) => void;
};

let initialized = false;

function broadcast(): void {
  void emit(CHANGED_EVENT);
}

/** Strip empty fields; return undefined when the entry carries no real data. */
function normalize(entry: PromptOverride): PromptOverride | undefined {
  const out: PromptOverride = {};
  if (entry.prompt && entry.prompt.trim().length > 0) out.prompt = clampPrompt(entry.prompt);
  if (entry.model && entry.model.trim().length > 0) {
    out.model = entry.model;
    // Provider only travels with a model; dropped when the model clears.
    if (entry.modelProvider) out.modelProvider = entry.modelProvider;
  }
  if (typeof entry.temperature === "number" && Number.isFinite(entry.temperature)) {
    out.temperature = entry.temperature;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export const usePromptsStore = create<PromptsState>((set, get) => ({
  hydrated: false,
  overrides: {},
  hydrate: async () => {
    if (initialized) return;
    initialized = true;
    const overrides = await loadPromptOverrides();
    set({ overrides, hydrated: true });

    void listen(CHANGED_EVENT, async () => {
      const fresh = await loadPromptOverrides();
      set({ overrides: fresh });
    });
  },
  setOverride: (id, patch) => {
    const current = get().overrides[id] ?? {};
    const merged = normalize({ ...current, ...patch });
    const next: PromptOverrides = { ...get().overrides };
    if (merged) next[id] = merged;
    else delete next[id];
    set({ overrides: next });
    void savePromptOverrides(next).then(broadcast);
  },
  reset: (id) => {
    if (!get().overrides[id]) return;
    const next: PromptOverrides = { ...get().overrides };
    delete next[id];
    set({ overrides: next });
    void savePromptOverrides(next).then(broadcast);
  },
}));

/** Synchronous snapshot of the override map for non-React call sites
 *  (agent.ts, runSubagent.ts, autocomplete, commitAi). Reads the hydrated
 *  store; returns `{}` before hydration so callers fall back to defaults. */
export function getPromptOverrides(): PromptOverrides {
  return usePromptsStore.getState().overrides;
}
