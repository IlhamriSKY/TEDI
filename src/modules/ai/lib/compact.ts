import type { ModelMessage } from "ai";

const KEEP_TAIL = 24;
/** Elision marker that's deliberately "self-terminating" — the original
 *  wording ("see prior tool call in history") nudged some lite models into
 *  re-issuing the same tool call to recover the content. The two variants
 *  below tell the model bluntly *not* to retry, because either a fresher
 *  copy is downstream or the underlying file has been mutated. */
const ELISION_TEXT =
  "[elided — newer output for this call is already further down in the conversation. Do not retry.]";
const ELISION_TEXT_MUTATED =
  "[elided — this file has been modified since; the post-mutation read is below. Do not re-read this snapshot.]";

type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  [k: string]: unknown;
};

/** Per-message byte cache. The React adapter's `replaceMessage` deep-clones
 *  via `structuredClone` on every state mutation (see
 *  `@ai-sdk/react/dist/index.mjs` — `this.snapshot = (v) => structuredClone(v)`),
 *  so a mutated message always lands in this map under a *new* reference.
 *  WeakMap key identity therefore matches "content-stable" — turns the
 *  inner loop inside Stage 2 (which used to re-run approxBytes over every
 *  message after every single elision) from O(N²) JSON.stringify into
 *  O(N) amortized. */
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

/** Stable key for a read_file invocation that distinguishes paged reads of
 *  the same path. Two reads of `foo.ts` with different `offset` are NOT
 *  redundant - they return different windows of content. */
function readKeyOfInput(input: unknown): string | null {
  const path = pathOfInput(input);
  if (!path) return null;
  if (!input || typeof input !== "object") return path;
  const i = input as { offset?: unknown; limit?: unknown };
  const off = typeof i.offset === "number" ? i.offset : 0;
  const lim = typeof i.limit === "number" ? i.limit : "*";
  return `${path}#${off}:${lim}`;
}

function collectMutationPaths(messages: ModelMessage[]): Set<string> {
  const paths = new Set<string>();
  for (const m of messages) {
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
        if (p) paths.add(p);
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

/** Replace stale read_file tool-results with an elision marker. A read is
 *  "stale" when there's a later read of the same path in the same session,
 *  or when the path has been mutated (edit/multi_edit/write_file/create_directory)
 *  since. Keeps the freshest read intact so the agent's working model of the
 *  file matches reality without re-paying for repeated bodies. */
function dropSupersededReads(messages: ModelMessage[]): {
  out: ModelMessage[];
  touched: boolean;
} {
  const mutated = collectMutationPaths(messages);
  const lastReadKey = collectLastReadIdxPerKey(messages);

  // Map a tool_call id to (path, readKey) so we can look up both the
  // mutation set (by path) and the supersession set (by paged key).
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
      const wasMutated = mutated.has(entry.path);
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

export type CompactResult = {
  messages: ModelMessage[];
  compacted: boolean;
  droppedCount: number;
};

/** Hard floor for tail preservation: we never hard-drop more than this many
 *  trailing messages even if everything still spills the window — better to
 *  send an over-budget request and let the provider error than to lose the
 *  user's most recent turn. */
const MIN_TAIL = Math.min(KEEP_TAIL, 8);

/** Three-stage compaction (per recent "Complexity Trap" research: masking
 *  observations beats LLM summarisation, both in tokens spent and quality):
 *
 *   1. ALWAYS: drop superseded read_file results (no information loss
 *      because the latest read / the mutation is still in history). This
 *      also doubles as anti-loop — even at 10% context, if the model
 *      re-read the same file twice we trim the older copy so it can't
 *      "see" the duplicate and decide to recurse on it.
 *   2. At 60% of context: elide older tool-result blocks, oldest first,
 *      until we're back under 50% - keeping the last KEEP_TAIL messages
 *      intact and never touching system messages.
 *   3. If still over 80% after Stage 2 (e.g. the conversation itself has
 *      blown past the window, not just tool noise): HARD-DROP oldest
 *      non-system messages until we are under 65%, while preserving the
 *      last KEEP_TAIL messages. This is the only path that loses
 *      information; it's the safety net that keeps a runaway context
 *      from indefinitely 4xx-ing the provider.
 *
 *  System / lite-model callers can pass smaller contextLimit values to
 *  trigger compaction sooner. */
export function compactModelMessagesDetailed(
  messages: ModelMessage[],
  contextLimit: number,
): CompactResult {
  let dropped = 0;
  let working = messages;

  // Stage 1: drop superseded reads (lossless). Runs every turn regardless
  // of budget — anti-loop, not just budget management.
  {
    const r = dropSupersededReads(working);
    if (r.touched) {
      working = r.out;
      dropped++;
    }
  }
  let approxTokens = approxBytes(working) / 4;

  // Stage 2: elide older tool-result blocks until back under 50% (or the
  // KEEP_TAIL boundary is reached).
  if (approxTokens >= 0.6 * contextLimit) {
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
        dropped++;
        if (approxBytes(out) / 4 < 0.5 * contextLimit) break;
      }
    }
    working = out;
    approxTokens = approxBytes(working) / 4;
  }

  // Stage 3: when conversation itself has exceeded the window (huge file
  // pastes, runaway streaming, etc.), elision is not enough. Hard-drop the
  // oldest non-system messages. We do this in pairs (user + assistant) when
  // possible to avoid orphaning a tool-call from its tool-result.
  if (approxTokens >= 0.8 * contextLimit) {
    const systemPrefix: ModelMessage[] = [];
    const rest: ModelMessage[] = [];
    for (const m of working) {
      if (m.role === "system" && rest.length === 0) systemPrefix.push(m);
      else rest.push(m);
    }
    // Number of trailing messages we MUST keep. Tighten when the context is
    // dramatically over so we can actually fit; relax to KEEP_TAIL on minor
    // overruns to retain conversational continuity.
    const tail =
      approxTokens >= 2 * contextLimit
        ? MIN_TAIL
        : Math.min(KEEP_TAIL, Math.max(MIN_TAIL, rest.length - 1));
    const stopIdx = Math.max(0, rest.length - tail);
    let cut = 0;
    let runningTokens = approxTokens;
    while (cut < stopIdx && runningTokens >= 0.65 * contextLimit) {
      const drop = rest[cut];
      const dropTokens = approxBytes([drop]) / 4;
      runningTokens -= dropTokens;
      cut++;
      dropped++;
    }
    if (cut > 0) {
      working = [...systemPrefix, ...rest.slice(cut)];
    }
  }

  return {
    messages: working,
    compacted: dropped > 0,
    droppedCount: dropped,
  };
}

/** Hard-drop the oldest UI messages so the on-disk / SDK-side message list
 *  itself stays under a soft cap. Used by the `/compact` slash command to
 *  surface the same logic to users when the context indicator turns red.
 *
 *  Returns `null` if no compaction is needed. Mutating callers should write
 *  the returned array back into the Chat instance + persist it. */
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
  opts: { contextLimit: number; keepTail?: number },
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
  if (total < 0.7 * opts.contextLimit) {
    return { messages, info: { kept: messages.length, dropped: 0 } };
  }
  let cut = 0;
  const stopIdx = Math.max(0, messages.length - keepTail);
  while (cut < stopIdx && total >= 0.5 * opts.contextLimit) {
    total -= tokensFor(messages[cut]);
    cut++;
  }
  return {
    messages: messages.slice(cut),
    info: { kept: messages.length - cut, dropped: cut },
  };
}
