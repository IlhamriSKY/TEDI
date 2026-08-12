/**
 * Self-check for `scripts/director/`, covering the two things nothing else can
 * see. Run: `npx tsx scripts/director-verify.ts`.
 *
 * 1. **The JS the director injects lives inside template literals**, so a typo
 *    in it is invisible to `node --check`, to `tsc`, and to the linter. It only
 *    surfaces at runtime as a CDP exception mid-take, which on a recorded run
 *    means the footage is already spoiled. Parsing each expression here is the
 *    only check that happens before the app is even running.
 * 2. **Chord parsing decides which physical key the app is told about.** The
 *    sweep's `Ctrl+/` check cannot guard it, because CodeMirror reads
 *    `event.key` and never looks at the virtual key, so a wrong vk passes there
 *    while breaking anything that does look.
 *
 * The rest of the director needs a live TEDI and lives in
 * `scripts/director/sweep.mjs`.
 */
import { Director, parseChord } from "./director/director.mjs";

let failed = 0;
const fail = (msg: string): void => {
  console.error(`  FAIL: ${msg}`);
  failed++;
};

// ---------------------------------------------------------------------------
// 1. Every injected expression must parse.
// ---------------------------------------------------------------------------

const expressions: string[] = [];

/** Stands in for the CDP socket: records what would be evaluated, answers with
 *  a shape each caller can keep working from. */
const fakeCdp = {
  send(method: string, params: { expression?: string }) {
    if (method === "Runtime.evaluate" && params.expression) {
      expressions.push(params.expression);
      // `state()` reads properties off its result, and `terminals()` treats null
      // as "the automation surface is missing" and throws, which is a path worth
      // exercising too. An object satisfies both.
      return Promise.resolve({ result: { value: {} } });
    }
    return Promise.resolve({});
  },
};

const d = new Director(fakeCdp, { url: "index.html" });

console.log("[injected JS] every expression the director evaluates must parse");
// Each of these embeds JS in a template literal. `state()` fans out to
// `paneHandleIndex()` and `terminals()` as well.
await d.state();
await d.box("[data-testid=sidebar]");
await d.text(".cm-content", { nth: 2 });
await d.focusedLeaf();
await d.commands();
await d.cmd("pane.splitRight").catch(() => {});
await d.metrics();

if (expressions.length < 7) fail(`only ${expressions.length} expressions captured, expected 7+`);

for (const expr of expressions) {
  const label = expr.replace(/\s+/g, " ").slice(0, 58);
  try {
    // Parses without executing: `document` and `window` are never touched.
    new Function(expr);
    console.log(`  ok: ${label}…`);
  } catch (err) {
    fail(`does not parse: ${label}… (${(err as Error).message})`);
  }
}

// Selector strings are interpolated with JSON.stringify, so a selector holding a
// quote must not be able to end the string early and inject.
console.log("\n[injection] a quoted selector stays one string literal");
const before = expressions.length;
await d.box(`button[aria-label="Close pane"]`);
const withQuotes = expressions[before];
try {
  new Function(withQuotes);
  console.log("  ok: selector containing double quotes still parses");
} catch (err) {
  fail(`quoted selector broke the expression: ${(err as Error).message}`);
}

// ---------------------------------------------------------------------------
// 2. Chords carry the virtual key a real keyboard would send.
// ---------------------------------------------------------------------------

console.log("\n[chords] US-layout virtual keys, not the character's own code point");
const chords: [string, number, string | undefined][] = [
  // The regression this exists for: deriving the vk from the character gave 47.
  ["Ctrl+/", 191, "Slash"],
  ["Ctrl+Shift+P", 80, "KeyP"],
  ["Ctrl+S", 83, "KeyS"],
  ["Alt+1", 49, "Digit1"],
  ["Shift+;", 186, "Semicolon"],
  ["Ctrl+-", 189, "Minus"],
  ["Enter", 13, "Enter"],
  ["Escape", 27, "Escape"],
];
for (const [chord, vk, code] of chords) {
  const k = parseChord(chord);
  if (k.vk !== vk || k.code !== code) {
    fail(`${chord} -> vk ${k.vk} / ${k.code}, want ${vk} / ${code}`);
  } else {
    console.log(`  ok: ${chord.padEnd(14)} vk ${String(vk).padStart(3)} ${code}`);
  }
}

console.log("\n[chords] a char event only rides along without Ctrl or Meta held");
// Sending `text` alongside Ctrl makes the page see a literal character on top of
// the shortcut, which is how a "Ctrl+S" once typed an "s" into the document.
if (parseChord("Ctrl+S").text !== undefined) fail("Ctrl+S carries text");
else console.log("  ok: Ctrl+S sends no text");
if (parseChord("Shift+A").text !== "A") fail(`Shift+A text is ${parseChord("Shift+A").text}`);
else console.log('  ok: Shift+A sends text "A"');

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
