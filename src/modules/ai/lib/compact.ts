import type { ModelMessage } from "ai";

const KEEP_TAIL = 24;
const ELISION_TEXT = "[elided to save context — see prior tool call in history]";

type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  [k: string]: unknown;
};

function approxBytes(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") n += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content as ToolPart[]) {
        if (part.type === "text" && typeof part.text === "string")
          n += (part.text as string).length;
        else if (part.type === "tool-result")
          n += JSON.stringify(part.output ?? "").length;
        else if (part.type === "tool-call")
          n += JSON.stringify(part.input ?? "").length;
        else n += 64;
      }
    }
  }
  return n;
}

function elideToolResult(part: ToolPart): { changed: boolean; part: ToolPart } {
  if (part.type !== "tool-result") return { changed: false, part };
  if (
    part.output &&
    typeof part.output === "object" &&
    (part.output as { __elided?: boolean }).__elided
  ) {
    return { changed: false, part };
  }
  return {
    changed: true,
    part: {
      ...part,
      output: { type: "text", value: ELISION_TEXT, __elided: true },
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
 *  redundant — they return different windows of content. */
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

function collectLastReadIdxPerKey(
  messages: ModelMessage[],
): Map<string, number> {
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
      const isStale =
        // Mutated since: every page of this path is potentially stale.
        mutated.has(entry.path) ||
        // Same (path+offset+limit) read appears later: this one is redundant.
        (lastReadKey.has(entry.key) &&
          (lastReadKey.get(entry.key) as number) > i);
      if (!isStale) return part;
      const r = elideToolResult(part);
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

/** Two-stage compaction:
 *   1. At 55% of context: drop superseded read_file results (cheap wins,
 *      no information loss because the latest read / the mutation is still
 *      in history).
 *   2. At 70% of context: elide older tool-result blocks, oldest first,
 *      until we're back under 60% — keeping the last KEEP_TAIL messages
 *      intact and never touching system messages.
 *  System / lite-model callers can pass smaller contextLimit values to
 *  trigger compaction sooner. */
export function compactModelMessagesDetailed(
  messages: ModelMessage[],
  contextLimit: number,
): CompactResult {
  let dropped = 0;
  let working = messages;
  let approxTokens = approxBytes(working) / 4;

  if (approxTokens >= 0.55 * contextLimit) {
    const r = dropSupersededReads(working);
    if (r.touched) {
      working = r.out;
      dropped++;
      approxTokens = approxBytes(working) / 4;
    }
  }

  if (approxTokens < 0.7 * contextLimit) {
    return {
      messages: working,
      compacted: dropped > 0,
      droppedCount: dropped,
    };
  }

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
      if (approxBytes(out) / 4 < 0.6 * contextLimit) break;
    }
  }

  return {
    messages: out,
    compacted: dropped > 0,
    droppedCount: dropped,
  };
}
