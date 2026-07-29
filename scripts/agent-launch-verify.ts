/**
 * Invariants behind the tab strip's `+` -> Agent picker.
 *
 * The launcher types a command into a fresh shell and separately tags the pane
 * with a detector kind. If either half is wrong the agent still runs but its
 * status badge stays dark - a silent break that is easy to miss and easy to
 * reintroduce when the roster or `TOOL_PATTERNS` is edited.
 * Run: `npx tsx scripts/agent-launch-verify.ts`.
 *
 * aiCliDetector.ts is xterm-free (it reads the screen through injected
 * callbacks), so this runs under plain node with stub readers.
 */
import {
  agentToolKind,
  BUILTIN_CLI_AGENTS,
  effectiveCliAgents,
  MAX_AGENT_SPAWN,
  type CliAgent,
} from "../src/modules/terminal/lib/cliAgents";
import { createAiCliDetector } from "../src/modules/terminal/lib/aiCliDetector";
import {
  buildPaneTree,
  layoutsFor,
  leafIds,
  type LeafState,
  type PaneLayout,
  type PaneNode,
} from "../src/modules/terminal/lib/panes";
import type { AiCliKind, AiCliStatus } from "../src/modules/terminal/lib/aiCliStatus";

let failed = 0;
function check(ok: boolean, label: string): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

/** Types `cmd` + Enter at a shell prompt; returns the tool the detector activated. */
function activatedByTyping(cmd: string): AiCliKind | null {
  let seen: AiCliKind | null = null;
  const detector = createAiCliDetector({
    onStatus: (s: AiCliStatus) => {
      if (s) seen = s.tool;
    },
    readBuffer: () => "",
    isAltScreen: () => false,
    readCursorLine: () => "",
  });
  detector.pushInput(cmd);
  detector.pushInput("\r");
  detector.dispose();
  return seen;
}

/** Same, but via the explicit tag the launcher applies (no typed command). */
function activatedByLauncher(tool: AiCliKind): AiCliKind | null {
  let seen: AiCliKind | null = null;
  const detector = createAiCliDetector({
    onStatus: (s: AiCliStatus) => {
      if (s) seen = s.tool;
    },
    readBuffer: () => "",
    isAltScreen: () => false,
    readCursorLine: () => "",
  });
  detector.activate(tool);
  detector.dispose();
  return seen;
}

// 1. Each shipped default command is one the detector recognizes on its own, so
//    a hand-typed launch behaves identically to a menu launch.
for (const a of BUILTIN_CLI_AGENTS) {
  const typed = activatedByTyping(a.command);
  check(typed === a.id, `typed "${a.command}" -> ${typed ?? "none"} (want ${a.id})`);
}

// 2. A renamed launcher keeps its identity. This is the whole point of tagging
//    the pane explicitly: `claude-start` matches NO detector pattern (the
//    trailing `(?![\w.-])` rejects it), so without the tag the badge stays dark.
const renamed: CliAgent = { ...BUILTIN_CLI_AGENTS[0], command: "claude-start" };
check(activatedByTyping("claude-start") === null, 'typed "claude-start" matches no pattern');
check(agentToolKind(renamed) === "claude", "renamed built-in still reports its own kind");
check(activatedByLauncher("claude") === "claude", "detector.activate() lights the badge");

// 3. A custom agent is classified from its command; an unrecognizable one gets
//    no badge rather than a wrong one.
check(
  agentToolKind({ id: "cli-x", name: "My Codex", command: "codex --search", builtIn: false }) ===
    "codex",
  "custom agent wrapping a known CLI is classified",
);
check(
  agentToolKind({ id: "cli-y", name: "Mine", command: "my-wrapper", builtIn: false }) === null,
  "unknown custom command reports no kind",
);

// 4. Overrides + pinning: the command is replaced, identity and order are not.
const custom: CliAgent[] = [{ id: "cli-z", name: "Mine", command: "mine", builtIn: false }];
const effective = effectiveCliAgents(custom, {
  claude: { command: "claude-start" },
  gemini: { pinned: true },
});
check(
  effective.find((a) => a.id === "claude")?.command === "claude-start",
  "override replaces the built-in command",
);
check(effective[0]?.id === "gemini", "pinned agent sorts first");
check(
  effective.length === BUILTIN_CLI_AGENTS.length + custom.length,
  "every agent survives the pinned-first partition",
);

// 5. A spawn must never ask for more panes than a tab can hold. `newPaneGroupTab`
//    clamps too, but a cap above the tab limit would silently drop the tail
//    agents while the dialog still offered them.
const MAX_PANES_PER_TAB = 6;
check(MAX_AGENT_SPAWN <= MAX_PANES_PER_TAB, `MAX_AGENT_SPAWN (${MAX_AGENT_SPAWN}) <= 6 panes/tab`);

// 6. Pane layouts. `leafIds` order is what `spawnAgents` zips against the picked
//    agents, so a shape that reorders its leaves would start the wrong CLI in
//    the wrong pane - silently, and only in the grid layouts.
function tree(count: number, layout: PaneLayout) {
  let next = 0;
  const states: LeafState[] = Array.from({ length: count }, () => ({ leafKind: "terminal" }));
  return buildPaneTree(states, layout, () => ++next);
}
/** Compact shape string, e.g. `row(1,col(2,3))`. */
function shape(n: PaneNode): string {
  return n.kind === "leaf" ? String(n.id) : `${n.dir}(${n.children.map(shape).join(",")})`;
}

check(shape(tree(1, "row")) === "1", "a single agent gets a bare leaf, no split");
check(shape(tree(2, "row")) === "row(1,2)", "2 side by side");
check(shape(tree(2, "col")) === "col(1,2)", "2 stacked");
check(shape(tree(3, "grid")) === "row(1,col(2,3))", "3 combined = one beside a stacked pair");
check(shape(tree(4, "grid")) === "col(row(1,2),row(3,4))", "4 combined = 2x2 in reading order");
check(shape(tree(5, "grid")) === "col(row(1,2,3),row(4,5))", "5 combined = 3 over 2");
check(shape(tree(6, "grid")) === "col(row(1,2,3),row(4,5,6))", "6 combined = 3x2");
check(shape(tree(6, "row")) === "row(1,2,3,4,5,6)", "grid is opt-in; row stays flat at 6");
// `grid` below 3 panes has nothing to combine and must not produce a nested tree.
check(shape(tree(2, "grid")) === "row(1,2)", "grid falls back to a row under 3 panes");
// A single-child split would be a tree `normalizePaneTree` only unwraps again.
for (let n = 3; n <= MAX_AGENT_SPAWN; n++) {
  const t = tree(n, "grid");
  const lonely =
    t.kind === "split" && t.children.some((c) => c.kind === "split" && c.children.length < 2);
  check(!lonely, `grid x${n} has no single-child split`);
}
for (let n = 2; n <= MAX_AGENT_SPAWN; n++) {
  for (const layout of layoutsFor(n)) {
    const ids = leafIds(tree(n, layout));
    check(
      ids.length === n && ids.every((id, i) => id === i + 1),
      `${layout} x${n}: leafIds keeps pick order (${ids.join(",")})`,
    );
  }
}
check(layoutsFor(1).length === 0, "a single agent is offered no layout choice");
check(!layoutsFor(2).includes("grid"), "combined is not offered for 2 panes");

if (failed > 0) {
  console.error(`\n${failed} failing`);
  process.exit(1);
}
console.log("\nall agent-launch invariants hold");
