import { LazyStore } from "@tauri-apps/plugin-store";
import { subscribeSkillPathChanges } from "./skillCache";

/**
 * Persistent metadata for installed skills: version, source SHA, install date,
 * dependencies, etc. Stored in its own LazyStore so it can't collide with
 * prompts/agents/sessions stores.
 */

const STORE_PATH = "tedi-skills-state.json";
const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export type SkillState = {
  /** Git commit SHA at install time (null for manual/local installs). */
  sha: string | null;
  /** `owner/repo` of the source GitHub repo. */
  source: string;
  /** ISO timestamp of install / last update. */
  installedAt: string;
  /** Frontmatter version string if the skill declares one (e.g. `1.0.0`). */
  version: string | null;
  /** Dependencies: other skill slugs this skill requires. */
  requires: string[];
  /** Branch used for install. */
  branch: string | null;
};

type SkillsStateMap = Record<string, SkillState>;

/** Cache of the loaded state. */
let cachedState: SkillsStateMap | null = null;

async function loadState(): Promise<SkillsStateMap> {
  if (cachedState) return cachedState;
  try {
    const raw = await store.get<SkillsStateMap>("skills");
    cachedState = raw ?? {};
  } catch {
    cachedState = {};
  }
  return cachedState;
}

async function saveState(state: SkillsStateMap): Promise<void> {
  cachedState = state;
  await store.set("skills", state);
  await store.save();
}

/** Get metadata for a single skill by its directory path. */
export async function getSkillState(dir: string): Promise<SkillState | null> {
  const state = await loadState();
  return state[dir] ?? null;
}

/** Set metadata for a skill. */
export async function setSkillState(dir: string, meta: SkillState): Promise<void> {
  const state = await loadState();
  state[dir] = meta;
  await saveState(state);
}

/** Remove metadata for a skill. */
export async function removeSkillState(dir: string): Promise<void> {
  const state = await loadState();
  delete state[dir];
  await saveState(state);
}

/** Get all known skill states. */
export async function getAllSkillStates(): Promise<SkillsStateMap> {
  return loadState();
}

/** Bulk-set states (used after bulk install/update). */
export async function setSkillStates(entries: [string, SkillState][]): Promise<void> {
  const state = await loadState();
  for (const [dir, meta] of entries) state[dir] = meta;
  await saveState(state);
}

/** Remove all states whose dirs start with a given group dir prefix. */
export async function removeGroupStates(groupDir: string): Promise<void> {
  const state = await loadState();
  const prefix = groupDir.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  for (const dir of Object.keys(state)) {
    const d = dir.replace(/\\/g, "/").toLowerCase();
    // Path-boundary match so removing `.../skills/foo` doesn't also wipe
    // `.../skills/foobar`'s state.
    if (d === prefix || d.startsWith(`${prefix}/`)) {
      delete state[dir];
    }
  }
  await saveState(state);
}

// Invalidate cache when skills are installed/removed.
subscribeSkillPathChanges(() => {
  cachedState = null;
});
