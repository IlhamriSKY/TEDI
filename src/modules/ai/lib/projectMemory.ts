/**
 * The workspace-root memory docs and the budget that bounds them.
 *
 * Pure and dependency-free on purpose: `transport.ts` (which reads the files)
 * pulls in the chat store and the AI SDK, so nothing there can be driven from a
 * node script. `scripts/ai/project-memory-verify.ts` drives this instead.
 */

/**
 * Read in this order, and both when both exist. AGENTS.md is the cross-tool
 * project brief every agent CLI already looks for, so a repo carrying one gets
 * TEDI's agent oriented for free; TEDI.md is TEDI's own and goes LAST, nearest
 * the conversation, which is the side that should win where the two disagree.
 */
export const PROJECT_MEMORY_FILES = ["AGENTS.md", "TEDI.md"] as const;

/**
 * Preload budget for those docs, SHARED between them rather than granted to
 * each. They land in the cacheable system-prompt prefix of every turn, so an
 * exhaustive doc (this repo's own TEDI.md was >70 KB) would dominate the prompt
 * even for a "hi", and adding an AGENTS.md beside a TEDI.md must not silently
 * double what every request pays. The rest stays one `read_file` away.
 */
export const PROJECT_MEMORY_PRELOAD_BYTES = 12 * 1024;

/** A directory entry, structurally: `native.DirEntry` without importing it, so
 *  this file keeps its zero runtime dependencies. */
type NamedEntry = { name: string };
/** `native.readFile`, structurally. Injected so the selection and assembly below
 *  can be driven against a fake filesystem by
 *  `scripts/ai/project-memory-verify.ts`, which is the only way to PROVE both
 *  docs are read: the real caller sits behind the Tauri IPC. */
type ReadTextFile = (path: string) => Promise<{ kind: string; content?: string }>;

/** The memory docs present in a workspace root, in `PROJECT_MEMORY_FILES` order.
 *  Case-folded, because Windows and macOS hand back `Agents.md` for a file the
 *  repo committed as `AGENTS.md` and an exact match would preload nothing. */
export function selectProjectMemoryDocs<T extends NamedEntry>(entries: readonly T[]): T[] {
  return PROJECT_MEMORY_FILES.map((name) =>
    entries.find((e) => e.name.toLowerCase() === name.toLowerCase()),
  ).filter((e) => e !== undefined);
}

/** Read the selected docs into one block, each under its own `### <name>` header.
 *  The budget is SPLIT across the docs that exist, never granted to each: adding
 *  an AGENTS.md beside a TEDI.md must not silently double what every request
 *  pays for its cached prefix. */
export async function assembleProjectMemory(
  root: string,
  docs: readonly NamedEntry[],
  readFile: ReadTextFile,
): Promise<string | null> {
  const budget = Math.floor(PROJECT_MEMORY_PRELOAD_BYTES / Math.max(docs.length, 1));
  const blocks: string[] = [];
  for (const doc of docs) {
    const r = await readFile(`${root}/${doc.name}`);
    if (r.kind !== "text" || r.content === undefined) continue;
    const body = boundProjectMemory(r.content, budget, doc.name);
    if (body) blocks.push(`### ${doc.name}\n${body}`);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

/** The workspace root a memory doc belongs to, or null if the path is not one.
 *  Takes an already-normalized path: forward slashes, no trailing slash,
 *  LOWERCASE, which is also what makes this case-insensitive for free. */
export function projectMemoryRootOf(normalized: string): string | null {
  const doc = PROJECT_MEMORY_FILES.find((f) => normalized.endsWith(`/${f.toLowerCase()}`));
  return doc === undefined ? null : normalized.slice(0, -(doc.length + 1));
}

/** Bound ONE preloaded memory doc so it cannot dominate the prompt. Over
 *  budget, cut at the last markdown header at or before it so a table or
 *  sentence is never severed, then append a read-on-demand pointer; falls back
 *  to a line break, then a hard slice. The line fallback only fires on a doc
 *  whose sections are so long the header cut would deliver almost nothing; it can
 *  land between two table rows, which is the price of not delivering 10 bytes.
 *  Head-truncation, not section-aware pruning - fine because the head leads. */
export function boundProjectMemory(content: string, budget: number, name: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= budget) return trimmed;
  const window = trimmed.slice(0, budget);
  let sectionCut = -1;
  for (const m of window.matchAll(/\n#{1,6} /g)) sectionCut = m.index ?? sectionCut;
  // A section boundary is preferred - it never severs a table or a sentence -
  // but it must not silently deliver almost nothing. The cut was "the last
  // header at or before the budget" with no floor, so a doc whose FIRST section
  // runs past the budget preloaded a handful of characters and said so nowhere;
  // the amount also moved every time somebody edited a heading.
  //
  // The floor is a QUARTER of the budget, chosen to catch that collapse and
  // nothing else: an ordinary doc keeps the section cut it already had, and only
  // the pathological shape falls through to a line boundary - which severs no
  // line and is always no worse than the paragraph break it replaces. A higher
  // floor would "fix" documents that were never broken, at real cost: this text
  // sits in the cached system prefix of every single request.
  //
  // The line boundary answers to the SAME floor, which is what stops the
  // collapse at its worst: a doc whose head is one enormous line (a minified
  // blob, a single giant table row) cut at `lastIndexOf("\n")` with only a
  // `> 0` guard, and that is index 6 on a doc opening with `# Title`, so 12 KB
  // of budget preloaded six bytes. Below the floor, take the hard slice.
  const floor = budget * 0.25;
  const cut = sectionCut > floor ? sectionCut : window.lastIndexOf("\n");
  const head = (cut > floor ? trimmed.slice(0, cut) : window).trimEnd();
  return `${head}\n\n[${name} is truncated here; read_file it when a task needs more depth.]`;
}
