/**
 * Self-check for "an extension icon that is an IMAGE actually renders".
 * Run: `npx tsx scripts/ui/ext-icon-data-url-verify.ts`.
 *
 * `resolveExtIcon` accepts `lucide:<Name>` and `hugeicon:<Name>` and returns
 * null for everything else - `data:`, `ext-asset:`, `fileicon:` - with the
 * stated contract that those are "not an icon-name ref ... so the caller's
 * asset loader handles it".
 *
 * Two callers had no asset loader. `LeafIcon` (pane header, canvas card, drag
 * overlay) and `EntryIcon` (tab strip) both did `resolveExtIcon(ref) ?? Database`,
 * so a `data:` URL fell straight through to the fallback glyph. The whole
 * runtime-icon feature - `setExtensionTabState({ icon })`, the field threaded
 * through `tabsBridge`, `useAuxTabs` and `panes.ts`, serialised onto the leaf so
 * it survives a restart - was written end to end EXCEPT the last hop, and the
 * symptom was silent: every browser pane wore a database instead of the site's
 * favicon, while the CHANGELOG, TEDI.md and `tedi.d.ts` all said otherwise.
 *
 * This is exactly the shape that comes back on a refactor, because nothing about
 * `resolveExtIcon(ref) ?? Fallback` LOOKS wrong. So: every call site that
 * resolves an extension icon by name must also handle the image case.
 *
 * Deliberately source-text, not behavioural: the alternative is mounting React
 * to assert on a glyph, and what actually regresses here is someone deleting a
 * branch they read as redundant.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    console.error(`  FAIL  ${name}${detail === undefined ? "" : ` -> ${JSON.stringify(detail)}`}`);
    failed++;
  }
}

console.log("\nan extension icon that is an image renders as one\n");

const REGISTRY = "src/lib/iconRegistry.ts";
const registry = read(REGISTRY);

// The premise. If this ever stops being true the call sites below are free to
// drop their branches, so assert it rather than assume it.
check(
  `${REGISTRY}: resolveExtIcon still accepts only lucide:/hugeicon:`,
  /startsWith\("lucide:"\)/.test(registry) &&
    /startsWith\("hugeicon:"\)/.test(registry) &&
    /else return null;/.test(registry),
);

/** Every place that turns an extension icon ref into something on screen. */
const CALL_SITES = [
  "src/components/LeafIcon.tsx",
  "src/modules/tabs/components/EntryIcon.tsx",
];

for (const path of CALL_SITES) {
  const src = read(path);
  const resolves = src.includes("resolveExtIcon(");
  check(`${path}: still resolves extension icons by name`, resolves);
  if (!resolves) continue;

  // The load-bearing assertion: a name-resolving call site must also have a
  // branch for the image form, or the fallback silently eats every favicon.
  check(
    `${path}: has a data: URL branch before falling back`,
    /startsWith\("data:"\)/.test(src) && /<img/.test(src),
  );

  // The branch has to come FIRST. `resolveExtIcon` returns null for a data: URL,
  // so a branch placed after `?? Fallback` can never be reached.
  const dataAt = src.indexOf('startsWith("data:")');
  const resolveAt = src.indexOf("resolveExtIcon(");
  check(`${path}: the data: branch precedes the name lookup`, dataAt !== -1 && dataAt < resolveAt, {
    dataAt,
    resolveAt,
  });
}

// The producer side: the field has to survive the trip from an extension to the
// leaf, or there is nothing for the call sites above to render.
const BRIDGE = "src/modules/extensions/tabsBridge.ts";
const PANES = "src/modules/terminal/lib/panes.ts";
check(`${BRIDGE}: setExtensionTabState still carries an icon`, /icon\?: string/.test(read(BRIDGE)));
check(
  `${PANES}: updateExtensionPanelLeaf still patches icon`,
  /patch\.icon !== undefined/.test(read(PANES)),
);

console.log(
  failed === 0 ? "\next-icon-data-url-verify: OK\n" : `\next-icon-data-url-verify: ${failed} FAILED\n`,
);
process.exit(failed === 0 ? 0 : 1);
