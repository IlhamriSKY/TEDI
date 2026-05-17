import { generateText } from "ai";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { DEFAULT_MODEL_ID, tryGetModel, type ProviderId } from "@/modules/ai/config";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { GitChange, GitChangeStatus } from "./types";

/** Hard cap on diff bytes shipped to the model. Anything past this is
 *  truncated by the Tauri host (see git_diff_full). Roughly ~20K tokens. */
const DIFF_BYTE_CAP = 80_000;

/** Upper bound on the model's response length. Commit subject lines are
 *  short; this stops a poorly-instruct-tuned model from writing a body. */
const MAX_OUTPUT_TOKENS = 200;

/** Hard timeout for the model call. Some providers can hang on network
 *  faults — we'd rather show the deterministic fallback than spin forever. */
const REQUEST_TIMEOUT_MS = 30_000;

const SYSTEM_PROMPT = `You write a single Conventional Commit message for the diff provided by the user.

OUTPUT RULES (must follow exactly):
- ONE line only — no body, no bullet points, no preamble, no closing remarks.
- Maximum 72 characters total.
- Format: <type>(<scope>)?: <subject>
  * <type> is one of: feat, fix, refactor, add, remove, docs, style, test, chore, perf, build, ci
  * <scope> is optional, lowercase, one short word in parentheses (e.g. "auth", "scm", "ui")
  * <subject> is imperative present tense ("add", "fix", "rename" — NOT "added", "fixes", "renaming")
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

/** Pick the model + provider the rest of the app considers "active". Mirrors
 *  the boot-restore logic in App.tsx so the AI commit-message generator
 *  always uses the same model the chat picker shows — including non-stock
 *  providers (openai-compatible, lmstudio, sumopod-detected, etc.) whose
 *  registry entries arrive asynchronously after a /models fetch.
 *
 *  Persisted prefs win over the in-memory chatStore because they survive a
 *  cold boot and a pre-hydration commit attempt. We trust the explicit
 *  `lastProviderId` even if the registry hasn't seen the model yet, which
 *  is the case immediately after launch for openai-compatible setups. */
function resolveActiveModel(): ResolvedModel {
  const prefs = usePreferencesStore.getState();
  const chat = useChatStore.getState();

  // 1. Persisted last pick with explicit provider — authoritative even
  //    before the dynamic registry (openai-compatible /models, sumopod)
  //    finishes loading.
  if (prefs.lastModelId && prefs.lastProviderId) {
    const info = tryGetModel(prefs.lastModelId);
    return {
      id: prefs.lastModelId,
      provider: prefs.lastProviderId as ProviderId,
      label: info?.label ?? prefs.lastModelId,
    };
  }

  // 2. Persisted last pick without saved provider (pre-fix data) — derive
  //    from registry, fall back to chatStore.selectedProvider which was
  //    wired by App.tsx boot restore.
  if (prefs.lastModelId) {
    const info = tryGetModel(prefs.lastModelId);
    return {
      id: prefs.lastModelId,
      provider: info?.provider ?? chat.selectedProvider,
      label: info?.label ?? prefs.lastModelId,
    };
  }

  // 3. Settings default. Registry may still be hydrating for runtime-
  //    detected models — fall back to chat.selectedProvider when missing.
  if (prefs.defaultModelId) {
    const info = tryGetModel(prefs.defaultModelId);
    return {
      id: prefs.defaultModelId,
      provider: info?.provider ?? chat.selectedProvider,
      label: info?.label ?? prefs.defaultModelId,
    };
  }

  // 4. In-memory chat selection (after boot it mirrors prefs).
  if (chat.selectedModelId) {
    const info = tryGetModel(chat.selectedModelId);
    return {
      id: chat.selectedModelId,
      provider: info?.provider ?? chat.selectedProvider,
      label: info?.label ?? chat.selectedModelId,
    };
  }

  // 5. Hardcoded final fallback.
  const info = tryGetModel(DEFAULT_MODEL_ID);
  return {
    id: DEFAULT_MODEL_ID,
    provider: info?.provider ?? "openai",
    label: info?.label ?? DEFAULT_MODEL_ID,
  };
}

/** Loads the staged + working-tree diff via Tauri, asks the active model
 *  to summarise it as a Conventional Commit, and returns a one-line message.
 *  Never throws — failures resolve with `fallback: true` and a deterministic
 *  message derived from the change list so the UI can still populate the
 *  input field. */
export async function generateCommitMessage(input: {
  repoPath: string;
  diff: string;
  changes: GitChange[];
}): Promise<GenerateCommitMessageResult> {
  const { diff, changes } = input;
  const resolved = resolveActiveModel();
  if (!diff || diff.trim().length === 0) {
    return {
      message: fallbackCommitMessage(changes),
      fallback: true,
      reason: "empty diff",
      modelLabel: resolved.label,
    };
  }

  const { apiKeys } = useChatStore.getState();
  const prefs = usePreferencesStore.getState();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const model = await buildLanguageModel(resolved.provider, apiKeys, resolved.id, {
      lmstudioBaseURL: prefs.lmstudioBaseURL,
      openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
    });
    // Deliberately omit `temperature` — some providers (notably OpenAI's
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
    const cleaned = sanitize(result.text);
    if (!cleaned) {
      return {
        message: fallbackCommitMessage(changes),
        fallback: true,
        reason: "empty model response",
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
