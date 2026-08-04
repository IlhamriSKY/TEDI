/**
 * Self-check for this round of connection-dialog work.
 * Run: `npx tsx scripts/connection-ux-verify.ts`.
 *
 * Four things, each of which failed silently before:
 *
 * 1. The outline-button border. The presets were retuned to clear WCAG's 3:1
 *    and `theme-verify.ts` holds them there - but picking a preset SNAPSHOTS
 *    its colours into `customTheme`, so a palette saved before the retune keeps
 *    its old hairline forever and every dialog's Cancel reads as bare text.
 *    Measured on a real install: `#3a3a3a` on a `#363636` popover = 1.06:1.
 *    The floor is now enforced when the payload is read, and this exercises the
 *    REAL function rather than a copy of its arithmetic.
 *
 * 2. The git-branch glyph has its own theme token. It used to borrow
 *    `--muted-foreground` (invisible as a category) in two places and
 *    `--tedi-icon-working` (which means "an agent is busy") in a third.
 *
 * 3. A `hideHostHeader` right panel puts the stack's grip + minimize on its OWN
 *    header row. Two halves that only work together: the panel renders the slot,
 *    the host portals into it. Either one alone is a silent no-op.
 *
 * 4. The SQL Explorer's connection backup is a TRUST BOUNDARY - the file came
 *    off a USB stick and what survives the parser gets dialled - and its dialog
 *    footers must not show two identical primary buttons.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ensureVisibleButtonBorder, contrastRatio } from "../src/modules/settings/buttonBorder";
import { THEME_PRESETS } from "../src/modules/settings/themePresets";
import { undockTarget } from "../src/modules/extensions/sidebarPlacementStore";
import type { ThemeColors } from "../src/modules/settings/customTheme";
// The parser is deliberately reachable under plain node (no DOM at module
// scope), so an import failure here is itself a regression worth failing on.
import {
  BACKUP_KIND,
  parseBackupFile,
} from "../extensions/tedi.sql-explorer/src/connections/backup.js";

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
function throws(name: string, fn: () => unknown): void {
  try {
    fn();
    check(name, false, "did not throw");
  } catch {
    check(name, true);
  }
}

// ---- 1. no saved theme can leave the outline button invisible --------------
console.log("\na stale saved theme cannot keep an invisible button border");

const base = THEME_PRESETS[0].dark;
// The exact palette measured on the install that prompted this: current
// surfaces, pre-retune border.
const stale: ThemeColors = { ...base, popover: "#363636", buttonBorder: "#3a3a3a" };
check(
  "the reported case really was below the floor (so this test can fail)",
  contrastRatio("#3a3a3a", "#363636") < 3,
  Number(contrastRatio("#3a3a3a", "#363636").toFixed(2)),
);
const repaired = ensureVisibleButtonBorder(stale);
for (const surface of ["background", "card", "popover"] as const) {
  const ratio = contrastRatio(repaired.buttonBorder, repaired[surface]);
  check(`repaired border clears 3:1 on ${surface}`, ratio >= 3, {
    border: repaired.buttonBorder,
    surface: repaired[surface],
    ratio: Number(ratio.toFixed(2)),
  });
}
check(
  "a light theme darkens instead of lightening",
  (() => {
    const light = THEME_PRESETS[0].light;
    const bad: ThemeColors = { ...light, buttonBorder: "#fbfbfb" };
    const fixed = ensureVisibleButtonBorder(bad).buttonBorder;
    return fixed < "#fbfbfb" && contrastRatio(fixed, light.popover) >= 3;
  })(),
);
check(
  "a border that already passes is returned untouched (idempotent)",
  ensureVisibleButtonBorder(base) === base &&
    ensureVisibleButtonBorder(repaired).buttonBorder === repaired.buttonBorder,
);
check(
  "a non-hex value is left alone rather than mangled",
  ensureVisibleButtonBorder({ ...base, buttonBorder: "var(--border)" }).buttonBorder ===
    "var(--border)",
);
// The repair only helps if the payload actually routes through it.
const customTheme = read("src/modules/settings/customTheme.ts");
check(
  "normalizeCustomTheme applies it to BOTH variants",
  (customTheme.match(/ensureVisibleButtonBorder\(\{ \.\.\.defaults\./g) ?? []).length === 2,
);

// ---- 2. the branch glyph is its own token ---------------------------------
console.log("\nthe git-branch glyph is themable, and purple everywhere but the status bar");

const BRANCH_SITES = [
  "src/modules/scm/components/BranchMenu.tsx",
  "src/modules/scm/components/PanelHeader.tsx",
  "src/modules/workspaces/WorkspacesPanel.tsx",
  "src/modules/tabs/components/EntryIcon.tsx",
];
for (const f of BRANCH_SITES) {
  const src = read(f);
  // `size=` pins this to the JSX element. A bare `<GitBranch ` also matches a
  // TYPE argument (`useState<GitBranch | null>`), which is what this first read.
  const branchLine = src.split("\n").find((l) => /<GitBranch(Icon)?\s+size=/.test(l)) ?? "";
  check(
    `${f} paints its branch glyph with text-icon-branch`,
    branchLine.includes("text-icon-branch"),
  );
}
check(
  "the status bar is deliberately NOT painted (that row is monochrome)",
  !read("src/modules/statusbar/StatusBar.tsx").includes("text-icon-branch"),
);
check("the token is declared", read("src/styles/globals.css").includes("--tedi-icon-branch:"));
check(
  "and every preset ships one for both variants",
  THEME_PRESETS.every(
    (p) => /^#[0-9a-f]{6}$/i.test(p.dark.iconBranch) && /^#[0-9a-f]{6}$/i.test(p.light.iconBranch),
  ),
);

// ---- 3. a header-less panel wears the stack controls on its own row -------
console.log("\nthe secondary folder tree keeps its controls on ONE row");

const shell = read("src/modules/extensions/components/FolderTreeShell.tsx");
const host = read("src/modules/extensions/components/RightPanelHost.tsx");
check("the panel renders a controls slot", shell.includes("data-tedi-panel-controls"));
check("the host looks for that same slot", host.includes("[data-tedi-panel-controls]"));
check(
  "and portals into it (not a second React root, which loses dnd-kit context)",
  host.includes("createPortal(dragHandle, controlsSlot)"),
);
check(
  "the slim rail survives only as the fallback for a panel with no slot",
  host.includes("dragHandle && !controlsSlot ?"),
);
check(
  "and a header-less panel collapses to the stack default, not the rail's 22px",
  !read("src/app/components/AppRightSlot.tsx").includes('"22px"'),
);

// ---- 4. SQL Explorer: distinct footer buttons, and a paranoid importer ----
console.log("\nSQL Explorer dialogs read clearly, and an import is re-validated");

const dialog = read("extensions/tedi.sql-explorer/src/connections/dialog.js");
check(
  "Cancel is a bordered secondary, not an invisible ghost",
  dialog.includes(`class: "tsql-btn is-outline",\n      text: "Cancel",`),
);
check(
  "Test is secondary too, so only Add/Save reads as THE action",
  dialog.includes(`class: "tsql-btn is-outline",\n      text: "Test",`),
);
check(
  "exactly one primary button in that footer",
  (dialog.match(/tsql-btn is-primary/g) ?? []).length === 1,
);
const sqlLayout = read("extensions/tedi.sql-explorer/src/styles/layout.js");
check(
  "the outline border is derived from --foreground, not read from the theme token",
  // Reading --tedi-button-border was the first attempt and it shipped invisible:
  // that token carries the user's SAVED theme, a theme snapshots its palette
  // when picked, and an older snapshot holds #3a3a3a, which is 1.06:1 on a
  // #363636 dialog. The host repairs it from 0.4.10, but an extension cannot
  // assume the host version.
  /\.tsql-btn\.is-outline \{ border-color: color-mix\(in srgb, var\(--foreground\) 75%/.test(
    sqlLayout,
  ) && !/is-outline[^}]*--tedi-button-border/.test(sqlLayout),
);
check(
  "and 75% of the foreground clears 3:1 on the dialog surface in every preset",
  (() => {
    // A translucent border composites over whatever is behind it, so the
    // effective colour is the blend. `.is-outline` is used ONLY in a dialog
    // footer and `.tsql-dialog` paints --popover, so that is the one surface
    // this has to hold on. (50% was tried first and bottoms out at 2.08:1 on
    // Kanagawa light, whose popover sits close to its foreground.)
    const blend = (fg: string, bg: string, pct: number) =>
      "#" +
      [1, 3, 5]
        .map((i) =>
          Math.round(
            parseInt(fg.slice(i, i + 2), 16) * pct + parseInt(bg.slice(i, i + 2), 16) * (1 - pct),
          )
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
    return THEME_PRESETS.every((p) =>
      (["dark", "light"] as const).every(
        (v) => contrastRatio(blend(p[v].foreground, p[v].popover, 0.75), p[v].popover) >= 3,
      ),
    );
  })(),
);
check(
  "and nothing out-specifies it back onto the near-invisible --border",
  // `.tsql-dialog-confirm .tsql-dialog-actions .tsql-btn:not(...)` is 5 classes
  // to `.tsql-btn.is-outline`'s 2, so it silently won and the confirm modal's
  // Cancel stayed a hairline while every other dialog's was fixed.
  !/\.tsql-btn:not\([^)]*\)[^{]*\{[^}]*border-color/.test(
    read("extensions/tedi.sql-explorer/src/styles/controls.js"),
  ),
);
check("the SSH-tunnel picker is searchable", dialog.includes("searchable: true"));
const sqlControls = read("extensions/tedi.sql-explorer/src/styles/controls.js");
check(
  "and its filter wears the host's search chrome (filled box, not a bordered input)",
  /\.tsql-select-search-box \{[^}]*border: 1px solid transparent/.test(sqlControls) &&
    /\.tsql-select-search-box \{[^}]*color-mix\(in srgb, var\(--input/.test(sqlControls) &&
    /\.tsql-select-search-box:focus-within \{ border-color: var\(--ring/.test(sqlControls),
);
check(
  "with a search glyph, like CommandInput",
  read("extensions/tedi.sql-explorer/src/dom/menus.js").includes(
    'appendIcon(icon, "lucide:Search"',
  ),
);

// ---- 5. one icon-button size per surface ----------------------------------
console.log("\nsidebar icon buttons are one size, left column and right");

// Two families, and only two: a hover-revealed action on a LIST ROW is size-5
// with an 11px glyph; a SECTION HEADER button is size-6 with a 13px glyph. The
// Workspaces entry rows shipped at size-4/10, so the hover box hugged the glyph
// instead of reading as a button, and the right column's panel header shipped at
// size-7 with square corners, the only header in the app that did.
const ROW_ACTION_SURFACES = [
  "src/modules/workspaces/WorkspacesPanel.tsx",
  "src/modules/extensions/components/ExtensionSidebarSection.tsx",
];
for (const f of ROW_ACTION_SURFACES) {
  const src = read(f);
  check(`${f} has no size-4 icon BUTTON left`, !/size-4 rounded"/.test(src));
}
// Every icon BUTTON in a sidebar surface, left column or right: a section
// header is size-6 with a 13px glyph, a hover-revealed row action is size-5
// with 11px. Parsed by brace depth, not `<Button[^>]*>` - a naive match ends at
// the `>` inside an `onClick={() => …}` and reads the wrong tag.
const SIDEBAR_SURFACES = [
  "src/modules/explorer/components/ExplorerHeader.tsx",
  "src/modules/ssh/SshFileExplorer.tsx",
  "src/modules/scm/components/PanelHeader.tsx",
  "src/modules/workspaces/WorkspacesPanel.tsx",
  "src/modules/extensions/components/ExtensionSidebarSection.tsx",
  "src/modules/extensions/components/RightPanelHost.tsx",
  "src/modules/extensions/components/FolderTreeShell.tsx",
];
function iconButtons(src: string): { box: string; glyph: string }[] {
  const out: { box: string; glyph: string }[] = [];
  for (const m of src.matchAll(/<Button/g)) {
    let i = m.index! + m[0].length;
    let depth = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
      i++;
    }
    const tag = src.slice(m.index!, i);
    const box = /size-(\d+)/.exec(tag)?.[1];
    if (!box) continue;
    const glyph = /<[A-Z][A-Za-z0-9]*\s+size=\{(\d+)\}/.exec(src.slice(i, i + 260))?.[1];
    if (glyph) out.push({ box, glyph });
  }
  return out;
}
const offSize: string[] = [];
for (const f of SIDEBAR_SURFACES) {
  for (const b of iconButtons(read(f))) {
    const want = b.box === "6" ? "13" : b.box === "5" ? "11" : null;
    if (want === null) offSize.push(`${f.split("/").pop()}: unexpected size-${b.box} box`);
    else if (b.glyph !== want)
      offSize.push(
        `${f.split("/").pop()}: size-${b.box} box with a ${b.glyph}px glyph, want ${want}`,
      );
  }
}
check(
  "size-6 headers carry a 13px glyph, size-5 row actions an 11px one",
  offSize.length === 0,
  offSize,
);

// The accent hover is a TOP-TOOLBAR treatment. A sidebar icon button takes the
// ghost variant's muted hover, so a row action must not flash --accent while
// the header button beside it goes grey.
const TOOLBAR_ONLY = SIDEBAR_SURFACES.filter((f) => read(f).includes("TOOLBAR_HOVER"));
check(
  "no sidebar surface paints the toolbar's accent hover",
  TOOLBAR_ONLY.length === 0,
  TOOLBAR_ONLY,
);

// A panel-close X is the same red-at-rest button on every surface. It used to be
// grey among grey icons at the end of a busy header row, which is how the
// secondary folder tree's read as "there is no close button" when there was one.
const GREY_CLOSE =
  /hover:bg-destructive\/10 hover:text-destructive text-muted-foreground|text-muted-foreground hover:bg-destructive\/10 hover:text-destructive/;
const greyCloses = [...SIDEBAR_SURFACES, "src/modules/scm/SourceControlPanel.tsx"].filter((f) =>
  GREY_CLOSE.test(read(f)),
);
check(
  "every panel close is red at rest, not grey until hovered",
  greyCloses.length === 0,
  greyCloses,
);

// ---- 6. a section changes columns by drag, not only by the move button ----
console.log("\na sidebar section can be dragged between the two columns");

const stack = read("src/app/components/SectionStack.tsx");
const leftCol = read("src/app/components/AppSidebar.tsx");
const rightCol = read("src/app/components/AppRightSlot.tsx");
check(
  "the column test runs BEFORE the reorder path",
  // The two columns are separate DndContexts, so a drag that ends in the other
  // one still reports an `over` from the column it started in. Checking `over`
  // first would silently reorder instead of handing the section across.
  stack.indexOf("droppedOnOtherColumn(ev, column)") <
    stack.indexOf("if (!over || active.id === over.id)"),
);
check(
  "it measures the POINTER, not the dragged section's rect",
  // A section is a whole panel; its centre sits far from the cursor on a tall
  // one, so a rect test would fire at the wrong moment.
  stack.includes("activator.clientX + ev.delta.x"),
);
check(
  "both columns declare themselves and mark a drop box",
  leftCol.includes('data-section-column="left"') &&
    leftCol.includes('column="left"') &&
    rightCol.includes('data-section-column="right"') &&
    rightCol.includes('column="right"'),
);
check(
  "the primary Files tree is left-only, by drag as well as by button",
  // sidebarPlacementStore force-reverts a stale files:"right", so the drag must
  // agree or it would fight the store on every drop.
  /key === "workspaces" \|\| !!extByKey\.get\(key\)\?\.section\.movableToRight/.test(leftCol),
);
for (const [key, want] of [
  ["xp:__builtin__:__section__:workspaces", "workspaces"],
  ["xp:tedi.sql-explorer:__section__:db-tree", "xsec:tedi.sql-explorer:db-tree"],
] as const) {
  check(
    `undockTarget("${key}") -> ${want}`,
    undockTarget(key)?.placement === want,
    undockTarget(key),
  );
}
for (const key of ["xp:tedi.api-client:api", "workspaces", "ai", "xp:broken", ""]) {
  check(`undockTarget("${key}") stays put`, undockTarget(key) === null);
}

// ---- 7. a row's hover actions never sit on top of its label --------------
console.log("\na sidebar row's label makes room for its hover actions");

const extSection = read("src/modules/extensions/components/ExtensionSidebarSection.tsx");
check("the label reserves padding on hover", extSection.includes("actionHoverPad"));
// The cluster is `absolute` (so an unhovered row is not indented by buttons it
// is not showing), and absolute means zero width: the API Client's folder rows
// had Run / Rename / Delete printed straight over "01 - CRUD REST (…)".
const SPACING_PX = 4; // Tailwind v4's --spacing is .25rem
const padSteps = [...extSection.matchAll(/return "group-hover:pr-(\d+)"/g)].map((m) =>
  Number(m[1]),
);
check("four padding steps are declared (1, 2, 3, 4+ actions)", padSteps.length === 4, padSteps);
for (const n of [1, 2, 3, 4]) {
  // size-5 buttons (20px), gap-0.5 (2px) between them, cluster pinned right-1 (4px).
  const covered = n * 20 + (n - 1) * 2 + 4;
  const reserved = (padSteps[Math.min(n, 4) - 1] ?? 0) * SPACING_PX;
  check(
    `${n} action${n === 1 ? "" : "s"} cover ${covered}px, label reserves ${reserved}px`,
    reserved >= covered,
    {
      covered,
      reserved,
    },
  );
}

check(
  "the right column's panel header matches every other section header",
  /size-6 rounded"/.test(read("src/modules/extensions/components/RightPanelHost.tsx")) &&
    !read("src/modules/extensions/components/RightPanelHost.tsx").includes("size-7"),
);
check(
  "and its popup filters rather than rebuilding (a rebuild loses input focus)",
  read("extensions/tedi.sql-explorer/src/dom/menus.js").includes(
    'item.style.display = hit ? "" : "none"',
  ),
);
check(
  "and a host is findable by address, not just by name",
  dialog.includes("keywords: `${h.user}@${h.host}"),
);

const ok = {
  kind: BACKUP_KIND,
  version: 1,
  exportedAt: 1,
  secrets: { kdf: "pbkdf2-hmac-sha256" },
  connections: [{ id: "a", kind: "mysql", host: "db.internal", name: "prod", port: 3306 }],
};
check("a good file parses", parseBackupFile(ok).connections.length === 1);
throws("a foreign file is refused", () => parseBackupFile({ ...ok, kind: "tedi-ssh-connections" }));
throws("a newer version is refused", () => parseBackupFile({ ...ok, version: 99 }));
throws("a file with no encrypted block is refused", () =>
  parseBackupFile({ ...ok, secrets: null }),
);
throws("a file with nothing usable is refused", () => parseBackupFile({ ...ok, connections: [] }));

const dirty = parseBackupFile({
  ...ok,
  connections: [
    ...ok.connections,
    { id: "b", kind: "not-a-database", host: "h" }, // unknown engine
    { id: "", kind: "mysql", host: "h" }, // no id: would collide on save
    { id: "d", kind: "mysql", host: "" }, // nothing to dial
    { id: "e", kind: "sqlite" }, // no file either
  ],
});
check("every unusable record is dropped, not imported broken", dirty.skipped === 4, dirty);

const coerced = parseBackupFile({
  ...ok,
  connections: [
    {
      id: "x",
      kind: "mysql",
      host: "h",
      port: 999999,
      sslMode: "'; DROP TABLE --",
      query_timeout_ms: -1,
      row_limit: "abc",
      allow_writes: "yes",
    },
  ],
}).connections[0];
check("an out-of-range port falls back to the dialect default", coerced.port === "");
check("an unknown TLS mode cannot reach the sidecar", coerced.sslMode === "none");
check(
  "a junk timeout / row cap falls back",
  coerced.query_timeout_ms === 30000 && coerced.row_limit === 10000,
);
check("a truthy-string write flag does NOT grant writes", coerced.allow_writes === false);

const file = read("extensions/tedi.sql-explorer/src/connections/backup.js");
check(
  "the export strips any password from the plaintext record",
  file.includes("password: _p, ...rest"),
);
check(
  "a replaced connection whose backup carries no password drops the stale one",
  file.includes(
    'else if (conn.kind !== "sqlite" && existing.has(conn.id)) await deleteSecret(conn.id);',
  ),
);
check(
  "sealing is host-side (crypto.subtle is unavailable to the webview)",
  file.includes('ctx.invoke("backup_seal"') && file.includes('ctx.invoke("backup_open"'),
);
const manifest = JSON.parse(read("extensions/tedi.sql-explorer/manifest.json")) as {
  permissions: string[];
};
check(
  "and the manifest grants both commands",
  manifest.permissions.includes("invoke:backup_seal") &&
    manifest.permissions.includes("invoke:backup_open"),
);

console.log(
  failed === 0 ? "\nconnection-ux-verify: OK" : `\nconnection-ux-verify: ${failed} FAILED`,
);
process.exit(failed === 0 ? 0 : 1);
