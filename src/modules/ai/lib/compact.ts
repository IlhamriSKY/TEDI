import type { ModelMessage } from "ai";
import type { ProviderId } from "../config";
import { providerHasPromptCache } from "./cache";

const KEEP_TAIL = 24;
/** Elision markers. Earlier wording ("see prior tool call in history") nudged
 *  lite models into re-issuing the same call. These versions explicitly tell
 *  the model not to retry, because either a fresher read is downstream or the
 *  file has been mutated. */
const ELISION_TEXT =
  "[elided - newer output for this call is already further down in the conversation. Do not retry.]";
const ELISION_TEXT_MUTATED =
  "[elided - this file has been modified since; the post-mutation read is below. Do not re-read this snapshot.]";

type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  [k: string]: unknown;
};

/** Per-message byte cache. The React adapter's `replaceMessage` deep-clones
 *  via `structuredClone` on every state mutation, so a mutated message lands
 *  here under a new reference. WeakMap key identity = content-stable. Turns
 *  Stage 2's inner loop from O(N^2) JSON.stringify into O(N) amortized. */
const bytesCache = new WeakMap<ModelMessage & object, number>();

function bytesForMessage(m: ModelMessage): number {
  const key = m as ModelMessage & object;
  const cached = bytesCache.get(key);
  if (cached !== undefined) return cached;
  let n = 0;
  if (typeof m.content === "string") n += m.content.length;
  else if (Array.isArray(m.content)) {
    for (const part of m.content as ToolPart[]) {
      if (part.type === "text" && typeof part.text === "string") n += (part.text as string).length;
      else if (part.type === "tool-result") n += JSON.stringify(part.output ?? "").length;
      else if (part.type === "tool-call") n += JSON.stringify(part.input ?? "").length;
      else n += 64;
    }
  }
  bytesCache.set(key, n);
  return n;
}

function approxBytes(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) n += bytesForMessage(m);
  return n;
}

function elideToolResult(
  part: ToolPart,
  reason: "superseded" | "mutated" = "superseded",
): { changed: boolean; part: ToolPart } {
  if (part.type !== "tool-result") return { changed: false, part };
  if (
    part.output &&
    typeof part.output === "object" &&
    (part.output as { __elided?: boolean }).__elided
  ) {
    return { changed: false, part };
  }
  const value = reason === "mutated" ? ELISION_TEXT_MUTATED : ELISION_TEXT;
  return {
    changed: true,
    part: {
      ...part,
      output: { type: "text", value, __elided: true },
    },
  };
}

function pathOfInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const p = (input as { path?: unknown }).path;
  return typeof p === "string" && p.length > 0 ? p : null;
}

/** Key for a read_file call that distinguishes paged reads of the same path.
 *  Two reads of `foo.ts` at different offsets return different windows. */
function readKeyOfInput(input: unknown): string | null {
  const path = pathOfInput(input);
  if (!path) return null;
  if (!input || typeof input !== "object") return path;
  const i = input as { offset?: unknown; limit?: unknown };
  const off = typeof i.offset === "number" ? i.offset : 0;
  const lim = typeof i.limit === "number" ? i.limit : "*";
  return `${path}#${off}:${lim}`;
}

function collectLastMutationIdxPerPath(messages: ModelMessage[]): Map<string, number> {
  const paths = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call") continue;
      const name = part.toolName;
      if (
        name === "edit" ||
        name === "multi_edit" ||
        name === "write_file" ||
        name === "create_directory"
      ) {
        const p = pathOfInput(part.input);
        if (p) paths.set(p, i);
      }
    }
  }
  return paths;
}

function collectLastReadIdxPerKey(messages: ModelMessage[]): Map<string, number> {
  const lastIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call") continue;
      if (part.toolName !== "read_file") continue;
      const k = readKeyOfInput(part.input);
      if (k) lastIdx.set(k, i);
    }
  }
  return lastIdx;
}

/** Replace stale read_file tool-results with an elision marker. Stale = there
 *  is a later read of the same path, or the path has been mutated since.
 *  Keeps the freshest read so the agent's view stays current. */
function dropSupersededReads(messages: ModelMessage[]): {
  out: ModelMessage[];
  touched: boolean;
} {
  const lastMutationIdx = collectLastMutationIdxPerPath(messages);
  const lastReadKey = collectLastReadIdxPerKey(messages);

  // Map toolCallId to (path, readKey) for mutation (path) and supersession (paged key) lookups.
  const callIdxToRead = new Map<string, { path: string; key: string }>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call" || part.toolName !== "read_file") continue;
      const path = pathOfInput(part.input);
      const key = readKeyOfInput(part.input);
      const id = part.toolCallId;
      if (path && key && typeof id === "string") {
        callIdxToRead.set(id, { path, key });
      }
    }
  }

  let touched = false;
  const out = messages.map((m, i): ModelMessage => {
    if (!Array.isArray(m.content)) return m;
    let local = false;
    const nextContent = (m.content as ToolPart[]).map((part) => {
      if (part.type !== "tool-result") return part;
      const id = part.toolCallId;
      if (typeof id !== "string") return part;
      const entry = callIdxToRead.get(id);
      if (!entry) return part;
      const mutationIdx = lastMutationIdx.get(entry.path);
      // A read is stale only when the mutation happened after that result. A
      // fresh post-edit read must remain visible to the model.
      const wasMutated = mutationIdx !== undefined && mutationIdx > i;
      const wasSuperseded =
        lastReadKey.has(entry.key) && (lastReadKey.get(entry.key) as number) > i;
      if (!wasMutated && !wasSuperseded) return part;
      const r = elideToolResult(part, wasMutated ? "mutated" : "superseded");
      if (r.changed) local = true;
      return r.part;
    });
    if (!local) return m;
    touched = true;
    return { ...m, content: nextContent } as ModelMessage;
  });
  return { out, touched };
}

export type CompactStages = {
  /** Stage 1: superseded read_file results elided. Lossless. */
  lossless: number;
  /** Stage 2: older tool-result blocks elided to reclaim context. */
  elided: number;
  /** Stage 3: oldest non-system messages hard-dropped. Loses information. */
  dropped: number;
};

export type CompactResult = {
  messages: ModelMessage[];
  /** True when any stage touched messages, including Stage 1 dedup. */
  compacted: boolean;
  /** Sum of all stages. Prefer `stages` for accurate reporting. */
  droppedCount: number;
  stages: CompactStages;
};

/** Minimum trailing messages preserved by Stage 3. Better to send over-budget
 *  and let the provider error than to lose the user's most recent turn. */
const MIN_TAIL = Math.min(KEEP_TAIL, 8);

/** Three-stage compaction. Masking observations beats LLM summarisation on both
 *  tokens and quality.
 *
 *  1. Always: elide superseded read_file results. Lossless, and doubles as an
 *     anti-loop guard - the freshest read is still in history.
 *  2. At 72% of context: elide older tool results, oldest first, until under
 *     60%. Keeps the last KEEP_TAIL and all system messages.
 *  3. Still over 85%: hard-drop oldest non-system messages until under 72%. The
 *     only stage that loses information.
 *
 *  `skipHardDrop` disables stage 3 for between-step compaction, where dropping a
 *  message could orphan a subagent brief or leave an assistant-first prompt.
 *  Stages 1-2 only rewrite tool-result OUTPUT, so they stay pairing-safe. */
export function compactModelMessagesDetailed(
  messages: ModelMessage[],
  contextLimit: number,
  opts?: { skipHardDrop?: boolean },
): CompactResult {
  const stages: CompactStages = { lossless: 0, elided: 0, dropped: 0 };
  let working = messages;

  // Stage 1: elide superseded reads. Runs every turn (anti-loop, not just budget).
  {
    const r = dropSupersededReads(working);
    if (r.touched) {
      working = r.out;
      stages.lossless++;
    }
  }
  let approxTokens = approxBytes(working) / 4;

  // Stage 2: elide older tool-result blocks until under 60% or KEEP_TAIL reached.
  if (approxTokens >= 0.72 * contextLimit) {
    const out = working.slice();
    const stopIdx = Math.max(0, out.length - KEEP_TAIL);
    for (let i = 0; i < stopIdx; i++) {
      if (out[i].role === "system") continue;
      if (!Array.isArray(out[i].content)) continue;
      let local = false;
      const next = (out[i].content as ToolPart[]).map((part) => {
        const r = elideToolResult(part);
        if (r.changed) local = true;
        return r.part;
      });
      if (local) {
        out[i] = { ...out[i], content: next } as ModelMessage;
        stages.elided++;
        if (approxBytes(out) / 4 < 0.6 * contextLimit) break;
      }
    }
    working = out;
    approxTokens = approxBytes(working) / 4;
  }

  // Stage 3: conversation itself exceeds the window (huge pastes, runaway
  // streaming). Elision isn't enough; hard-drop oldest non-system messages.
  if (!opts?.skipHardDrop && approxTokens >= 0.85 * contextLimit) {
    const systemPrefix: ModelMessage[] = [];
    const rest: ModelMessage[] = [];
    for (const m of working) {
      if (m.role === "system" && rest.length === 0) systemPrefix.push(m);
      else rest.push(m);
    }
    // Trailing messages to keep. Tighten when context is hugely over so we
    // can fit; relax to KEEP_TAIL on minor overruns.
    const tail =
      approxTokens >= 2 * contextLimit
        ? MIN_TAIL
        : Math.min(KEEP_TAIL, Math.max(MIN_TAIL, rest.length - 1));
    const stopIdx = Math.max(0, rest.length - tail);
    let cut = 0;
    let runningTokens = approxTokens;
    while (cut < stopIdx && runningTokens >= 0.72 * contextLimit) {
      const drop = rest[cut];
      const dropTokens = approxBytes([drop]) / 4;
      runningTokens -= dropTokens;
      cut++;
      stages.dropped++;
    }
    if (cut > 0) {
      // Don't keep an orphaned tool-result at the head: convertToModelMessages
      // emits the assistant tool-call and its tool result as separate messages,
      // and a provider rejects a tool_result whose tool_use was just dropped.
      while (cut < rest.length && rest[cut].role === "tool") {
        cut++;
        stages.dropped++;
      }
      working = [...systemPrefix, ...rest.slice(cut)];
    }
  }

  const total = stages.lossless + stages.elided + stages.dropped;
  return {
    messages: working,
    compacted: total > 0,
    droppedCount: total,
    stages,
  };
}

/** Hard-drop oldest UI messages so the persisted list stays under a soft cap.
 *  Used by the `/compact` slash command. Callers should write the returned
 *  array back into the Chat instance and persist it. */
export type UICompactResult = { kept: number; dropped: number };

export function compactUiMessages<
  T extends {
    role: string;
    parts?: Array<{
      type?: string;
      text?: string;
      input?: unknown;
      output?: unknown;
    }>;
  },
>(
  messages: T[],
  opts: {
    contextLimit: number;
    keepTail?: number;
    /** Bypass the auto threshold gate. /compact wants visible action even at
     *  moderate context; trailing `keepTail` messages are still preserved. */
    force?: boolean;
  },
): {
  messages: T[];
  info: UICompactResult;
} {
  const keepTail = opts.keepTail ?? KEEP_TAIL;
  const tokensFor = (m: T): number => {
    let n = 0;
    for (const p of m.parts ?? []) {
      if (typeof p.type !== "string") continue;
      if (p.type === "text" || p.type === "reasoning") n += (p.text ?? "").length;
      else if (p.type.startsWith("tool-")) {
        if (p.input) n += JSON.stringify(p.input).length;
        if (p.output) n += JSON.stringify(p.output).length;
      }
    }
    return Math.ceil(n / 4);
  };
  let total = messages.reduce((sum, m) => sum + tokensFor(m), 0);
  const stopIdx = Math.max(0, messages.length - keepTail);

  // Auto path: no-op when comfortably under threshold. `force` skips this gate.
  if (!opts.force && total < 0.7 * opts.contextLimit) {
    return { messages, info: { kept: messages.length, dropped: 0 } };
  }

  // Nothing to drop without violating tail guarantee; surface as zero-drop.
  if (stopIdx === 0) {
    return { messages, info: { kept: messages.length, dropped: 0 } };
  }

  let cut = 0;
  if (total >= 0.7 * opts.contextLimit) {
    // Over threshold: drop oldest until under 50% of the window.
    while (cut < stopIdx && total >= 0.5 * opts.contextLimit) {
      total -= tokensFor(messages[cut]);
      cut++;
    }
  } else {
    // Force at moderate context: drop roughly the oldest quarter so /compact
    // shows real progress, but never less than one message.
    cut = Math.max(1, Math.floor(stopIdx / 4));
  }

  return {
    messages: messages.slice(cut),
    info: { kept: messages.length - cut, dropped: cut },
  };
}

/**
 * Drop every tool call, result, and approval from a history, keeping the text.
 * For chat mode, which declares no tools: a leftover `tool_use` with no matching
 * definition is a 400 on Anthropic and an orphan elsewhere, so this is a
 * correctness fix as much as a saving. Assistant messages left empty are dropped
 * whole rather than sent blank.
 */
export function stripToolTraffic(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "tool") continue;
    if (m.role !== "assistant" || typeof m.content === "string") {
      out.push(m);
      continue;
    }
    const content = m.content.filter(
      (p) =>
        p.type !== "tool-call" && p.type !== "tool-result" && p.type !== "tool-approval-request",
    );
    if (content.length > 0) out.push({ ...m, content });
  }
  return out;
}

/** Token budget for BETWEEN-step compaction within one turn. Decoupled from the
 *  model's context window on purpose: an unknown model falls back to a 512K
 *  limit, so window-based compaction never fires mid-loop and the tool pile is
 *  re-sent whole every step. One constant, not a per-model table. */
export const RESEND_COMPACTION_BUDGET = 80_000;

/** Below this fraction of the budget, per-step compaction is not worth doing on
 *  a provider that caches: rewriting an old message invalidates the cached
 *  prefix after it, so a small saving costs a full re-read at write price. */
const CACHED_PROVIDER_COMPACTION_FLOOR = 0.75;

/** Compact the per-step message set handed to prepareStep. Elide-only (Stage 3
 *  hard-drop disabled) so it can never orphan a tool_call/tool_result pair or the
 *  task brief mid-loop, and idempotent: the AI SDK re-derives the full history
 *  from its own accumulator each step, so this only shrinks what THIS step sends
 *  to the provider - the loop's own state and result.steps stay complete.
 *
 *  This exists for gateways with NO prompt cache, where the growing tool pile is
 *  re-sent in full every step. On a caching provider it is counterproductive
 *  until the payload is actually large, because eliding an old result busts the
 *  prefix: there, only run once the payload approaches the budget.
 *
 *  Cache breakpoints are re-applied by the caller (`applyStepCacheBreakpoints`),
 *  not here, so the two concerns stay separable. */
export function compactStepMessages(
  messages: ModelMessage[],
  provider?: ProviderId,
): ModelMessage[] {
  if (provider && providerHasPromptCache(provider)) {
    const tokens = approxBytes(messages) / 4;
    if (tokens < RESEND_COMPACTION_BUDGET * CACHED_PROVIDER_COMPACTION_FLOOR) return messages;
  }
  return compactModelMessagesDetailed(messages, RESEND_COMPACTION_BUDGET, {
    skipHardDrop: true,
  }).messages;
}
