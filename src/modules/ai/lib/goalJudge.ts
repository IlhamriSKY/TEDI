import { streamText, type UIMessage } from "ai";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { resolveModelInfo } from "../config";
import { useChatStore } from "../store/chatStore";
import { buildLanguageModel } from "./agent";
import { providerRequestOptions } from "./cache";
import { goalJudgeInput, markerVerdict, parseGoalVerdict, type GoalVerdict } from "./goalRunner";

/**
 * The `/goal` evaluator: one short call per finished turn that decides whether
 * the goal is met, from the transcript rather than from the working model's own
 * say-so. The same model the chat uses, so it needs no extra key or setting.
 *
 * `streamText`, not `generateText`: the ChatGPT-account endpoint only speaks SSE
 * and refuses a non-streaming post (see runSubagent).
 */
const JUDGE_SYSTEM = `You check whether an autonomous coding agent has met its session goal. Judge ONLY from the evidence in the transcript: tool calls and their results, and what the agent reports. A claim with no evidence behind it (no command output, no test or build result, no read-back of the change) is NOT met. Open todos mean NOT met.

Reply with exactly one line, in one of these forms:
MET: <the evidence that shows it>
NOT MET: <what is still missing or unverified, concrete enough to act on next>
BLOCKED: <what only the user can provide or decide>`;

const JUDGE_TIMEOUT_MS = 90_000;

export async function judgeGoal(
  sessionId: string,
  goal: string,
  messages: UIMessage[],
): Promise<GoalVerdict> {
  const { apiKeys, selectedModelId, selectedProvider } = useChatStore.getState();
  const prefs = usePreferencesStore.getState();
  const info = resolveModelInfo(selectedModelId, selectedProvider);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JUDGE_TIMEOUT_MS);
  try {
    const model = await buildLanguageModel(info.provider, apiKeys, info.id, {
      lmstudioBaseURL: prefs.lmstudioBaseURL,
      openaiCompatibleBaseURL: prefs.openaiCompatibleBaseURL,
    });
    const result = streamText({
      model,
      system: JUDGE_SYSTEM,
      prompt: goalJudgeInput(sessionId, goal, messages),
      // Room for a reasoning model to think before its one line. Not on the
      // ChatGPT account: its backend refuses the parameter, and the main loop
      // never sends it there either.
      ...(info.provider === "chatgpt" ? {} : { maxOutputTokens: 4096 }),
      maxRetries: 1,
      abortSignal: controller.signal,
      onError: () => {},
      ...providerRequestOptions(info.provider, null, info.id),
    });
    const text = (await result.text).trim();
    const verdict =
      parseGoalVerdict(text) ?? parseGoalVerdict((await result.reasoningText) ?? "", true);
    return verdict ?? markerVerdict(messages);
  } catch {
    // An evaluator that cannot be reached must not stall the run: fall back to
    // the working model's own sign-off line.
    return markerVerdict(messages);
  } finally {
    clearTimeout(timer);
  }
}
