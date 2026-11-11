/**
 * The ONE rule that decides whether a close asks first (`closeBlocker`).
 * Run: `npx tsx scripts/workspace/close-guard-verify.ts`.
 *
 * It used to be two rules. A whole-tab close read `tab.dirty`, a mirror of the
 * tab's ACTIVE leaf only, so a dirty editor in the other half of a split closed
 * silently. A single-pane close (the tab-strip X on every pane chip, the pane
 * header X, Ctrl+W in a split) checked only for a running process, so it never
 * asked about unsaved text at all.
 *
 * Also pinned: text the program types into a terminal (the AI, the agent
 * launcher, a drop) goes through the same command tracker as the keyboard.
 * pwsh never sends OSC 133;C, so without that an AI-started `npm run dev` never
 * read as running and the close-confirm above never fired for it.
 */
import { readFileSync } from "node:fs";
import { closeBlocker } from "../../src/modules/tabs/lib/tabHelpers";
import type { PaneLeaf } from "../../src/modules/terminal/lib/panes";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (got === want) console.log(`  ok: ${label}`);
  else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

const editor = (id: number, dirty: boolean) =>
  ({
    kind: "leaf",
    id,
    leafKind: "editor",
    path: `/p/${id}.ts`,
    dirty,
    preview: false,
  }) as PaneLeaf;
const terminal = (id: number) =>
  ({ kind: "leaf", id, leafKind: "terminal" }) as unknown as PaneLeaf;
const running = (ids: number[]) => (id: number) => ids.includes(id);

console.log("[closeBlocker] every leaf is read, not the active one's mirror");
check("a clean editor closes", closeBlocker([editor(1, false)], running([])), null);
check("a dirty editor asks", closeBlocker([editor(1, true)], running([])), "unsaved");
check(
  "a dirty editor in the OTHER half of a split asks",
  closeBlocker([terminal(2), editor(1, true)], running([])),
  "unsaved",
);
check("an idle terminal closes", closeBlocker([terminal(2)], running([])), null);
check("a running terminal asks", closeBlocker([terminal(2)], running([2])), "running");
check(
  "unsaved text outranks a running process",
  closeBlocker([terminal(2), editor(1, true)], running([2])),
  "unsaved",
);
check(
  "an editor id never reads as a running process",
  closeBlocker([editor(3, false)], running([3])),
  null,
);

console.log("\n[wiring] both close paths and every program write share it");
const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const actions = src("src/app/hooks/useTabActions.ts");
check("tab close uses closeBlocker", /closeBlocker\(leaves\(t\.paneTree\)/.test(actions), true);
check("pane close uses closeBlocker", /closeBlocker\(\[leaf\]/.test(actions), true);
check("the tab's active-leaf mirror is no longer the rule", /t\.dirty\b/.test(actions), false);
const lifecycle = src("src/modules/terminal/lib/session-lifecycle.ts");
check(
  "writePtyInput feeds the command tracker",
  /export function writePtyInput[\s\S]{0,200}trackCommandInput\(s, leafId, data\)/.test(lifecycle),
  true,
);
check(
  "writeToLeaf goes through it",
  /writeToLeaf[\s\S]{0,120}writePtyInput\(leafId, data\)/.test(lifecycle),
  true,
);
const hook = src("src/modules/terminal/lib/useTerminalSession.ts");
check("the pane handle writes through it", /pty\?\.write\(/.test(hook), false);

if (failed > 0) throw new Error(`close-guard-verify: ${failed} FAILED`);
console.log("\nclose-guard-verify: OK");
