/**
 * Self-check for the DOM reads that MOVED out of `scripts/mcp/driver.mjs`.
 * Run: `npx tsx scripts/mcp/dom-state-verify.ts`.
 *
 * WHY IT EXISTS. `state`, `text`, `focusedLeaf` and `paneHandle` used to be
 * JavaScript the driver INJECTED as template literals, and `driver-verify`'s
 * first section existed solely to prove those strings PARSED - a check that was
 * only ever necessary because a template literal hides syntax errors from tsc
 * and the linter.
 *
 * Injection is CDP, and CDP is Windows-only, so that arrangement left the
 * always-on `tedi` MCP pack dead on macOS and Linux. The code now lives in
 * `src/modules/automation/domState.ts` as ordinary TypeScript, which tsc
 * type-checks - so "does it parse" is answered for free and the question worth
 * asking becomes "does it still return the same SHAPE". A transcription is
 * exactly the kind of change that compiles and quietly answers wrong.
 *
 * The stub below is the smallest DOM these four functions actually touch. It is
 * not a browser and does not pretend to be: it exists so a renamed attribute, a
 * dropped privacy filter or an inverted condition fails here instead of in
 * someone's window.
 */
// No static imports (the two real ones are dynamic, so the globals below exist
// first), so this marks the file as a module for top-level `await`.
export {};

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) console.log(`  ok: ${name}`);
  else {
    console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
    failed++;
  }
}

// ---------------------------------------------------------------------------
// A DOM just big enough. Nodes are plain objects with the handful of members
// `domState.ts` reads; `matches` is a tiny selector matcher covering the exact
// selectors it uses.
// ---------------------------------------------------------------------------
type StubNode = {
  tag: string;
  attrs: Record<string, string>;
  classes?: string[];
  innerText?: string;
  textContent?: string;
  parent?: StubNode;
  children?: StubNode[];
};

const ALL: StubNode[] = [];

function el(
  tag: string,
  attrs: Record<string, string> = {},
  extra: Partial<StubNode> = {},
  parent?: StubNode,
): StubNode {
  const n: StubNode = { tag, attrs, children: [], parent, ...extra };
  parent?.children?.push(n);
  ALL.push(n);
  return n;
}

/** Supports exactly the selector shapes `domState.ts` uses. */
function matches(n: StubNode, sel: string): boolean {
  return sel
    .split(",")
    .map((s) => s.trim())
    .some((one) => {
      // `[a=b][c=d]:not([e])` and `tag`, plus `.class`.
      const not = [...one.matchAll(/:not\(\[([^\]]+)\]\)/g)].map((m) => m[1]);
      const rest = one.replace(/:not\(\[[^\]]+\]\)/g, "");
      for (const a of not) if (a in n.attrs) return false;
      const attrs = [...rest.matchAll(/\[([^\]=]+)(?:=([^\]]+))?\]/g)];
      const bare = rest.replace(/\[[^\]]*\]/g, "");
      if (bare.startsWith(".")) {
        if (!n.classes?.includes(bare.slice(1))) return false;
      } else if (bare && bare !== n.tag) return false;
      for (const [, name, value] of attrs) {
        if (!(name in n.attrs)) return false;
        if (value !== undefined) {
          if (value.startsWith("^=") || name.endsWith("^")) return false;
          if (n.attrs[name] !== value) return false;
        }
      }
      return true;
    });
}

function closest(n: StubNode | undefined, sel: string): StubNode | null {
  for (let cur = n; cur; cur = cur.parent) if (matches(cur, sel)) return cur;
  return null;
}

function wrap(n: StubNode): Record<string, unknown> {
  return {
    tagName: n.tag.toUpperCase(),
    innerText: n.innerText ?? "",
    textContent: n.textContent ?? n.innerText ?? "",
    classList: { contains: (c: string) => n.classes?.includes(c) ?? false },
    getAttribute: (k: string) => n.attrs[k] ?? null,
    hasAttribute: (k: string) => k in n.attrs,
    closest: (sel: string) => {
      const hit = closest(n, sel);
      return hit ? wrap(hit) : null;
    },
    querySelector: (sel: string) => {
      const hit = (n.children ?? []).find((c) => matches(c, sel));
      return hit ? wrap(hit) : null;
    },
    querySelectorAll: (sel: string) => (n.children ?? []).filter((c) => matches(c, sel)).map(wrap),
    getBoundingClientRect: () => ({ width: 240 }),
  };
}

// --- the scene -------------------------------------------------------------
const root = el("div");
const tabNode = el("div", { "data-tab-id": "1" }, { innerText: "3\nbuild\nbuild" }, root);
const pub = el("div", { "data-pane-leaf": "3" }, {}, root);
el("div", {}, { classes: ["xterm-screen"] }, pub);
const priv = el("div", { "data-pane-leaf": "9", "data-pane-private": "" }, {}, root);
const privEditor = el("div", {}, { classes: ["cm-content"], innerText: "secret" }, priv);
el("div", {}, { classes: ["cm-line"], textContent: "secret" }, privEditor);
const sidebar = el("div", { "data-testid": "sidebar" }, {}, root);
const dismiss = el("button", { "aria-label": "Dismiss" }, { innerText: "Dismiss" }, root);
el("button", { "aria-label": "Stage src/app/App.tsx" }, {}, root);
const focusTarget = el("textarea", {}, {}, pub);
void sidebar;
void tabNode;
void dismiss;

let activeNode: StubNode | undefined = focusTarget;

const doc = {
  get activeElement() {
    return activeNode ? wrap(activeNode) : null;
  },
  querySelectorAll: (sel: string) => ALL.filter((n) => matches(n, sel)).map(wrap),
  querySelector: (sel: string) => {
    const hit = ALL.find((n) => matches(n, sel));
    return hit ? wrap(hit) : null;
  },
};

(globalThis as unknown as { document: unknown }).document = doc;
(globalThis as unknown as { window: unknown }).window = { innerWidth: 1600, innerHeight: 900 };

// Import AFTER the globals exist: the module registers on load.
const { callBridge } = await import("../../src/modules/automation/bridge");
await import("../../src/modules/automation/domState");

console.log("[focusedLeaf] answers the FOCUSED public leaf, and never a private one");
check("focus in a public terminal leaf", (await callBridge("focusedLeaf")) === 3);
activeNode = privEditor;
check(
  "focus in a PRIVATE leaf answers null, not that leaf's id",
  (await callBridge("focusedLeaf")) === null,
);
activeNode = focusTarget;

console.log("\n[text] reads CodeMirror by line, and refuses a private pane by ancestry");
check(
  "a selector landing inside a private pane is refused",
  (await callBridge("text", [".cm-content", 0])) === null,
);
check(
  "a selector matching nothing is null",
  (await callBridge("text", ["[data-nope]", 0])) === null,
);

console.log("\n[state] the shape every MCP `state` call depends on");
const s = (await callBridge("state", [{ tail: 3 }])) as Record<string, unknown>;
for (const key of [
  "window",
  "sidebar",
  "tabs",
  "leaves",
  "focusLeaf",
  "focus",
  "dialog",
  "toasts",
  "paneHandle",
]) {
  check(`carries \`${key}\``, key in s, Object.keys(s));
}
check("buttons is opt-in and absent by default", !("buttons" in s));
const withButtons = (await callBridge("state", [{ buttons: true }])) as { buttons?: string[] };
check("buttons: true lists aria-labels", Array.isArray(withButtons.buttons));
check(
  "a per-file control is folded to <path> rather than listed 60 times",
  (withButtons.buttons ?? []).includes("Stage <path>"),
  withButtons.buttons,
);
check(
  "leaves exclude the private pane",
  JSON.stringify(s.leaves) === JSON.stringify([{ id: 3, kind: "terminal" }]),
  s.leaves,
);
check(
  "a split tab's repeated label is deduped and the bare leaf number dropped",
  JSON.stringify(s.tabs) === JSON.stringify([{ id: 1, label: "build" }]),
  s.tabs,
);
check("toasts counts the dismiss buttons", s.toasts === 1, s.toasts);
check("paneHandle is -1 with no pane splitter", s.paneHandle === -1, s.paneHandle);
// `panes`/`terminals` are registered by a React effect that never runs here, so
// the degrade path is what must answer - not a throw.
check("degrades to an empty pane list plus a reason", Array.isArray(s.panes) && !!s.tediError, {
  panes: s.panes,
  tediError: s.tediError,
});

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
