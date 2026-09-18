import type { ModelMessage } from "ai";
import type { ProviderId } from "../config";

/**
 * Repairs to the model-message history that every request must pass, whatever
 * the UI thread looks like. Pure, so `tool-history-verify` can drive them.
 */

type Part = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  approvalId?: string;
  providerExecuted?: boolean;
  output?: { type: string; value?: unknown };
};

const INTERRUPTED =
  "Not run: this call was interrupted before it produced a result (stopped, failed, or superseded by a new message). Re-issue it if it is still needed.";

/**
 * Give every tool call that has neither a result nor an approval response a
 * synthetic error result.
 *
 * Every provider rejects a tool call with no matching result (OpenAI-style
 * "tool_call_ids did not have response messages", Anthropic "tool_use without
 * tool_result"). A call is left that way when the user types a message instead
 * of answering its approval card, presses Stop mid-tool, or a stream dies
 * mid-tool - and since the thread is persisted, EVERY later request in that
 * chat failed with a 400, across restarts. A call whose approval response is in
 * the FINAL tool message is left alone: the SDK executes it from that response
 * on the continuation.
 */
export function closeDanglingToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const answered = new Set<string>();
  const callOfApproval = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === "string") continue;
    for (const p of m.content as Part[]) {
      if (p.type === "tool-result" && p.toolCallId) answered.add(p.toolCallId);
      else if (p.type === "tool-approval-request" && p.approvalId && p.toolCallId) {
        callOfApproval.set(p.approvalId, p.toolCallId);
      }
    }
  }
  // An approval response only gets its tool EXECUTED when it sits in the final
  // message and that message is a tool message - the SDK's own rule
  // (`collectToolApprovals`). One further up, e.g. approved and then Stopped
  // mid-run before a new user message, will never run: it is as dangling as an
  // unanswered call.
  const last = messages[messages.length - 1];
  if (last?.role === "tool") {
    for (const p of last.content as Part[]) {
      if (p.type !== "tool-approval-response" || !p.approvalId) continue;
      const call = callOfApproval.get(p.approvalId);
      if (call) answered.add(call);
    }
  }

  let changed = false;
  const out: ModelMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const missing = (m.content as Part[]).filter(
      (p) =>
        p.type === "tool-call" &&
        p.toolCallId &&
        !p.providerExecuted &&
        !answered.has(p.toolCallId),
    );
    if (!missing.length) continue;
    changed = true;
    const results = missing.map((p) => ({
      type: "tool-result" as const,
      toolCallId: p.toolCallId!,
      toolName: p.toolName ?? "tool",
      output: { type: "error-text" as const, value: INTERRUPTED },
    }));
    const next = messages[i + 1];
    if (next?.role === "tool") {
      out.push({ ...next, content: [...next.content, ...results] } as ModelMessage);
      i++;
    } else {
      out.push({ role: "tool", content: results } as ModelMessage);
    }
  }
  return changed ? out : messages;
}

/**
 * Providers whose SDK flattens a tool result to ONE string: `@ai-sdk/openai-
 * compatible` `JSON.stringify`s a `content` output, so an image a tool returned
 * (read_file on a PNG, a browser capture, an MCP screenshot) went out as up to
 * megabytes of base64 TEXT, re-sent on every step and sitting in the protected
 * recent tail where over-context recovery cannot clear it.
 */
export const TEXT_ONLY_TOOL_RESULTS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "deepseek",
  "sumopod",
  "agentrouter",
  "openai-compatible",
  "lmstudio",
  // Same flattening in their own SDKs (checked in dist): groq and xai stringify
  // a `content` output, and cerebras is built on openai-compatible.
  "groq",
  "xai",
  "cerebras",
]);

const MEDIA_NOTE =
  "[image/file omitted: this provider cannot receive media inside a tool result. Describe what you need from it instead, or use a vision-capable provider.]";

/** Replace non-text parts of `content` tool results with a one-line note. */
export function stripToolResultMedia(messages: ModelMessage[]): ModelMessage[] {
  let changed = false;
  const out = messages.map((m) => {
    if (m.role !== "tool") return m;
    let touched = false;
    const content = (m.content as Part[]).map((p) => {
      if (p.type !== "tool-result" || p.output?.type !== "content") return p;
      const value = Array.isArray(p.output.value) ? (p.output.value as { type: string }[]) : [];
      if (value.every((v) => v.type === "text")) return p;
      touched = true;
      return {
        ...p,
        output: {
          type: "content",
          value: value.map((v) => (v.type === "text" ? v : { type: "text", text: MEDIA_NOTE })),
        },
      };
    });
    if (!touched) return m;
    changed = true;
    return { ...m, content } as ModelMessage;
  });
  return changed ? out : messages;
}

const BLOB = /^[A-Za-z0-9+/=\s]{2000,}$/;

/** A past result rendered as bounded text: long base64 blobs dropped, 20K cap. */
function boundedJson(output: unknown): string {
  let s: string;
  try {
    s =
      typeof output === "string"
        ? output
        : (JSON.stringify(output, (_k, v) =>
            typeof v === "string" && BLOB.test(v) ? `[binary omitted, ${v.length} chars]` : v,
          ) ?? "");
  } catch {
    s = String(output);
  }
  return s.length > 20_000 ? `${s.slice(0, 20_000)}… [truncated]` : s;
}

/**
 * The tool set to convert HISTORY with: every tool that exists (not just the
 * ones this turn sends) plus a stub for any name the thread mentions that no
 * longer exists at all.
 *
 * The SDK applies each tool's `toModelOutput` only when that tool is in the set
 * it is given; otherwise it replays the raw `execute` return as JSON. Converting
 * with the FILTERED set meant switching a tool off in the picker, a server
 * failing to connect, or an extension being disabled turned its past screenshots
 * into ~270K characters of base64 on every request for the rest of the session.
 */
export function historyToolSet<T extends object>(
  known: Record<string, T>,
  messages: { parts: unknown[] }[],
): Record<string, T> {
  let out: Record<string, T> | null = null;
  for (const m of messages) {
    for (const p of m.parts as { type?: string; toolName?: string }[]) {
      const name =
        p.type === "dynamic-tool"
          ? p.toolName
          : p.type?.startsWith("tool-")
            ? p.type.slice(5)
            : null;
      if (!name || name in known || (out && name in out)) continue;
      out ??= { ...known };
      out[name] = {
        toModelOutput: ({ output }: { output: unknown }) => ({
          type: "text",
          value: boundedJson(output),
        }),
      } as unknown as T;
    }
  }
  return out ?? known;
}

const STOPPED = "Stopped by the user before this finished.";
const UNFINISHED = new Set([
  "input-streaming",
  "input-available",
  "approval-requested",
  "approval-responded",
]);

/**
 * After a Stop, close every tool part of the last message that never finished.
 *
 * WHY THIS IS WHAT MAKES STOP STOP. Our transport ends an aborted stream
 * GRACEFULLY (`streamText` emits an `abort` chunk and closes), so the SDK's
 * `makeRequest` does not see a thrown abort and goes on to its
 * `sendAutomaticallyWhen` check. A tool that was approved and running is still
 * `approval-responded` there, the check says "approved, waiting to run", and
 * the SDK sent the turn again - re-running the stopped command from scratch.
 * Measured: Stop at 230s, a new request the same second, the 30s command ran to
 * 262s. The same tail also held the composer's queue and `/goal` forever, and a
 * card left `approval-requested` was auto-approved by yolo afterwards.
 *
 * `output-error` is terminal: nothing re-sends it, nothing auto-approves it,
 * and the next request replays it as an ordinary error result.
 */
export function settleInterruptedToolParts<M extends { role: string; parts: unknown[] }>(
  messages: M[],
): M[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;
  let changed = false;
  const parts = (last.parts as { type?: string; state?: string }[]).map((p) => {
    const tool = p.type === "dynamic-tool" || p.type?.startsWith("tool-");
    if (!tool || !UNFINISHED.has(p.state ?? "")) return p;
    changed = true;
    // `input` is still undefined on a part stopped mid-stream; replayed as a
    // tool call with no input it is a 400 on every provider, for good.
    const input = (p as { input?: unknown }).input ?? {};
    return { ...p, input, state: "output-error", errorText: STOPPED };
  });
  if (!changed) return messages;
  return [...messages.slice(0, -1), { ...last, parts } as M];
}
