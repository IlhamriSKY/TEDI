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

/** Max diff bytes sent to the model (~20K tokens). Host truncates past this. */
const DIFF_BYTE_CAP = 80_000;

/**
 * Output token cap. Generous so reasoning models (o1/o3, deepseek-reasoner)
 * have budget left for the answer after their thinking trace. `sanitize()`
 * still clamps the final line to 72 chars.
 */
const MAX_OUTPUT_TOKENS = 4096;

/** Model call timeout. Falls back to a deterministic message rather than hang. */
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

/** Deterministic fallback when the model fails or the diff is empty. Picks a Conventional Commit type from the change mix. */
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

/** Conventional Commit shape. Used to pull the commit line out of a reasoning trace when `text` is empty. */
const COMMIT_LINE_RE =
  /^\s*(feat|fix|refactor|add|remove|docs|style|test|chore|perf|build|ci)(\([^)]+\))?:\s+.+$/im;

/** Scan reasoning text bottom-up for a Conventional Commit line. The last match is the safest pick. */
function salvageFromReasoning(reasoning: string): string {
  if (!reasoning) return "";
  const lines = reasoning.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (COMMIT_LINE_RE.test(line)) return line;
  }
  return "";
}

/** Strip stray markdown and quoting; clamp to 72 chars. */
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
  /** True when the deterministic fallback was used. */
  fallback: boolean;
  /** Reason for falling back: network, no-key, no-diff, truncated, etc. */
  reason?: string;
  /** Label of the model attempted. Surfaced in toasts. */
  modelLabel?: string;
};

type ResolvedModel = {
  id: string;
  provider: ProviderId;
  label: string;
};

/** Display label for an (id, provider) pair. Trusts an explicit provider when supplied (some ids exist under multiple providers). */
function labelFor(id: string, provider: ProviderId | null): string {
  const info = tryGetModel(id);
  if (provider && info?.provider === provider) return info.label;
  if (provider) {
    const providerLabel = PROVIDERS.find((p) => p.id === provider)?.label;
    return providerLabel ? `${id} · ${providerLabel}` : id;
  }
  return info?.label ?? id;
}

/** True when the provider has a key, or doesn't need one. */
function isProviderUsable(provider: ProviderId, apiKeys: ProviderKeys): boolean {
  if (!providerNeedsKey(provider)) return true;
  return !!apiKeys[provider];
}

/**
 * Prioritized (id, provider) candidates. Order: Settings default, chat picker's
 * last pick, in-memory chat selection, `DEFAULT_MODEL_ID` as safety net.
 * De-duped while preserving order.
 */
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

  // Settings default.
  push(prefs.defaultModelId, prefs.defaultProviderId);
  // Last chat-picker selection.
  push(prefs.lastModelId, prefs.lastProviderId);
  // In-memory chat selection.
  push(chat.selectedModelId, chat.selectedProvider);
  // Hardcoded fallback.
  push(DEFAULT_MODEL_ID, tryGetModel(DEFAULT_MODEL_ID)?.provider ?? "openai");
  return out;
}

/** First candidate with a usable key. Falls back to the first candidate so the caller can surface a clear "no key" error. */
function pickUsableModel(apiKeys: ProviderKeys): ResolvedModel {
  const candidates = resolveModelCandidates();
  const usable = candidates.find((c) => isProviderUsable(c.provider, apiKeys));
  return usable ?? candidates[0];
}

/**
 * Asks the active model to summarize the diff as a one-line Conventional Commit.
 * Never throws; failures resolve with `fallback: true` and a deterministic message.
 */
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

  // Surface a clear "no key" message instead of a generic build error.
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
    // Omit `temperature`. OpenAI reasoning models and some compatible
    // backends reject sampling params with a 400.
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: `<diff>\n${diff}\n</diff>`,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: controller.signal,
    });
    let cleaned = sanitize(result.text);
    if (!cleaned) {
      // Some reasoning models put the answer in `reasoning_content` and leave `text` empty.
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
