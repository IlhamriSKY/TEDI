import { create } from "zustand";
import { LazyStore } from "@tauri-apps/plugin-store";
import { listen, emit, type UnlistenFn } from "@tauri-apps/api/event";
import { SUBAGENTS, type SubagentDef, READ_ONLY_TOOLS } from "../agents/registry";

const STORE_PATH = "tedi-subagents.json";
const KEY_CUSTOM = "customSubagents";
const KEY_ENABLED = "enabledCustomIds";
const CHANGED_EVENT = "tedi://ai-subagents-changed";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/** Module-scoped guard to prevent double-listen across hydrate() calls. */
let _unlisten: UnlistenFn | null = null;

/** Combined save to avoid double event emission. */
async function _saveBoth(agents: CustomSubagentDef[], enabled: string[]): Promise<void> {
  await store.set(KEY_CUSTOM, agents);
  await store.set(KEY_ENABLED, enabled);
  await store.save();
  void emit(CHANGED_EVENT);
}

export type CustomSubagentDef = {
  id: string; // "sa-custom-<slug>"
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[]; // subset of READ_ONLY_TOOLS
  /** Optional model id; empty/undefined = same as the parent chat model. */
  model?: string;
  enabled: boolean;
};

type SubagentsState = {
  customSubagents: CustomSubagentDef[];
  enabledCustomIds: string[];
  hydrated: boolean;

  hydrate: () => Promise<void>;
  upsert: (agent: CustomSubagentDef) => Promise<void>;
  remove: (id: string) => Promise<void>;
  toggle: (id: string) => Promise<void>;
};

async function saveCustomAgents(list: CustomSubagentDef[]): Promise<void> {
  await store.set(KEY_CUSTOM, list);
  await store.save();
  void emit(CHANGED_EVENT);
}

async function saveEnabledIds(ids: string[]): Promise<void> {
  await store.set(KEY_ENABLED, ids);
  await store.save();
  void emit(CHANGED_EVENT);
}

export const useSubagentsStore = create<SubagentsState>((set, get) => ({
  customSubagents: [],
  enabledCustomIds: [],
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    const entries = await store.entries();
    const map = new Map<string, unknown>(entries);
    const custom = (map.get(KEY_CUSTOM) ?? []) as CustomSubagentDef[];
    const enabled = (map.get(KEY_ENABLED) ?? []) as string[];
    set({
      customSubagents: custom,
      enabledCustomIds: enabled,
      hydrated: true,
    });
    // Guard listen so it only registers once across all hydrate() calls.
    // Reload on any change (incl. our own echo): reload is idempotent and
    // doesn't re-emit, so there's no loop, and a sibling webview's save (e.g.
    // the Settings window) propagates here. Mirrors promptsStore.
    if (!_unlisten) {
      _unlisten = await listen(CHANGED_EVENT, async () => {
        const entries = await store.entries();
        const map = new Map<string, unknown>(entries);
        set({
          customSubagents: (map.get(KEY_CUSTOM) ?? []) as CustomSubagentDef[],
          enabledCustomIds: (map.get(KEY_ENABLED) ?? []) as string[],
        });
      });
    }
  },

  upsert: async (agent) => {
    const list = get().customSubagents;
    const idx = list.findIndex((a) => a.id === agent.id);
    const next = idx === -1 ? [...list, agent] : list.map((a) => (a.id === agent.id ? agent : a));
    set({ customSubagents: next });
    await saveCustomAgents(next);
  },

  remove: async (id) => {
    const next = get().customSubagents.filter((a) => a.id !== id);
    const enabled = get().enabledCustomIds.filter((x) => x !== id);
    set({ customSubagents: next, enabledCustomIds: enabled });
    await _saveBoth(next, enabled);
  },

  toggle: async (id) => {
    const enabled = get().enabledCustomIds;
    const next = enabled.includes(id) ? enabled.filter((x) => x !== id) : [...enabled, id];
    set({ enabledCustomIds: next });
    await saveEnabledIds(next);
  },
}));

/** Resolve all sub-agent definitions: built-in + enabled custom. */
export function getAllSubagentDefs(): Record<string, SubagentDef> {
  const state = useSubagentsStore.getState();
  const builtIn: Record<string, SubagentDef> = { ...SUBAGENTS };
  const customEntries = state.customSubagents
    .filter((a) => state.enabledCustomIds.includes(a.id))
    .map((a) => [
      a.id,
      {
        id: a.id as any,
        label: a.name,
        description: a.description,
        tools: a.tools.filter((t) => READ_ONLY_TOOLS.includes(t)),
        systemPrompt: a.systemPrompt,
        model: a.model || undefined,
      } as SubagentDef,
    ]);
  return { ...builtIn, ...Object.fromEntries(customEntries) };
}

/** Check if a sub-agent id is built-in. */
export function isBuiltinSubagentId(id: string): boolean {
  return id in SUBAGENTS;
}
