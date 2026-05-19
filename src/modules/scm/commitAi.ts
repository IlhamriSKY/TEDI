import { generateText } from "ai";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import {
  DEFAULT_MODEL_ID,
  PROVIDERS,
  providerNeedsKey,
  tryGetModel,
  type ProviderId,
} from "@/modules/ai/config";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { ProviderKeys } from "@/modules/ai/lib/keyring";
import type { GitChange, GitChangeStatus } from "./types";

/** Hard cap on diff bytes shipped to the model. Anything past this is
 *  truncated by the Tauri host (see git_diff_full). Roughly ~20K tokens. */
const DIFF_BYTE_CAP = 80_000;

/** Upper bound on the model's response length. Commit subject lines are
 *  short, but reasoning models (mimo, o1/o3, deepseek-reasoner, …) count
 *  their thinking trace against this cap and emit visible text only after
 *  reasoning settles — a 200-token ceiling left them with zero budget for
 *  the answer, returning an empty `text`. We keep `sanitize()` to clamp the
 *  final line to 72 chars regardless, so the extra headroom only matters
 *  when reasoning eats tokens; non-reasoning models still finish in <50. */
const MAX_OUTPUT_TOKENS = 4096;

/** Hard timeout for the model call. Some providers can hang on network
 *  faults - we'd rather show the deterministic fallback than spin forever. */
const REQUEST_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = `You write a single Conventional Commit message for the diff provided by the user.

OUTPUT RULES (must follow exactly):
- ONE line only - no body, no bullet points, no preamble, no closing remarks.
- Maximum 72 characters total.
- Format: <type>(<scope>)?: <subject>
  * <type> is one of: feat, fix, refactor, add, remove, docs, style, test, chore, perf, build, ci
  * <scope> is optional, lowercase, one short word in parentheses (e.g. "auth", "scm", "ui")
  * <subject> is imperative present tense ("add", "fix", "rename" - NOT "added", "fixes", "renaming")
- Pick the type that best matches the PRIMARY intent:
  * feat   = new user-facing feature/capability
  * fix    = bug fix
  * refactor = code restructuring with no behaviour change
  * add    = adding new files/assets/configs that aren't a user feature
  * remove = deleting code/files
  * docs/style/test/chore/perf/build/ci as appropriate
- Describe WHAT changed in plain language. Do NOT list filenames unless the change is *only* about that file.
- No backticks, no markdown, no quotes, no trailing period.
- English only.

Respond with the commit message text and NOTHING else.`;

/** Deterministic fallback when the model call fails or the diff is empty.
 *  Picks a Conventional-Commit type from the change mix so the result still
 *  looks intentional instead of "update code". */
export function fallbackCommitMessage(changes: GitChange[]): string {
  if (changes.length === 0) return "chore: update project";
  const counts = changes.reduce<Record<GitChangeStatus, number>>(
    (acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1;
      return acc;
    },
    {
      modified: 0,
      added: 0,
      deleted: 0,
      renamed: 0,
      copied: 0,
      untracked: 0,
      conflicted: 0,
      ignored: 0,
    },
  );
  const created = counts.added + counts.untracked;
  const removed = counts.deleted;
  const modified = counts.modified + counts.renamed + counts.copied;
  const n = changes.length;
  const fileLabel = `${n} file${n > 1 ? "s" : ""}`;

  if (created > 0 && removed === 0 && modified === 0) {
    return `add: introduce ${fileLabel}`;
  }
  if (removed > 0 && created === 0 && modified === 0) {
    return `remove: drop ${fileLabel}`;
  }
  if (modified > 0 && created === 0 && removed === 0) {
    return `chore: update ${fileLabel}`;
  }
  return `chore: update project (${fileLabel})`;
}

/** Conventional-Commit shape: `<type>(<optional scope>)?: <subject>`. Used to
 *  pluck the actual commit line out of a reasoning trace when a reasoning
 *  model (mimo, deepseek-reasoner, …) emits its answer inside
 *  `reasoning_content` and leaves the regular `text` field empty. */
const COMMIT_LINE_RE =
  /^\s*(feat|fix|refactor|add|remove|docs|style|test|chore|perf|build|ci)(\([^)]+\))?:\s+.+$/im;

/** Last-ditch extraction: scan reasoning text bottom-up for a line that
 *  matches the Conventional Commit shape. Reasoning traces typically end
 *  with the model's final answer, so the LAST matching line is the safest
 *  pick. Returns the matched line trimmed, or an empty string. */
function salvageFromReasoning(reasoning: string): string {
  if (!reasoning) return "";
  const lines = reasoning.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (COMMIT_LINE_RE.test(line)) return line;
  }
  return "";
}

/** Strip stray markdown/quoting and clamp to 72 chars. Models sometimes wrap
 *  the line in backticks or add a leading "Commit message:" preface despite
 *  the system prompt. */
function sanitize(text: string): string {
  let s = text.trim();
  // Take first non-empty line.
  const firstLine = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  s = firstLine ?? "";
  // Strip surrounding code fences/quotes.
  s = s.replace(/^[`'"]+|[`'"]+$/g, "").trim();
  // Strip "commit message:" preface variants.
  s = s.replace(/^(commit\s*message|message|subject)\s*[:\-]\s*/i, "").trim();
  // Drop trailing period.
  s = s.replace(/\.$/, "").trim();
  if (s.length > 72) s = s.slice(0, 72).replace(/\s+\S*$/, "");
  return s;
}

export type GenerateCommitMessageResult = {
  message: string;
  /** True when we couldn't reach the model and returned a deterministic
   *  fallback. The caller should surface a non-error toast so the user
   *  understands the message isn't AI-generated. */
  fallback: boolean;
  /** Reason for falling back (network, no-key, no-diff, truncated, etc). */
  reason?: string;
  /** Human-friendly label of the model we tried to use. Surfaced in the
   *  success/warning toast so the user can verify which model ran. */
  modelLabel?: string;
};

type ResolvedModel = {
  id: string;
  provider: ProviderId;
  label: string;
};

/** Resolve the display label for an (id, provider) pair. When both are
 *  given we trust the provider explicitly - this matters for ids that
 *  exist under multiple providers (e.g. `claude-sonnet-4-6` is shipped
 *  by both Anthropic and SumoPod). When provider is unknown, fall back
 *  to id-only registry lookup. */
function labelFor(id: string, provider: ProviderId | null): string {
  const info = tryGetModel(id);
  if (provider && info?.provider === provider) return info.label;
  if (provider) {
    const providerLabel = PROVIDERS.find((p) => p.id === provider)?.label;
    return providerLabel ? `${id} · ${providerLabel}` : id;
  }
  return info?.label ?? id;
}

/** Check if the given provider has a usable key (or doesn't need one). */
function isProviderUsable(provider: ProviderId, apiKeys: ProviderKeys): boolean {
  if (!providerNeedsKey(provider)) return true;
  return !!apiKeys[provider];
}

/** Build the prioritized list of (id, provider) candidates to try for
 *  commit-message generation. The Settings default wins because that's
 *  what the user explicitly chose as "the model" - the chat picker's
 *  last pick is a secondary fallback when the default isn't usable
 *  (no key, provider stripped, etc.). Hardcoded DEFAULT_MODEL_ID is
 *  the final safety net so the function always returns at least one
 *  candidate.
 *
 *  De-duped while preserving order - the same (id, provider) pair only
 *  needs to be tried once even if multiple sources point at it. */
function resolveModelCandidates(): ResolvedModel[] {
  const prefs = usePreferencesStore.getState();
  const chat = useChatStore.getState();
  const out: ResolvedModel[] = [];
  const seen = new Set<string>();

  const push = (id: string | null | undefined, provider: string | null | undefined) => {
    if (!id) return;
    const info = tryGetModel(id);
    const resolvedProvider = ((provider as ProviderId | null | undefined) ??
      info?.provider ??
      chat.selectedProvider) as ProviderId;
    const key = `${resolvedProvider}::${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id,
      provider: resolvedProvider,
      label: labelFor(id, resolvedProvider),
    });
  };

  // 1. Settings default - the user's explicit "use this for commit AI".
  push(prefs.defaultModelId, prefs.defaultProviderId);
  // 2. Last chat-picker selection - what the rest of the app is using.
  push(prefs.lastModelId, prefs.lastProviderId);
  // 3. In-memory chat selection (mirrors prefs after boot).
  push(chat.selectedModelId, chat.selectedProvider);
  // 4. Hardcoded final safety net.
  push(DEFAULT_MODEL_ID, tryGetModel(DEFAULT_MODEL_ID)?.provider ?? "openai");
  return out;
}

/** Pick the first candidate whose provider has a usable key. If none do,
 *  return the first candidate anyway so the caller can surface a meaningful
 *  "no key configured" error pointing at the *intended* model. */
function pickUsableModel(apiKeys: ProviderKeys): ResolvedModel {
  const candidates = resolveModelCandidates();
  const usable = candidates.find((c) => isProviderUsable(c.provider, apiKeys));
  return usable ?? candidates[0];
}

/** Loads the staged + working-tree diff via Tauri, asks the active model
 *  to summarise it as a Conventional Commit, and returns a one-line message.
 *  Never throws - failures resolve with `fallback: true` and a deterministic
 *  message derived from the change list so the UI can still populate the
 *  input field. */
export async function generateCommitMessage(input: {
  repoPath: string;
  diff: string;
  changes: GitChange[];
}): Promise<GenerateCommitMessageResult> {
  const { diff, changes } = input;
  const { apiKeys } = useChatStore.getState();
  const prefs = usePreferencesStore.getState();
  const resolved = pickUsableModel(apiKeys);

  if (!diff || diff.trim().length === 0) {
    return {
      message: fallbackCommitMessage(changes),
      fallback: true,
      reason: "empty diff",
      modelLabel: resolved.label,
    };
  }

  // Surface a clear, actionable message when the picked model's provider
  // has no key. Without this the error bubbles up as a generic
  // `buildLanguageModel` throw and the toast looks like a network fault.
  if (!isProviderUsable(resolved.provider, apiKeys)) {
    return {
      message: fallbackCommitMessage(changes),
      fallback: true,
      reason: `no API key for ${resolved.provider} - open Settings → Models`,
      modelLabel: resolved.label,
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const model = await buildLanguageModel(resolved.provider, apiKeys, resolved.id, {
      lmstudioBaseURL: prefs.lmstudioBaseURL,
      openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
    });
    // Deliberately omit `temperature` - some providers (notably OpenAI's
    // reasoning models o1/o3 and a few openai-compatible backends) reject
    // sampling params with a 400. The strict system prompt + sanitize()
    // give us deterministic-enough output without it.
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: `<diff>\n${diff}\n</diff>`,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: controller.signal,
    });
    let cleaned = sanitize(result.text);
    if (!cleaned) {
      // Reasoning models (e.g. mimo via SumoPod) sometimes emit the final
      // answer inside `reasoning_content` and leave `text` empty - dig the
      // commit line out of the reasoning trace before giving up.
      const reasoning = (result as { reasoningText?: string }).reasoningText ?? "";
      cleaned = sanitize(salvageFromReasoning(reasoning));
    }
    if (!cleaned) {
      const finishReason = (result as { finishReason?: string }).finishReason;
      return {
        message: fallbackCommitMessage(changes),
        fallback: true,
        reason:
          finishReason === "length"
            ? "model hit the token budget before emitting the commit line"
            : "empty model response",
        modelLabel: resolved.label,
      };
    }
    return { message: cleaned, fallback: false, modelLabel: resolved.label };
  } catch (e) {
    const reason = controller.signal.aborted
      ? `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : e instanceof Error
        ? e.message
        : String(e);
    return {
      message: fallbackCommitMessage(changes),
      fallback: true,
      reason,
      modelLabel: resolved.label,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export { DIFF_BYTE_CAP };
