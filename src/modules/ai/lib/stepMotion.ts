import type { PixelMotion } from "@/components/ui/pixel-activity";

/**
 * Which gait the running block draws for the step the agent is on.
 *
 * Keyed on the step label's leading VERB, not on the tool name, because the
 * label is the only channel that carries every step: `TOOL_LABELS` in
 * `./agent.ts` produces most of them, but the transport writes its own for a
 * compaction retry and a rate-limit backoff, and those want a gait too. One
 * verb covers a family (every filesystem mutation is `Editing`/`Writing`), so
 * this table stays a third the size of the tool list.
 *
 * `scripts/ai/step-motion-verify.ts` reads `agent.ts` and fails if a label is
 * added whose verb is not here - the mapping is by string, so nothing else
 * would notice.
 */
export const STEP_MOTIONS: Record<string, PixelMotion> = {
  Reading: "read",
  Listing: "search",
  Grepping: "search",
  Globbing: "search",
  Inspecting: "search",
  Editing: "edit",
  Replacing: "edit",
  Moving: "edit",
  Copying: "edit",
  // Driving TEDI's own window over its in-process MCP server. All four are the
  // same act - a discrete input landing somewhere - so they share the caret,
  // which is the gait that already stands for a keystroke.
  Typing: "edit",
  Pressing: "edit",
  Clicking: "edit",
  Dragging: "edit",
  Setting: "edit",
  Writing: "write",
  Creating: "write",
  Saving: "write",
  Deleting: "delete",
  // A background process being killed is a teardown, and `delete` running
  // right to left is the one gait that reads as one.
  Stopping: "delete",
  Fetching: "net",
  // A saved SSH connection being listed or opened: the one other tool that
  // leaves the machine.
  SSH: "net",
  Running: "run",
  // `eval_js`, the escape hatch: arbitrary code executing in the window.
  Evaluating: "run",
  Spawning: "spawn",
  // Something appears, so all of these take the same out-from-the-centre gait
  // as a subagent fan-out: a pane opening or taking focus, a file opening in
  // the editor, an extension being enabled or reloaded, and TEDI's own agent
  // being handed a turn.
  Pane: "spawn",
  Focusing: "spawn",
  Opening: "spawn",
  Extension: "spawn",
  Asking: "spawn",
  // `screenshot`: capturing the window is reading it.
  Capturing: "read",
  // "Updating plan (N items)".
  Updating: "plan",
  Waiting: "wait",
  // Both written by the transport, not by a tool: "Retrying in 4s…" and
  // "Context full - compacting and retrying…". Nothing is happening in either,
  // which is what `wait` draws.
  Retrying: "wait",
  Context: "wait",
  Thinking: "think",
};

/**
 * The other half: tools TEDI cannot label because it did not write them.
 *
 * An extension's AI tool and a third-party MCP server's tool both reach
 * `describeStep` with nothing but a name, so both land on `Calling <name>` and,
 * before this, on the generic sweep - which is most of what an agent turn does
 * once a few MCP servers are connected. But the name is not nothing: these are
 * conventionally `verb_noun` (`list_issues`, `sql_query`, `create_branch`), so
 * the verb is recoverable.
 *
 * STEMS, not whole names, matched LEFT TO RIGHT after the `mcp__<server>__`
 * prefix is cut off. Left to right because the verb leads the name in the
 * convention that dominates (`create_pull_request` would read as `request`, so
 * as `net`, scanned the other way), and cutting the prefix first is what makes
 * that safe: without it a server called `run` decides the gait for every tool
 * it serves. An extension's own namespace (`sql_`, `devenv_`) needs no cut - it
 * is a noun, so the scan walks past it to the verb.
 *
 * ponytail: a heuristic with a known ceiling. It reads a name, not a schema, so
 * an unconventionally named tool falls back to `think` - which is where every
 * one of them sat before. If a tool ever wants to say what it does, the place
 * for it is a `motion` field on the aiTools contribution, not a longer table.
 */
const BY_STEM: Record<string, PixelMotion> = {
  read: "read",
  get: "read",
  show: "read",
  view: "read",
  describe: "read",
  status: "read",
  info: "read",
  list: "search",
  search: "search",
  find: "search",
  query: "search",
  grep: "search",
  lookup: "search",
  inspect: "search",
  screenshot: "read",
  capture: "read",
  set: "edit",
  update: "edit",
  edit: "edit",
  patch: "edit",
  replace: "edit",
  rename: "edit",
  format: "edit",
  // Same four acts as TEDI's own window tools, same caret.
  click: "edit",
  type: "edit",
  press: "edit",
  drag: "edit",
  write: "write",
  create: "write",
  add: "write",
  insert: "write",
  save: "write",
  commit: "write",
  delete: "delete",
  remove: "delete",
  drop: "delete",
  clear: "delete",
  kill: "delete",
  stop: "delete",
  close: "delete",
  disable: "delete",
  uninstall: "delete",
  run: "run",
  exec: "run",
  execute: "run",
  build: "run",
  test: "run",
  eval: "run",
  fetch: "net",
  http: "net",
  request: "net",
  send: "net",
  download: "net",
  upload: "net",
  sync: "net",
  push: "net",
  pull: "net",
  connect: "net",
  open: "spawn",
  launch: "spawn",
  start: "spawn",
  restart: "spawn",
  reload: "spawn",
  spawn: "spawn",
  install: "spawn",
  enable: "spawn",
  wait: "wait",
};

/** The step label's motion. `Calling <tool>` - the fallback `describeStep`
 *  writes for an extension or third-party MCP tool - is read a second time for
 *  a verb in the tool's own name, and only then gives up on `think`. */
export function stepMotion(step: string | null | undefined): PixelMotion {
  if (!step) return "think";
  const [verb, rest] = step.trim().split(/\s+/);
  const known = STEP_MOTIONS[verb ?? ""];
  if (known) return known;
  if (verb !== "Calling" || !rest) return "think";
  // `mcp__github__create_pull_request` -> ["create", "pull", "request"]: the
  // server name goes first, then the camel hump is split so `listIssues` and
  // `list_issues` read the same.
  const tokens = rest
    .replace(/^mcp__.+?__/, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z]+/);
  for (const t of tokens) {
    const hit = BY_STEM[t];
    if (hit) return hit;
  }
  return "think";
}
