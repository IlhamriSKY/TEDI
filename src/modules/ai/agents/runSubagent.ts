import { generateText, stepCountIs, type ModelMessage, type ToolSet } from "ai";
import { tryGetModel, type DynamicModelId, type ModelInfo } from "../config";
import { buildLanguageModel, noProgressStop, noToolRepetition, TOOL_LABELS } from "../lib/agent";
import { applyCacheBreakpoints } from "../lib/cache";
import { classifyError, TediErrorCode } from "../lib/errors";
import type { ProviderKeys } from "../lib/keyring";
import {
  resolvePromptModel,
  resolvePromptTemperature,
  resolvePromptText,
  type PromptId,
} from "../lib/prompts";
import { getPromptOverrides } from "../store/promptsStore";
import type { ToolContext } from "../tools/context";
import { buildFsTools } from "../tools/fs";
import { buildSearchTools } from "../tools/search";
import { buildEditTools } from "../tools/edit";
import { buildShellTools } from "../tools/shell";
import {
  READ_ONLY_TOOLS,
  type BuiltinSubagentType,
  type SubagentCategory,
  type SubagentDef,
} from "./registry";
import { getAllSubagentDefs } from "../store/subagentsStore";
import { useDebugStore } from "../store/debugStore";
import { usePreferencesStore } from "@/modules/settings/preferences";

/** Sub-agents have no user-facing step cap so they can run a task to completion.
 *  Termination is driven by natural finish plus the same anti-loop guards the
 *  main agent uses (tool-repetition + no-progress); this high number is only a
 *  runaway backstop the guards almost always trip well before. */
const SUBAGENT_STEP_BUDGET = 100;

/** Subagents retry transient provider failures (429 / 5xx / network) themselves
 *  with JITTERED backoff (see withRateLimitRetry). 4 retries -> ~2/4/8/16s plus
 *  jitter. Jitter is the point: a fan-out of N subagents that all trip a
 *  per-minute rate limit at the same instant would, under the SDK's lockstep
 *  no-jitter retry, back off in unison and collide again; spreading them lets
 *  the batch drain instead of failing together ("Terlalu banyak penggunaan"). */
const SUBAGENT_MAX_RETRIES = 4;
const SUBAGENT_RETRY_BASE_MS = 2000;

type Args = {
  type: string;
  prompt: string;
  keys: ProviderKeys;
  modelId: DynamicModelId;
  toolContext: ToolContext;
  lmstudioBaseURL?: string;
  openaiCompatibleBaseURL?: string;
  /** Forwarded from parent so Stop also cancels in-flight subagent fetches. */
  abortSignal?: AbortSignal;
  /** Fires after each internal step with a human label of what the subagent
   *  just did ("Reading …", "Grepping …") and the running step count, so the UI
   *  can show live progress for an otherwise-blocking generateText loop. */
  onStep?: (label: string, stepCount: number) => void;
};

/** Human label for the subagent's latest step, mirroring the main agent's
 *  per-step label derivation (reuses the shared TOOL_LABELS map). */
function describeStep(step: {
  toolCalls?: Array<{ toolName: string; input?: unknown }>;
  text?: string;
}): string {
  const last = step.toolCalls?.[step.toolCalls.length - 1];
  if (last) {
    const label = TOOL_LABELS[last.toolName];
    return label
      ? label((last.input ?? {}) as Record<string, unknown>)
      : `Calling ${last.toolName}`;
  }
  return step.text ? "Writing" : "Thinking";
}

type RunResult = {
  summary: string;
  stepCount: number;
  durationMs: number;
};

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
function resolveSubagentDef(type: string): SubagentDef {
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

export async function runSubagent({
  type,
  prompt,
  keys,
  modelId,
  toolContext,
  lmstudioBaseURL,
  openaiCompatibleBaseURL,
  abortSignal,
  onStep,
}: Args): Promise<RunResult> {
  const def = resolveSubagentDef(type);

  // A worker (its tool list includes anything beyond READ_ONLY_TOOLS, e.g.
  // Odyssey) gets the mutating + shell tools; a read-only agent does not.
  const isWorker = def.tools.some((t) => !READ_ONLY_TOOLS.includes(t));

  // Disable the out-of-scope read approval gate: this generateText loop has no
  // approval responder, so a gated read would stall instead of running. A
  // worker additionally gets edit/write/fs-mutation/shell tools with approval
  // OFF (autoApprove): same no-responder reason. Mutations stay guarded by the
  // secret/system denylist, writable/deletable checks, scope-root protection,
  // and checkpoint/restore. run_subagent is never built here, so no recursion.
  const available: Record<string, unknown> = {
    ...buildFsTools(toolContext, {
      gateOutOfScopeReads: false,
      refuseOutOfScopeReads: true,
      autoApproveMutations: isWorker,
      // No approver + no scope check would let a prompt-injected worker write or
      // delete anywhere; refuse out-of-scope mutations. Write directly past plan
      // mode so the worker's bash verification sees the real edited tree (in
      // plan mode its edits would otherwise queue while bash ran on the old one).
      refuseOutOfScopeMutations: isWorker,
      ignorePlanMode: isWorker,
    }),
    ...buildSearchTools(toolContext, { gateOutOfScopeReads: false, refuseOutOfScopeReads: true }),
    ...(isWorker
      ? {
          ...buildEditTools(toolContext, {
            autoApprove: true,
            refuseOutOfScopeMutations: true,
            ignorePlanMode: true,
          }),
          ...buildShellTools(toolContext, { autoApprove: true }),
        }
      : {}),
  };
  const filtered: Record<string, unknown> = {};
  for (const t of def.tools) {
    if (t in available) filtered[t] = available[t];
  }

  // User overrides: system prompt, model, and (opt-in) temperature per sub-agent.
  const overrides = getPromptOverrides();
  // Use the RESOLVED id so a per-agent override is found even when the caller
  // passed a synonym (e.g. "explore" -> comet).
  const promptId = `subagent:${def.id}` as PromptId;
  const systemPrompt = resolvePromptText(overrides, promptId, def.systemPrompt);
  // Model resolution: an explicit prompt-override (built-ins) wins, else the
  // def's own model (custom sub-agents), else the parent chat model.
  const effectiveModelId = resolvePromptModel(overrides, promptId, def.model ?? modelId);
  const temperature = resolvePromptTemperature(overrides, promptId);

  // Unknown ids fall back to SumoPod (runtime discovery via /v1/models).
  const info: ModelInfo =
    tryGetModel(effectiveModelId) ??
    ({
      id: effectiveModelId,
      provider: "sumopod",
      label: effectiveModelId,
      hint: "SumoPod",
    } as ModelInfo);

  const model = await buildLanguageModel(info.provider, keys, info.id, {
    lmstudioBaseURL,
    openaiCompatibleBaseURL,
  });

  // Explicit messages so we can attach provider-cache markers (Experimental_Agent hides this).
  const baseMessages: ModelMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];
  const messages = applyCacheBreakpoints(baseMessages, info.provider);

  // Debug capture: snapshot this sub-agent's request (no secrets) when Debug is on.
  if (usePreferencesStore.getState().debugEnabled) {
    useDebugStore.getState().add({
      kind: "subagent",
      sessionId: toolContext.getSessionId(),
      subagentType: type,
      model: { id: info.id, provider: info.provider, label: info.label },
      params: {
        ...(temperature !== undefined ? { temperature } : {}),
        stepBudget: SUBAGENT_STEP_BUDGET,
      },
      system: systemPrompt,
      messages,
      tools: Object.entries(filtered).map(([name, t]) => ({
        name,
        description: (t as { description?: string } | undefined)?.description,
      })),
    });
  }

  // Casts because the SDK infers `never` for the tools generic on a dynamic record.
  const start = Date.now();
  let liveSteps = 0;
  const result = await withRateLimitRetry(() =>
    generateText({
      model,
      messages,
      tools: filtered as never,
      // No low step cap (powerful sub-agents): natural finish plus the main
      // agent's anti-loop guards terminate; the count is just a runaway backstop.
      stopWhen: [
        stepCountIs(SUBAGENT_STEP_BUDGET),
        noToolRepetition<ToolSet>(3),
        noProgressStop<ToolSet>(2),
      ] as never,
      // Force a tool call on the FIRST step. Handed an agentic brief, some models
      // answer with a single text- or reasoning-only step and never touch a tool -
      // the "one step, no work" failure the caller sees. Every sub-agent's job
      // begins by reading or searching, so requiring a tool on step 0 is always
      // correct here; it reverts to auto afterwards so the agent finishes
      // naturally. Provider-agnostic: endpoints that ignore toolChoice simply skip
      // the constraint, so this never hurts a model that already calls tools.
      prepareStep: ({ stepNumber }: { stepNumber: number }) =>
        stepNumber === 0 ? { toolChoice: "required" } : {},
      ...(temperature !== undefined ? { temperature } : {}),
      // Own the retry (jittered) in withRateLimitRetry below. The SDK's default
      // retry is lockstep (no jitter), so a parallel fan-out that all trips a
      // rate limit at once backs off in unison and collides on the same tick.
      maxRetries: 0,
      abortSignal,
      // Surface live progress: each finished step reports what the subagent just
      // did + the running step count to the optional onStep callback.
      onStepFinish: (step: {
        toolCalls?: Array<{ toolName: string; input?: unknown }>;
        text?: string;
      }) => {
        liveSteps += 1;
        onStep?.(describeStep(step), liveSteps);
      },
    } as never),
  );
  const durationMs = Date.now() - start;
  const stepCount = result.steps?.length ?? 0;

  // Final summary, with a recovery path for the general case where an agentic
  // run ends with no assistant text. Two ways that happens across providers:
  // (a) some models/gateways return empty `content` once the conversation holds
  // tool calls (observed with glm-5-2 via GenFlow, but not unique to it), and
  // (b) the run is cut off mid-exploration by the step budget. `reasoningText`
  // first covers models that put the answer in reasoning; when both are empty we
  // re-summarize in a clean tool-free text turn with the tool activity flattened
  // into plain text, which reliably yields prose from any chat model.
  let summary = result.text?.trim() || result.reasoningText?.trim() || "";
  if (!summary) summary = (await summarizeToolRun()) || "(no output)";

  return { summary, stepCount, durationMs };

  /** Retry transient provider failures (rate limit / 5xx / network) with
   *  jittered exponential backoff, owning the loop so parallel subagents that
   *  trip a per-minute limit at the same instant spread out instead of retrying
   *  in lockstep. generateText is called with maxRetries:0 so this is the only
   *  retry. Non-transient errors (auth, bad request) and aborts fail fast. */
  async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= SUBAGENT_MAX_RETRIES; attempt++) {
      if (abortSignal?.aborted) throw new Error("aborted");
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (abortSignal?.aborted) throw err;
        const code = classifyError(err);
        const transient =
          code === TediErrorCode.RATE_LIMITED || code === TediErrorCode.PROVIDER_UNAVAILABLE;
        if (!transient || attempt === SUBAGENT_MAX_RETRIES) throw err;
        const base = SUBAGENT_RETRY_BASE_MS * Math.pow(2, attempt);
        const wait = Math.round(base * (0.75 + Math.random() * 0.5));
        onStep?.(`Rate limited - retrying in ${Math.round(wait / 1000)}s`, liveSteps);
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
      }
    }
    throw lastErr;
  }

  async function summarizeToolRun(): Promise<string> {
    const lines: string[] = [];
    for (const s of result.steps ?? []) {
      const t = s.text?.trim();
      if (t) lines.push(t);
      for (const tr of (s.toolResults ?? []) as Array<{
        toolName?: string;
        input?: unknown;
        output?: unknown;
        result?: unknown;
      }>) {
        const out = tr.output ?? tr.result;
        const outStr = typeof out === "string" ? out : safeJson(out);
        lines.push(`${tr.toolName ?? "tool"}(${safeJson(tr.input)}) -> ${outStr.slice(0, 800)}`);
      }
    }
    if (lines.length === 0) return "";
    const findings = lines.join("\n").slice(0, 12000);
    try {
      // No tools offered: the model must answer in prose. This is what recovers
      // output from any model that goes silent once tool calls are in the
      // history. Cast as elsewhere in this file.
      const fu = await generateText({
        model,
        messages: applyCacheBreakpoints(
          [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `${prompt}\n\nHere is what you gathered while exploring:\n${findings}\n\nNow write your final summary in prose. Do not call tools; do not mention tools.`,
            },
          ],
          info.provider,
        ),
        ...(temperature !== undefined ? { temperature } : {}),
        abortSignal,
      } as never);
      return fu.text?.trim() ?? "";
    } catch {
      return "";
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  } catch {
    return String(v);
  }
}
