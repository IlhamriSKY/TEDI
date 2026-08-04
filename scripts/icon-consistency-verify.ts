/**
 * Self-check for the shared action vocabulary, and for closing a workspace or
 * one of its tabs from the Workspaces panel.
 * Run: `npx tsx scripts/icon-consistency-verify.ts`.
 *
 * Three glyphs mean exactly one thing each, everywhere in TEDI - app chrome,
 * Settings, and every bundled extension:
 *
 *   rename / edit a name  ->  Lucide `Pencil`   (`lucide:Pencil` from an extension)
 *   settings              ->  Lucide `Settings` (the gear, never `Settings2`)
 *   delete / remove       ->  Lucide `Trash2`, painted with DESTRUCTIVE_ACTION
 *
 * None of that is enforceable by the type system: every one of these is a
 * component name in JSX or a string in an extension's action list, so a second
 * pencil (`SquarePen`, `FilePen`, `PencilEdit02Icon`) or a sliders-style
 * `Settings2` slips in silently and only ever shows up as "why is the edit icon
 * different over here". Same for colour - a delete button that re-types the old
 * `text-muted-foreground hover:bg-destructive/10 hover:text-destructive` is
 * valid Tailwind that simply isn't red until you are already pointing at it.
 *
 * The close half checks the Workspaces panel can close a workspace AND the tabs
 * listed under it, under the tab strip's own rule: never the last one, and only
 * behind a confirmation. The two counts must come from the same entry list, or
 * the panel starts offering a close the strip would refuse.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

function walk(dir: string, match: RegExp, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === ".git" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, match, out);
    // The shipped extension.js is generated from src/; checking it would just
    // double-report whatever src/ already said.
    else if (match.test(name) && name !== "extension.js") out.push(full);
  }
  return out;
}

const appFiles = walk(join(root, "src"), /\.tsx?$/);
const extFiles = walk(join(root, "extensions"), /\.(js|mjs)$/);
const rel = (p: string) => relative(root, p).replace(/\\/g, "/");

// ---- 1. one pencil --------------------------------------------------------
console.log("\none pencil means rename");

// `SquarePen` and the other pen glyphs are still legal where they are NOT a
// rename affordance: a pane-kind glyph, an AI tool-card icon, an agent role.
// Anywhere else, a second pen next to a Pencil is the drift this check exists
// to catch, so new entries here need a reason.
const PEN_EXEMPT = new Set([
  // the editor pane's own glyph in the tab strip / Workspaces list
  "src/components/LeafIcon.tsx",
  // icon MAPS for the AI's file-editing tools (edit / multi_edit), not buttons
  "src/components/ai-elements/tool.tsx",
  "src/modules/ai/components/AiToolApproval.tsx",
  // the "reviewer" agent's avatar glyph
  "src/modules/ai/components/AgentSwitcher.tsx",
  // "modified file" marker in a plan's diff list
  "src/modules/ai/components/PlanDiffReview.tsx",
  // the legacy hugeicon -> Lucide alias table; it NAMES glyphs by definition,
  // and the generic edit aliases in it are checked on their own below
  "src/lib/iconRegistry.ts",
]);
const OTHER_PENS = /\b(SquarePen|FilePen|FolderPen|PenLine|PenSquare|Edit2|Edit3)\b/;
const strayPens = appFiles.filter((f) => OTHER_PENS.test(read(rel(f))) && !PEN_EXEMPT.has(rel(f)));
check("no second pen glyph outside the exempt list", strayPens.length === 0, strayPens.map(rel));

// Every rename/edit affordance listed here renders the one Pencil.
const RENAME_SITES = [
  "src/modules/workspaces/WorkspacesPanel.tsx",
  "src/settings/components/ProviderKeyCard.tsx",
  "src/settings/sections/AgentsSection.tsx",
  "src/settings/sections/components/McpServersCard.tsx",
  "src/settings/sections/components/OpenAICompatibleBlock.tsx",
  "src/settings/sections/components/SubagentsCard.tsx",
  "src/settings/sections/components/SystemPromptsCard.tsx",
];
for (const f of RENAME_SITES) {
  check(`${f} renames with <Pencil`, read(f).includes("<Pencil "));
}

// Extensions name their icons as strings, so the same drift is a string typo.
// `Edit02Icon` / `PencilEdit02Icon` alias to SquarePen in the host registry.
const extPenNames = /["'](?:lucide:)?(?:SquarePen|Edit02Icon|PencilEdit02Icon|FileEditIcon)["']/;
const strayExtPens = extFiles.filter((f) => extPenNames.test(read(rel(f))));
check("no extension asks for a second pen", strayExtPens.length === 0, strayExtPens.map(rel));

// An extension installed before the Lucide migration asks by the old name, so
// the alias table has to land the generic edit names on the same pencil.
const registry = read("src/lib/iconRegistry.ts");
for (const legacy of ["Edit02Icon", "PencilEdit01Icon", "PencilEdit02Icon"]) {
  check(`legacy ${legacy} still resolves to Pencil`, registry.includes(`${legacy}: "Pencil"`));
}

// The database connection row is the reference the rest was aligned to.
check(
  "SQL Explorer edits a connection with lucide:Pencil (row + context menu)",
  read("extensions/tedi.sql-explorer/src/tree/items.js").includes(
    `{ id: "edit", icon: "lucide:Pencil", tooltip: "Edit connection" }`,
  ) &&
    /label: "Edit connection",\s*\n\s*icon: "lucide:Pencil"/.test(
      read("extensions/tedi.sql-explorer/src/tree/menu.js"),
    ),
);

// ---- 2. one gear ----------------------------------------------------------
console.log("\none gear means settings");

const strayGears = [...appFiles, ...extFiles].filter((f) => /\bSettings2\b/.test(read(rel(f))));
check("nobody uses the Settings2 sliders glyph", strayGears.length === 0, strayGears.map(rel));

const apiSidebar = read("extensions/tedi.api-client/src/sidebar.js");
for (const label of ["API Client settings", "Collection settings"]) {
  check(
    `API Client "${label}" uses the gear`,
    new RegExp(`icon: "lucide:Settings", tooltip: "${label}`).test(apiSidebar),
  );
}

// ---- 3. delete is red at rest ---------------------------------------------
console.log("\ndelete is red before you point at it");

const toolbar = read("src/lib/toolbarButton.ts");
check("DESTRUCTIVE_ACTION exists", /export const DESTRUCTIVE_ACTION\s*=/.test(toolbar));
check("it is red AT REST, not only on hover", /text-destructive\/75/.test(toolbar));
check(
  "and it beats the ghost variant's dark: hover (see TOOLBAR_HOVER's note)",
  /dark:hover:bg-destructive\/10/.test(toolbar) && /dark:hover:text-destructive/.test(toolbar),
);

// A file that renders a Trash2 BUTTON must paint it from the constant. The two
// icon maps below hand Trash2 to a tool card, which is a label, not an action.
const TRASH_ICON_ONLY = new Set([
  "src/components/ai-elements/tool.tsx",
  "src/modules/ai/components/AiToolApproval.tsx",
]);
const trashFiles = appFiles.filter((f) => read(rel(f)).includes("<Trash2 "));
check("Trash2 is actually used somewhere (guard against a dead check)", trashFiles.length > 5);
const unpainted = trashFiles.filter(
  (f) => !TRASH_ICON_ONLY.has(rel(f)) && !read(rel(f)).includes("DESTRUCTIVE_ACTION"),
);
check(
  "every delete button paints from DESTRUCTIVE_ACTION",
  unpainted.length === 0,
  unpainted.map(rel),
);

// The literal it replaced: muted at rest, red only under the pointer.
const OLD_MUTED_DELETE = "text-muted-foreground hover:bg-destructive/10 hover:text-destructive";
const rehandRolled = trashFiles.filter(
  (f) => !TRASH_ICON_ONLY.has(rel(f)) && read(rel(f)).includes(OLD_MUTED_DELETE),
);
check(
  "and nobody re-typed the old muted-until-hover string next to one",
  rehandRolled.length === 0,
  rehandRolled.map(rel),
);

// Extensions can't import the constant, so they carry the same rule in CSS.
for (const [file, selector] of [
  ["extensions/tedi.sql-explorer/src/styles/layout.js", ".tsql-row-action.is-danger {"],
  ["extensions/tedi.sql-explorer/src/styles/controls.js", ".tsql-context-item.is-danger,"],
  ["extensions/tedi.api-client/src/styles/controls.js", ".tapi-menu-item.is-danger,"],
] as const) {
  check(`${file.split("/")[1]} paints ${selector.trim()} at rest`, read(file).includes(selector));
}

// ---- 4. closing a workspace, and the tabs inside it -----------------------
console.log("\nthe Workspaces panel can close a workspace and its tabs");

const panel = read("src/modules/workspaces/WorkspacesPanel.tsx");
const strip = read("src/modules/tabs/components/SortableTabGroup.tsx");
const tabsHook = read("src/modules/tabs/lib/useTabs.ts");

check(
  "a workspace close is offered only when another remains",
  panel.includes("canClose={workspaces.length > 1}"),
);
check(
  "a listed tab close is offered only when another entry remains",
  /const canCloseEntry =\s*isActive && !!onCloseEntry && rows\.length > 1;/.test(panel),
);
check(
  "which is the tab strip's own rule, so the two cannot disagree",
  strip.includes("const canClose = totalEntries > 1;"),
);
check(
  "and the store refuses the last tab even if the UI ever asks",
  tabsHook.includes("if (curr.length <= 1) return curr;"),
);

check("closing a workspace is confirmed", panel.includes("Close workspace &quot;"));
check(
  "closing a listed tab is confirmed",
  panel.includes("Close &quot;{confirmingEntry?.label}&quot;?"),
);
check(
  "both confirmations are the app's AlertDialog, not window.confirm",
  (panel.match(/<AlertDialog\b/g) ?? []).length >= 2 && !panel.includes("window.confirm"),
);

check(
  "the workspace close X is red",
  /aria-label="Close workspace"[\s\S]{0,220}DESTRUCTIVE_ACTION/.test(panel),
);
check(
  "the listed-tab close X is red",
  /aria-label=\{`Close \$\{e\.label\}`\}[\s\S]{0,220}DESTRUCTIVE_ACTION/.test(panel),
);

// The close must reuse the strip's handler, or a busy terminal / unsaved editor
// gets closed from here with no prompt while the strip still asks.
const app = read("src/app/App.tsx");
check(
  "the panel's close routes through the tab strip's handler",
  (app.match(/onCloseEntry[=:]\s*\{?handleHeaderCloseEntry/g) ?? []).length >= 3,
);
check(
  "which still confirms a busy terminal / unsaved editor",
  read("src/app/hooks/useTabActions.ts").includes("setPendingClose("),
);

console.log(
  failed === 0 ? "\nicon-consistency-verify: OK" : `\nicon-consistency-verify: ${failed} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
