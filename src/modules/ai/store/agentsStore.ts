import { emit, listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import {
  BUILTIN_AGENTS,
  effectiveBuiltins,
  loadAgents,
  newAgentId,
  saveActiveAgentId,
  saveBuiltinOverrides,
  saveCustomAgents,
  type Agent,
  type BuiltinOverrides,
} from "../lib/agents";

const CHANGED_EVENT = "tedi://ai-agents-changed";

type AgentsState = {
  hydrated: boolean;
  customAgents: Agent[];
  builtinOverrides: BuiltinOverrides;
  activeId: string;
  /** All agents: built-ins (with overrides applied) followed by custom. */
  all: () => Agent[];
  /** Built-ins with any user overrides applied. */
  builtins: () => Agent[];
  hydrate: () => Promise<void>;
  setActiveId: (id: string) => void;
  /** Upsert any agent. Built-ins are stored as overrides; the rest go in customAgents. */
  upsert: (agent: Agent) => void;
  /** Remove a custom agent (no-op on built-ins). */
  remove: (id: string) => void;
  /** Drop the override for a built-in agent, restoring the default. */
  resetBuiltin: (id: string) => void;
  /** True if a built-in id has a saved override. */
  hasOverride: (id: string) => boolean;
};

let initialized = false;

function broadcast(): void {
  void emit(CHANGED_EVENT);
}

function isBuiltinId(id: string): boolean {
  return BUILTIN_AGENTS.some((a) => a.id === id);
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  hydrated: false,
  customAgents: [],
  builtinOverrides: {},
  activeId: BUILTIN_AGENTS[0].id,
  all: () => [...effectiveBuiltins(get().builtinOverrides), ...get().customAgents],
  builtins: () => effectiveBuiltins(get().builtinOverrides),
  hydrate: async () => {
    if (initialized) return;
    initialized = true;
    const { custom, activeId, builtinOverrides } = await loadAgents();
    set({
      customAgents: custom,
      activeId,
      builtinOverrides,
      hydrated: true,
    });

    void listen(CHANGED_EVENT, async () => {
      const fresh = await loadAgents();
      set({
        customAgents: fresh.custom,
        activeId: fresh.activeId,
        builtinOverrides: fresh.builtinOverrides,
      });
    });
  },
  setActiveId: (id) => {
    set({ activeId: id });
    void saveActiveAgentId(id).then(broadcast);
  },
  upsert: (agent) => {
    if (isBuiltinId(agent.id)) {
      const next: BuiltinOverrides = {
        ...get().builtinOverrides,
        [agent.id]: { ...agent, builtIn: true },
      };
      set({ builtinOverrides: next });
      void saveBuiltinOverrides(next).then(broadcast);
      return;
    }
    const list = get().customAgents;
    const idx = list.findIndex((a) => a.id === agent.id);
    const next = idx === -1 ? [...list, agent] : list.map((a) => (a.id === agent.id ? agent : a));
    set({ customAgents: next });
    void saveCustomAgents(next).then(broadcast);
  },
  remove: (id) => {
    if (isBuiltinId(id)) return;
    const list = get().customAgents.filter((a) => a.id !== id);
    set({ customAgents: list });
    let active = get().activeId;
    if (active === id) {
      active = BUILTIN_AGENTS[0].id;
      set({ activeId: active });
      void saveActiveAgentId(active);
    }
    void saveCustomAgents(list).then(broadcast);
  },
  resetBuiltin: (id) => {
    if (!isBuiltinId(id)) return;
    if (!get().builtinOverrides[id]) return;
    const next = { ...get().builtinOverrides };
    delete next[id];
    set({ builtinOverrides: next });
    void saveBuiltinOverrides(next).then(broadcast);
  },
  hasOverride: (id) => !!get().builtinOverrides[id],
}));

export { newAgentId };
