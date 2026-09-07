/**
 * Self-check for "every form control in TEDI looks like the same form control".
 * Run: `npx tsx scripts/ui/form-style-consistency-verify.ts`.
 *
 * Forms drift one call site at a time, and each drift looks harmless where it
 * is written. The three that had already happened:
 *
 *   - `<Input type="number">` in the extension settings card drew the BROWSER's
 *     spin buttons: a square grey column that appears on hover, sized by the
 *     engine rather than by the field, against pill inputs everywhere else.
 *   - a native `<select>` sat in the row underneath it, drawing the OS control
 *     and the OS popup inside a card whose other pickers are the outline button
 *     plus a Radix menu.
 *   - the labelled field row existed three times, byte for byte, in three
 *     modules, each free to change without the other two noticing.
 *
 * So the rules below are about SHAPE, not size: a caller may set a height, a
 * width or a text size (density differs between a dialog, a settings row and
 * the command palette, on purpose), but may not restate the radius, the fill or
 * the border - those come from the primitive or they are not consistent.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
  } else {
    console.error(`  FAIL: ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    failed++;
  }
}

/** Every .tsx under src/, as [repo-relative path, source]. */
function sources(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".tsx"))
        out.push([relative(root, p).split(sep).join("/"), readFileSync(p, "utf8")]);
    }
  };
  walk(join(root, "src"));
  return out;
}
const files = sources();

console.log("1. number fields step through the app's own control, not the browser's");
const INPUT = "src/components/ui/input.tsx";
const input = read(INPUT);
check(
  "ui/input.tsx exports NumberInput",
  /export \{ Input, NumberInput \}/.test(input),
  input.match(/export \{[^}]*\}/)?.[0],
);
check(
  "NumberInput hides the native spin buttons on both engines",
  /\[appearance:textfield\]/.test(input) &&
    /webkit-inner-spin-button\]:appearance-none/.test(input) &&
    /webkit-outer-spin-button\]:appearance-none/.test(input),
);
check(
  "NumberInput steps in the step's own precision (0.1 + 0.2 must not be 0.30000000000000004)",
  /toFixed\(decimals\)/.test(input),
);
check(
  "NumberInput clamps to min/max",
  /Math\.min\(\s*max \?\?/.test(input) && /Math\.max\(\s*min \?\?/.test(input),
);
const rawNumber = files.filter(([p, s]) => p !== INPUT && /type="number"/.test(s)).map(([p]) => p);
check(
  'no raw <input type="number"> outside the primitive - those get the native spinner back',
  rawNumber.length === 0,
  rawNumber,
);

console.log("\n2. pickers are the app's menu, never the OS one");
// Comments stripped first: three files EXPLAIN why they are not a native
// `<select>`, and the explanation must not read as the thing it warns about.
const uncommented = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(\/\/|\*).*$/gm, "");
const nativeSelect = files.filter(([, s]) => /<select[\s>]/.test(uncommented(s))).map(([p]) => p);
check("no native <select> in src/", nativeSelect.length === 0, nativeSelect);

console.log("\n3. the labelled field row is defined once");
const CAPTION = "text-[11px] font-medium tracking-tight";
// The two overlay pickers wear this same caption as a dialog HEADING, not as a
// field label - same ink, different job, and they carry their own padding.
const CAPTION_OK = new Set([
  "src/components/ui/field.tsx",
  "src/modules/commandPalette/CommandPalette.tsx",
  "src/modules/editor/LanguagePickerDialog.tsx",
]);
const captionOwners = files.filter(([, s]) => s.includes(CAPTION)).map(([p]) => p);
check(
  "the caption class string is not hand-written next to a form control",
  captionOwners.every((p) => CAPTION_OK.has(p)),
  captionOwners.filter((p) => !CAPTION_OK.has(p)),
);
const fieldDefs = files.filter(([, s]) => /function Field\(\{ label/.test(s)).map(([p]) => p);
check(
  "Field is declared once",
  fieldDefs.length === 1 && fieldDefs[0] === "src/components/ui/field.tsx",
  fieldDefs,
);

console.log("\n4. call sites set density, never shape");
// Deliberate exceptions, each with the reason it earns one.
const SHAPE_EXEMPT = new Set([
  // Composes Input/Textarea INTO a bordered group, so it has to strip the
  // child's own border and radius or the two would nest.
  "src/components/ui/input-group.tsx",
  // The header search is the one field that lives on the toolbar rather than in
  // a form, and it swaps its border colour to report "no matches", which needs a
  // visible border to swap FROM.
  "src/modules/header/SearchInline.tsx",
]);
const SHAPE =
  /\b(rounded-(?!none\b)[a-z0-9[\]]+|bg-(?:background|muted|card|popover)(?:\/\d+)?|border-border(?:\/\d+)?)\b/;
const offenders: string[] = [];
for (const [p, s] of files) {
  if (SHAPE_EXEMPT.has(p) || p === INPUT) continue;
  const lines = s.split("\n");
  lines.forEach((line, i) => {
    // `<Input`/`<Textarea` and not `<InputGroup`.
    if (!/<(Input|Textarea|NumberInput)\b(?!Group)/.test(line)) return;
    const block = lines.slice(i, i + 14).join("\n");
    const cls = block.match(/className=(?:"([^"]*)"|\{cn\((.*?)\)\})/s);
    const text = (cls?.[1] ?? cls?.[2] ?? "").replace(/\s+/g, " ");
    const hit = text.match(SHAPE);
    if (hit) offenders.push(`${p}:${i + 1} ${hit[0]}`);
  });
}
check(
  "no Input/Textarea call site restates radius, fill or border",
  offenders.length === 0,
  offenders,
);

console.log(failed === 0 ? "\nform-style-consistency-verify: OK" : `\nFAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
