import {
  READ_ONLY_TOOLS,
  type BuiltinSubagentType,
  type SubagentCategory,
  type SubagentDef,
} from "./registry";
import { getAllSubagentDefs } from "../store/subagentsStore";

/** Synonym -> { preferred built-in id, category }. Models invent semantic type
 *  names ("explore", "review", "implement") instead of the actual roster ids.
 *  The built-in gives precise routing on the default roster; the category is a
 *  rename-safe fallback (any current agent in that category), so this keeps
 *  working after a user renames the built-ins or adds custom agents. Categories
 *  are the stable concept here, not the ids. */
const SUBAGENT_SYNONYMS: Record<
  string,
  { builtin: BuiltinSubagentType; category: SubagentCategory }
> = {
  // exploration: search this codebase
  explore: { builtin: "comet", category: "exploration" },
  exploration: { builtin: "comet", category: "exploration" },
  explorer: { builtin: "comet", category: "exploration" },
  search: { builtin: "comet", category: "exploration" },
  find: { builtin: "comet", category: "exploration" },
  locate: { builtin: "comet", category: "exploration" },
  scan: { builtin: "comet", category: "exploration" },
  grep: { builtin: "comet", category: "exploration" },
  codebase: { builtin: "comet", category: "exploration" },
  code: { builtin: "comet", category: "exploration" },
  read: { builtin: "comet", category: "exploration" },
  analyze: { builtin: "comet", category: "exploration" },
  analysis: { builtin: "comet", category: "exploration" },
  investigate: { builtin: "comet", category: "exploration" },
  audit: { builtin: "comet", category: "exploration" },
  general: { builtin: "comet", category: "exploration" },
  // exploration: third-party dependencies
  deps: { builtin: "nebula", category: "exploration" },
  dependency: { builtin: "nebula", category: "exploration" },
  dependencies: { builtin: "nebula", category: "exploration" },
  library: { builtin: "nebula", category: "exploration" },
  libraries: { builtin: "nebula", category: "exploration" },
  package: { builtin: "nebula", category: "exploration" },
  packages: { builtin: "nebula", category: "exploration" },
  // advisor: hard reasoning / debugging / architecture
  advisor: { builtin: "nova", category: "advisor" },
  advice: { builtin: "nova", category: "advisor" },
  consult: { builtin: "nova", category: "advisor" },
  debug: { builtin: "nova", category: "advisor" },
  debugging: { builtin: "nova", category: "advisor" },
  architecture: { builtin: "nova", category: "advisor" },
  design: { builtin: "nova", category: "advisor" },
  reasoning: { builtin: "nova", category: "advisor" },
  // advisor: pre-planning analysis (intent, scope, risks)
  scope: { builtin: "orbit", category: "advisor" },
  preplan: { builtin: "orbit", category: "advisor" },
  clarify: { builtin: "orbit", category: "advisor" },
  // advisor: produce a decision-complete plan
  plan: { builtin: "vega", category: "advisor" },
  planner: { builtin: "vega", category: "advisor" },
  planning: { builtin: "vega", category: "advisor" },
  roadmap: { builtin: "vega", category: "advisor" },
  blueprint: { builtin: "vega", category: "advisor" },
  // advisor: plan / change review
  review: { builtin: "eclipse", category: "advisor" },
  reviewer: { builtin: "eclipse", category: "advisor" },
  verify: { builtin: "eclipse", category: "advisor" },
  check: { builtin: "eclipse", category: "advisor" },
  validate: { builtin: "eclipse", category: "advisor" },
  // specialist: autonomous worker (mutating)
  worker: { builtin: "odyssey", category: "specialist" },
  implement: { builtin: "odyssey", category: "specialist" },
  implementation: { builtin: "odyssey", category: "specialist" },
  build: { builtin: "odyssey", category: "specialist" },
  edit: { builtin: "odyssey", category: "specialist" },
  fix: { builtin: "odyssey", category: "specialist" },
  refactor: { builtin: "odyssey", category: "specialist" },
  write: { builtin: "odyssey", category: "specialist" },
  develop: { builtin: "odyssey", category: "specialist" },
  // specialist: multi-step plan execution (Zenith) and focused leaf work (Meteor)
  orchestrate: { builtin: "zenith", category: "specialist" },
  orchestrator: { builtin: "zenith", category: "specialist" },
  executor: { builtin: "meteor", category: "specialist" },
  // utility: media / visual analysis
  image: { builtin: "aurora", category: "utility" },
  images: { builtin: "aurora", category: "utility" },
  visual: { builtin: "aurora", category: "utility" },
  screenshot: { builtin: "aurora", category: "utility" },
  diagram: { builtin: "aurora", category: "utility" },
  pdf: { builtin: "aurora", category: "utility" },
  media: { builtin: "aurora", category: "utility" },
  picture: { builtin: "aurora", category: "utility" },
  photo: { builtin: "aurora", category: "utility" },
  ocr: { builtin: "aurora", category: "utility" },
};

/** A def whose tool list is purely read-only (no edit/shell), i.e. not a worker. */
function isReadOnlySubagent(d: SubagentDef): boolean {
  return d.tools.every((t) => READ_ONLY_TOOLS.includes(t));
}

/** Resolve a caller-provided type to a real def. Roster comes from
 *  getAllSubagentDefs() (built-ins + user renames + custom agents), so this is
 *  the single source of truth. Order: exact id -> case-insensitive id ->
 *  synonym's preferred built-in (if it still exists) -> any current agent in the
 *  synonym's category (rename-safe) -> a read-only agent. Never throws on a
 *  loose/unknown name (only if the roster is literally empty), and never falls
 *  back to a worker, so a mislabeled task can't silently edit files. */
export function resolveSubagentDef(type: string): SubagentDef {
  const defs = getAllSubagentDefs() as Record<string, SubagentDef>;
  const all = Object.values(defs);
  if (all.length === 0) throw new Error("no sub-agent types are available");
  const raw = typeof type === "string" ? type : String(type ?? "");
  const key = raw.toLowerCase().trim();

  // 1. Exact id, then case-insensitive id OR display label (so a custom agent
  //    is reachable both by its id and by the name shown in the UI / tool list,
  //    and a renamed built-in is reachable by either).
  if (defs[raw]) return defs[raw];
  const byIdOrLabel = all.find(
    (d) => String(d.id).toLowerCase() === key || String(d.label ?? "").toLowerCase() === key,
  );
  if (byIdOrLabel) return byIdOrLabel;

  // 1b. Normalized match (ignore case, separators, and the sa-custom- prefix):
  //     reach a custom agent by its slug, name, or a spacing variant -
  //     "test-mapper" / "Test mapper" / "testmapper" all hit the same agent. A
  //     user-named agent therefore wins over a generic synonym below.
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nk = norm(key);
  if (nk) {
    const byNorm = all.find(
      (d) =>
        norm(String(d.id).replace(/^sa-custom-/, "")) === nk || norm(String(d.label ?? "")) === nk,
    );
    if (byNorm) return byNorm;
  }

  // 2. Synonym: the named built-in if it still exists, else any current agent
  //    sharing the synonym's category.
  const syn = SUBAGENT_SYNONYMS[key];
  if (syn) {
    if (defs[syn.builtin]) return defs[syn.builtin];
    const inCat = all.find((d) => d.category === syn.category);
    if (inCat) return inCat;
  }

  // 3. Safe fallback: a read-only explorer, then any read-only agent, never a
  //    worker; only as a last resort the first def.
  return (
    all.find((d) => isReadOnlySubagent(d) && d.category === "exploration") ??
    all.find(isReadOnlySubagent) ??
    all[0]
  );
}

/** Friendly display name for a caller-provided sub-agent type. Resolves
 *  synonyms the same way the runtime does (e.g. "explore" -> "Comet"), so the
 *  badge shows the agent that actually runs, not the raw label the model typed.
 *  Never throws: falls back to the raw string if the roster is empty. */
export function resolveSubagentLabel(type: string): string {
  const raw = typeof type === "string" ? type : String(type ?? "");
  try {
    return resolveSubagentDef(raw).label || raw;
  } catch {
    return raw;
  }
}
