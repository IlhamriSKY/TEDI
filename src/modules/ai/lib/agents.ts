import { LazyStore } from "@tauri-apps/plugin-store";

export type AgentIconId = "coder" | "architect" | "reviewer" | "security" | "designer" | "spark";

export type Agent = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon: AgentIconId;
  builtIn: boolean;
};

// One built-in persona: Polaris, the orchestrator. The project is focused on
// orchestration, so Polaris handles the whole lifecycle - learn, read, design,
// build, test, audit - by delegating to the sub-agent roster rather than being
// split across many personas. Users can still create their own custom agents.
export const BUILTIN_AGENTS: readonly Agent[] = [
  {
    id: "builtin:polaris",
    name: "Polaris",
    description:
      "Orchestrator. Learns, designs, builds, tests, and audits by delegating to sub-agents and driving the task to completion.",
    icon: "spark",
    builtIn: true,
    instructions: `You are Polaris, the primary orchestrator. You own the task end to end and drive it to completion - you do not stop at "should work"; you verify, then finish. You can take on anything - learning and reading the codebase, designing, implementing, testing, and auditing - and you do it by delegating to sub-agents and synthesizing their results.
- Work from the goal, not a recipe. Decompose the work, then run independent parts in parallel.
- When sub-agents are on, route each kind of work to its agent:
  - learn / read / locate code -> \`comet\`
  - third-party libraries and dependencies -> \`nebula\`
  - design, hard debugging, architecture, security or performance trade-offs, self-review and audit -> \`nova\`
  - clarify an ambiguous or risky request before planning -> \`orbit\`
  - review a plan or proposed change for executability -> \`eclipse\`
  - implement, refactor, or run tests end to end -> the autonomous \`odyssey\` worker (it edits files and runs commands)
  Then synthesize their summaries yourself.
- Keep your own context clean: hand large searches and parallelizable work to sub-agents instead of doing everything inline.
- Match effort to the task: do small, single-file, or trivial work inline - delegation has a cost. Be terse; the approval card is the confirmation.`,
  },
] as const;

const STORE_PATH = "tedi-agents.json";
const KEY_CUSTOM = "customAgents";
const KEY_ACTIVE = "activeAgentId";
const KEY_BUILTIN_OVERRIDES = "builtinAgentOverrides";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export type BuiltinOverrides = Record<string, Agent>;

export type LoadedAgents = {
  custom: Agent[];
  activeId: string;
  builtinOverrides: BuiltinOverrides;
};

export async function loadAgents(): Promise<LoadedAgents> {
  // One IPC roundtrip via entries() instead of three sequential get()s.
  const entries = await store.entries();
  let custom: Agent[] | undefined;
  let activeId: string | undefined;
  let builtinOverrides: BuiltinOverrides | undefined;
  for (const [k, v] of entries) {
    if (k === KEY_CUSTOM) custom = v as Agent[];
    else if (k === KEY_ACTIVE) activeId = v as string;
    else if (k === KEY_BUILTIN_OVERRIDES) builtinOverrides = v as BuiltinOverrides;
  }
  return {
    custom: custom ?? [],
    activeId: activeId ?? BUILTIN_AGENTS[0].id,
    builtinOverrides: builtinOverrides ?? {},
  };
}

export async function saveCustomAgents(custom: Agent[]): Promise<void> {
  await store.set(KEY_CUSTOM, custom);
  await store.save();
}

export async function saveActiveAgentId(id: string): Promise<void> {
  await store.set(KEY_ACTIVE, id);
  await store.save();
}

export async function saveBuiltinOverrides(overrides: BuiltinOverrides): Promise<void> {
  await store.set(KEY_BUILTIN_OVERRIDES, overrides);
  await store.save();
}

export function newAgentId(): string {
  return `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Built-in agents with any user overrides applied. */
export function effectiveBuiltins(overrides: BuiltinOverrides): Agent[] {
  return BUILTIN_AGENTS.map((a) => (overrides[a.id] ? { ...overrides[a.id], builtIn: true } : a));
}
