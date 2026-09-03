/**
 * Self-check for the model-aware reasoning-effort system.
 * Run: `npx tsx scripts/ai/reasoning-effort-verify.ts`.
 *
 * WHY THIS EXISTS. A reasoning picker is only worth having if the level actually
 * reaches the provider, and every part of that is easy to get silently wrong:
 * the accepted values differ per MODEL FAMILY, the parameter name differs per
 * provider, and none of the SDKs validate - @ai-sdk/google forwards
 * `thinkingConfig` untouched and the openai-compatible base types the effort as a
 * bare string, so a wrong value ships and 400s at the API instead of at build.
 *
 * So this does not assert on TEDI's own state. It builds the REAL provider client
 * for each model, runs a real `generateText` through a stub fetch, and reads the
 * level back out of the captured HTTP BODY. If the wire shape ever changes under
 * us, this fails.
 */
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createXai } from "@ai-sdk/xai";
import { createGroq } from "@ai-sdk/groq";
import { createCerebras } from "@ai-sdk/cerebras";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderId } from "../../src/modules/ai/config";
import { MODELS } from "../../src/modules/ai/config";
import {
  REASONING_AUTO,
  isValidReasoningChoice,
  reasoningControlFor,
  reasoningProviderOptions,
} from "../../src/modules/ai/lib/reasoning";
import { providerRequestOptions } from "../../src/modules/ai/lib/cache";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

// ---------------------------------------------------------------------------
// A stub fetch that captures the request body and never reaches the network.
// ---------------------------------------------------------------------------
let captured: Record<string, unknown> | null = null;
const stub = (async (_url: string, init: { body: string }) => {
  captured = JSON.parse(init.body) as Record<string, unknown>;
  throw new Error("captured");
}) as unknown as typeof fetch;

function clientFor(provider: ProviderId, modelId: string) {
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey: "k", fetch: stub })(modelId);
    // The ChatGPT lane is the same SDK on the Responses path, which is what
    // decides the wire shape (`reasoning:{effort}`, not `reasoning_effort`).
    case "chatgpt":
      return createOpenAI({ apiKey: "k", fetch: stub }).responses(modelId);
    case "anthropic":
      return createAnthropic({ apiKey: "k", fetch: stub })(modelId);
    case "google":
      return createGoogleGenerativeAI({ apiKey: "k", fetch: stub })(modelId);
    case "xai":
      return createXai({ apiKey: "k", fetch: stub })(modelId);
    case "groq":
      return createGroq({ apiKey: "k", fetch: stub })(modelId);
    case "cerebras":
      return createCerebras({ apiKey: "k", fetch: stub })(modelId);
    default:
      return createOpenAICompatible({ name: provider, baseURL: "https://x/v1", fetch: stub })(
        modelId,
      );
  }
}

/** Send one turn and hand back the request body the provider built. */
async function bodyFor(
  provider: ProviderId,
  modelId: string,
  choice: string,
): Promise<Record<string, unknown>> {
  captured = null;
  const opts = providerRequestOptions(provider, "session-1", modelId, choice);
  try {
    await generateText({
      model: clientFor(provider, modelId),
      prompt: "hi",
      maxRetries: 0,
      ...opts,
    });
  } catch {
    /* the stub always throws once it has the body */
  }
  return captured ?? {};
}

/** Pull the effort back out, wherever this provider puts it. */
function effortIn(provider: ProviderId, body: Record<string, unknown>): unknown {
  const get = (o: unknown, k: string): unknown =>
    o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined;
  switch (provider) {
    case "openai":
    case "chatgpt":
      return get(body.reasoning, "effort");
    case "anthropic":
      return get(body.output_config, "effort");
    case "google":
      return get(get(body.generationConfig, "thinkingConfig"), "thinkingLevel");
    default:
      return body.reasoning_effort;
  }
}

// ---------------------------------------------------------------------------
console.log("[wire] every supported level reaches the real request body");

const supported = MODELS.filter((m) => reasoningControlFor(m.provider, m.id));
check("some models declare a reasoning control", supported.length > 0);

for (const m of supported) {
  const control = reasoningControlFor(m.provider, m.id);
  if (!control) continue;
  for (const value of control.values) {
    const body = await bodyFor(m.provider, m.id, value);
    check(
      `${m.provider}/${m.id} ${value} -> ${control.wire}`,
      effortIn(m.provider, body) === value,
      {
        body,
      },
    );
  }
}

console.log("\n[auto] the default sends NO reasoning parameter at all");
for (const m of supported) {
  const body = await bodyFor(m.provider, m.id, REASONING_AUTO);
  check(`${m.provider}/${m.id} auto is absent`, effortIn(m.provider, body) === undefined, { body });
}

console.log("\n[unsupported models] never receive the parameter");
// Every model TEDI ships that declares NO control must stay clean even if a
// stale choice is somehow handed to it - a stored level outliving a model swap
// is the exact case this guards.
const unsupported = MODELS.filter((m) => !reasoningControlFor(m.provider, m.id));
check("some models genuinely have no control", unsupported.length > 0);
for (const m of unsupported) {
  const body = await bodyFor(m.provider, m.id, "high");
  check(`${m.provider}/${m.id} ignores a stale "high"`, effortIn(m.provider, body) === undefined, {
    body,
  });
}

console.log("\n[merge] reasoning never clobbers a mandatory provider option");
{
  // The ChatGPT backend REFUSES a request that does not say store:false, and it
  // shares the `openai` namespace with the effort - so a careless second spread
  // would drop it and break that lane entirely.
  const body = await bodyFor("chatgpt", "gpt-5.6-terra", "high");
  check("chatgpt keeps store:false alongside the effort", body.store === false, { body });
  check("chatgpt still carries the effort", effortIn("chatgpt", body) === "high", { body });

  const oa = providerRequestOptions("openai", "sess", "gpt-5.6-sol", "xhigh");
  const openai = oa.providerOptions?.openai;
  check("openai keeps promptCacheKey alongside the effort", openai?.promptCacheKey === "sess", oa);
  check("openai carries the effort", openai?.reasoningEffort === "xhigh", oa);
}

console.log("\n[per-family] the accepted sets really differ, and the traps hold");
{
  const has = (p: ProviderId, id: string, v: string): boolean => isValidReasoningChoice(p, id, v);
  // `none` is not a choice on any family. Auto already reaches it on the models
  // where the provider defaults to it, and an explicit "do not think" level is
  // one the picker does not offer.
  for (const id of ["gpt-5.3-codex", "gpt-5.4-mini", "gpt-5.6-sol", "gpt-5.5"]) {
    check(`${id} does not offer none`, !has("openai", id, "none"));
  }
  // Still named as the provider DEFAULT, which is how the Auto row can say that
  // these two models do no reasoning unless asked.
  check(
    "gpt-5.4-mini still reports none as its provider default",
    reasoningControlFor("openai", "gpt-5.4-mini")?.providerDefault === "none",
  );
  // `max` is gpt-5.6 only.
  check("gpt-5.6-sol accepts max", has("openai", "gpt-5.6-sol", "max"));
  check("gpt-5.5 refuses max", !has("openai", "gpt-5.5", "max"));
  // The codex ordering trap: `gpt-5.6-codex` matches the 5.6 rule too, and only
  // the rule order keeps it from being offered a `max` its family rejects.
  check("gpt-5.6-codex refuses max", !has("openai", "gpt-5.6-codex", "max"));
  // `minimal` belongs to the original gpt-5 family, which TEDI does not ship.
  check(
    "no OpenAI model offers minimal",
    !MODELS.some((m) => m.provider === "openai" && has("openai", m.id, "minimal")),
  );
  // xhigh arrived with opus-4-7, so sonnet-4-6 must not offer it.
  check("claude-sonnet-4-6 refuses xhigh", !has("anthropic", "claude-sonnet-4-6", "xhigh"));
  check("claude-opus-4-8 accepts xhigh", has("anthropic", "claude-opus-4-8", "xhigh"));
  // Budget-only models get no enum control at all.
  check(
    "claude-haiku-4-5 has no control",
    reasoningControlFor("anthropic", "claude-haiku-4-5") === null,
  );
  check(
    "gemini-2.5-flash has no control",
    reasoningControlFor("google", "gemini-2.5-flash") === null,
  );
  // Non-reasoning models.
  check("gemma has no control", reasoningControlFor("google", "gemma-4-31b-it") === null);
  check(
    "llama on groq has no control",
    reasoningControlFor("groq", "llama-3.1-8b-instant") === null,
  );
  // Arbitrary gateways: the upstream model is unknown, so no control is offered.
  for (const p of ["sumopod", "agentrouter", "openai-compatible", "lmstudio"] as ProviderId[]) {
    check(`${p} offers no control`, reasoningControlFor(p, "anything") === null);
  }
}

console.log("\n[model switch] a level chosen for one model never leaks to another");
{
  // The store is keyed `provider::modelId`, so a switch reads a different row -
  // but the guard that matters is the one on the way OUT, in case a row survives
  // a provider changing its accepted set.
  check(
    "xhigh is not valid on a model that lacks it",
    !isValidReasoningChoice("anthropic", "claude-sonnet-4-6", "xhigh"),
  );
  check(
    "an invalid choice produces no provider options",
    reasoningProviderOptions("anthropic", "claude-sonnet-4-6", "xhigh") === undefined,
  );
  check(
    "the same id under a different provider resolves separately",
    reasoningControlFor("openai", "gpt-5.6-terra")?.values.length ===
      reasoningControlFor("chatgpt", "gpt-5.6-terra")?.values.length,
  );
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
