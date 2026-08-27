/**
 * Self-check for the ChatGPT-account provider and the picker row label.
 * Run: `npx tsx scripts/ai/chatgpt-provider-verify.ts`.
 *
 * The OAuth dance itself is covered by Rust unit tests (`cargo test --lib
 * chatgpt_auth`: the RFC 7636 PKCE vector, the account-id claim search, the
 * keep-the-old-refresh-token rule, query escaping). What those cannot see is the
 * wiring on this side, and the wiring is where a feature turns into a gimmick:
 *
 *  1. CONNECTION GATE. `providerNeedsKey` answers "does it take a pasted key",
 *     which for `chatgpt` is NO - so every gate that used it read the provider
 *     as ready and offered its models to someone who had never signed in.
 *     `providerIsConnected` is the question that actually decides.
 *  2. NO KEY DEMANDED. `buildLanguageModel` throws "No API key configured"
 *     for any provider in `providerNeedsKey`, so `chatgpt` must be keyless or
 *     sign-in could never be reached.
 *  3. ROUTE. The AI SDK posts a Responses call to `<baseURL>/responses`; that
 *     concatenation has to land on the Codex path, and on chatgpt.com rather
 *     than api.openai.com (which bills credits instead of the subscription).
 *  4. EXHAUSTIVE RECORDS. A new ProviderId that misses `EMPTY_PROVIDER_KEYS` or
 *     the autocomplete map is a runtime hole, not a type error, for anything
 *     that spreads them.
 *  5. THE REFUSAL IS READABLE. The accepted model list is gated by ChatGPT
 *     plan, and the endpoint says so in a body shape the AI SDK does not
 *     understand, so the message arrived empty and the chat card showed only
 *     the SDK default. That is what made a one-line 400 undiagnosable.
 */
import {
  CHATGPT_BASE_URL,
  CHATGPT_CONNECTED_MARKER,
  CHATGPT_HEADERS,
  DEFAULT_AUTOCOMPLETE_MODEL,
  MODELS,
  PROVIDERS,
  providerIsConnected,
  providerNeedsKey,
  resolveModelInfo,
  type ProviderId,
} from "../../src/modules/ai/config";
import { describeProviderError, humanizeChatErrorMessage } from "../../src/modules/ai/lib/errors";
import { EMPTY_PROVIDER_KEYS } from "../../src/modules/ai/lib/keyring";
import { toolRowLabel } from "../../src/modules/ai/tools/catalog";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

const NONE = { ...EMPTY_PROVIDER_KEYS };
const SIGNED_IN = { ...EMPTY_PROVIDER_KEYS, chatgpt: CHATGPT_CONNECTED_MARKER };

console.log("[gate] a provider you sign into is not 'connected' until you do");
check("signed out -> not connected", !providerIsConnected("chatgpt", NONE));
check("signed in -> connected", providerIsConnected("chatgpt", SIGNED_IN));
check(
  "the OLD gate would have said yes while signed out (this is the bug)",
  !providerNeedsKey("chatgpt"),
);
check("a keyed provider still needs its key", !providerIsConnected("openai", NONE));
check(
  "...and is connected once it has one",
  providerIsConnected("openai", { ...NONE, openai: "sk-x" }),
);
check(
  "a genuinely keyless local server is always connected",
  providerIsConnected("lmstudio", NONE),
);

console.log("\n[gate] every provider answers the question");
for (const p of PROVIDERS) {
  const answered = typeof providerIsConnected(p.id, NONE) === "boolean";
  check(`${p.id}`, answered);
}

console.log("\n[keys] sign-in never puts a credential in the keys record");
check(
  "the marker is not shaped like any provider's key",
  PROVIDERS.every((p) => !p.keyPrefix || !CHATGPT_CONNECTED_MARKER.startsWith(p.keyPrefix)),
  CHATGPT_CONNECTED_MARKER,
);
check("and it says what it is", CHATGPT_CONNECTED_MARKER.startsWith("oauth:"));
check("buildLanguageModel will not demand a pasted key for it", !providerNeedsKey("chatgpt"));

console.log("\n[route] the base URL resolves to the Codex responses path");
check(
  "<base>/responses is the ChatGPT backend path",
  `${CHATGPT_BASE_URL}/responses` === "https://chatgpt.com/backend-api/codex/responses",
  `${CHATGPT_BASE_URL}/responses`,
);
check("not api.openai.com (that one bills credits)", !CHATGPT_BASE_URL.includes("api.openai.com"));
check("no trailing slash, or the SDK would post to //responses", !CHATGPT_BASE_URL.endsWith("/"));
check("the endpoint's required headers are present", !!CHATGPT_HEADERS.originator);

console.log("\n[models] the ChatGPT models resolve to the ChatGPT provider");
const chatgptModels = MODELS.filter((m) => m.provider === "chatgpt");
check("there is at least one", chatgptModels.length > 0, chatgptModels.length);
for (const m of chatgptModels) {
  // An id shared with the API provider (gpt-5.6-sol exists on both) must still
  // resolve to whichever provider was PICKED, or a signed-in user's turn would
  // silently route to api.openai.com and bill credits.
  const resolved = resolveModelInfo(m.id, "chatgpt");
  check(`${m.id} stays on chatgpt`, resolved.provider === "chatgpt", resolved.provider);
}

console.log("\n[records] nothing is missing an entry for a new provider");
for (const p of PROVIDERS) {
  check(`${p.id} in EMPTY_PROVIDER_KEYS`, p.id in EMPTY_PROVIDER_KEYS);
  check(`${p.id} in DEFAULT_AUTOCOMPLETE_MODEL`, p.id in DEFAULT_AUTOCOMPLETE_MODEL);
}
const ids = new Set<ProviderId>(PROVIDERS.map((p) => p.id));
check(
  "no stale key in EMPTY_PROVIDER_KEYS",
  Object.keys(EMPTY_PROVIDER_KEYS).every((k) => ids.has(k as ProviderId)),
);

console.log("\n[picker] an MCP row drops the prefix its group header already shows");
check(
  "mcp__chrome-devtools-mcp__click -> click",
  toolRowLabel("mcp__chrome-devtools-mcp__click") === "click",
  toolRowLabel("mcp__chrome-devtools-mcp__click"),
);
check(
  "a long one becomes readable",
  toolRowLabel("mcp__chrome-devtools-mcp__performance_analyze_insight") ===
    "performance_analyze_insight",
);
check("a built-in is untouched", toolRowLabel("read_file") === "read_file");
check("an extension tool is untouched", toolRowLabel("rtk_status") === "rtk_status");
// A malformed key has no server segment, so slicing it would leave nothing.
check("a malformed mcp key keeps its name", toolRowLabel("mcp__weird") === "mcp__weird");

console.log("\n[errors] a plan-refused model reaches the user as words, not a blank card");
// Exactly what the endpoint answers when the account's plan does not include
// the picked model. The AI SDK only lifts `message` out of a body shaped like
// OpenAI's `{ error: { message } }`, so this one leaves `message` at the
// `Response.statusText` the Rust proxy never sets: empty.
const PLAN_REFUSAL = `{"detail":"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."}`;
const refused = describeProviderError({ message: "", responseBody: PLAN_REFUSAL, statusCode: 400 });
check(
  "the detail is recovered from the body",
  refused === "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
  refused,
);
check(
  "and it names the fix",
  humanizeChatErrorMessage(refused).includes("Pick another ChatGPT model"),
  humanizeChatErrorMessage(refused),
);
check(
  "a normal message is passed through untouched",
  describeProviderError(new Error("rate limited")) === "rate limited",
);
check(
  "a body that is not JSON still beats an empty card",
  describeProviderError({ message: "", responseBody: "upstream exploded" }) === "upstream exploded",
);
check(
  "nothing at all falls back to the status code",
  describeProviderError({ statusCode: 502 }) === "The provider returned HTTP 502.",
);

console.log(`\n${"=".repeat(60)}\n${failed === 0 ? "PASS" : `FAIL (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
