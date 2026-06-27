import { LazyStore } from "@tauri-apps/plugin-store";

/**
 * User-editable system prompts for every hard-coded AI agent in TEDI.
 *
 * The chat personas (Coder, Architect, …) already have their own override
 * system in `agents.ts`. THIS module covers the other, previously-uneditable
 * prompts: the core agent prompt (full + compact), the plan-mode appendix, the
 * four read-only sub-agents, the inline-completion prompt, and the
 * commit-message prompt.
 *
 * Every entry is hidden behind a "Show all" toggle in settings, since editing
 * any of them changes deep agent behaviour.
 *
 * Built-in defaults live at their original call sites; this module only stores
 * OVERRIDES keyed by a stable id, plus optional per-agent model/temperature
 * where meaningful. The resolver returns `override ?? default` so an empty
 * store == stock behaviour. Persisted in its own LazyStore so it can't collide
 * with agents or preferences.
 */

/** Stable ids for every editable prompt. Used as override-map keys. */
export type PromptId =
  | "core"
  | "core-lite"
  | "plan-mode"
  | "orchestration"
  | "subagent:explore"
  | "subagent:code-review"
  | "subagent:security"
  | "subagent:general"
  | "autocomplete"
  | "commit";

/** Which knobs a given prompt entry exposes beyond the prompt text itself. */
export type PromptCapabilities = {
  /** Per-agent model override (sub-agents only). */
  model?: boolean;
  /** Per-agent sampling temperature override. Opt-in: only sent when set, so
   *  reasoning models that reject sampling params stay untouched by default. */
  temperature?: boolean;
};

/** One override entry. All fields optional; an absent field falls back to the
 *  built-in default. `model: null` / `temperature: null` mean "unset". */
export type PromptOverride = {
  prompt?: string;
  model?: string | null;
  temperature?: number | null;
};

export type PromptOverrides = Partial<Record<PromptId, PromptOverride>>;

/** Defensive cap on a stored prompt so a pathological paste can't inflate every
 *  turn unbounded. Generous - real prompts are a few KB. */
export const MAX_PROMPT_CHARS = 32_000;

/** UI metadata for each editable prompt. Defaults are NOT stored here (they
 *  live at the call sites to avoid copy-paste drift); the Settings UI imports
 *  the real default constants and pairs them with these entries by id. */
export type PromptMeta = {
  id: PromptId;
  label: string;
  description: string;
  /** Grouping shown in the Settings UI. */
  group: "Main agent" | "Sub-agents" | "Other";
  capabilities: PromptCapabilities;
};

export const PROMPT_META: readonly PromptMeta[] = [
  {
    id: "core",
    label: "Core system prompt",
    description: "The main agent's instructions. Used for capable models.",
    group: "Main agent",
    capabilities: { temperature: true },
  },
  {
    id: "core-lite",
    label: "Core system prompt (compact)",
    description: "Trimmed variant sent to fast/cheap models to save tokens.",
    group: "Main agent",
    capabilities: {},
  },
  {
    id: "plan-mode",
    label: "Plan mode appendix",
    description: "Appended to the system prompt while plan mode is active.",
    group: "Main agent",
    capabilities: {},
  },
  {
    id: "orchestration",
    label: "Orchestration appendix",
    description:
      "Appended whenever sub-agents are enabled; makes broad explore/review/audit tasks auto-decompose into parallel sub-agents with a synthesis step.",
    group: "Main agent",
    capabilities: {},
  },
  {
    id: "subagent:explore",
    label: "Explore sub-agent",
    description: "Read-only codebase explorer spawned via run_subagent.",
    group: "Sub-agents",
    capabilities: { model: true, temperature: true },
  },
  {
    id: "subagent:code-review",
    label: "Code-review sub-agent",
    description: "Reviews changed code for bugs, perf, security.",
    group: "Sub-agents",
    capabilities: { model: true, temperature: true },
  },
  {
    id: "subagent:security",
    label: "Security sub-agent",
    description: "Audits a scope for security risks.",
    group: "Sub-agents",
    capabilities: { model: true, temperature: true },
  },
  {
    id: "subagent:general",
    label: "General research sub-agent",
    description: "Multi-step research across many files.",
    group: "Sub-agents",
    capabilities: { model: true, temperature: true },
  },
  {
    id: "autocomplete",
    label: "Inline completion",
    description: "Fill-in-the-middle prompt for editor autocomplete.",
    group: "Other",
    capabilities: { temperature: true },
  },
  {
    id: "commit",
    label: "Commit message",
    description: "Generates the Conventional Commit message in Source Control.",
    group: "Other",
    capabilities: {},
  },
] as const;

const STORE_PATH = "tedi-prompts.json";
const KEY_OVERRIDES = "promptOverrides";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export async function loadPromptOverrides(): Promise<PromptOverrides> {
  const v = await store.get<PromptOverrides>(KEY_OVERRIDES);
  return v ?? {};
}

export async function savePromptOverrides(overrides: PromptOverrides): Promise<void> {
  await store.set(KEY_OVERRIDES, overrides);
  await store.save();
}

/** Clamp a user prompt to the stored cap, trimming trailing whitespace. */
export function clampPrompt(text: string): string {
  const t = text.replace(/\s+$/, "");
  return t.length > MAX_PROMPT_CHARS ? t.slice(0, MAX_PROMPT_CHARS) : t;
}

/** Resolve the effective prompt text: a non-empty override wins, else default. */
export function resolvePromptText(
  overrides: PromptOverrides,
  id: PromptId,
  builtinDefault: string,
): string {
  const o = overrides[id]?.prompt;
  return o && o.trim().length > 0 ? o : builtinDefault;
}

/** Resolve the optional model override (sub-agents). Null/empty -> fallback. */
export function resolvePromptModel(
  overrides: PromptOverrides,
  id: PromptId,
  fallbackModelId: string,
): string {
  const m = overrides[id]?.model;
  return m && m.trim().length > 0 ? m : fallbackModelId;
}

/** Resolve the optional temperature override. Returns undefined when unset so
 *  the caller can omit the param entirely (reasoning-model safe). */
export function resolvePromptTemperature(
  overrides: PromptOverrides,
  id: PromptId,
): number | undefined {
  const t = overrides[id]?.temperature;
  return typeof t === "number" && Number.isFinite(t) ? t : undefined;
}
