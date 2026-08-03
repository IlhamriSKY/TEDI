/**
 * Self-check for the status bar's three groups.
 * Run: `npx tsx scripts/statusbar-groups-verify.ts`.
 *
 * The bar reads left to right as: the update prompt, things you READ, things
 * you CLICK (actions, then panel toggles). Every way that ordering breaks is
 * silent - the row still renders, it just stops meaning anything:
 *   - a group rendered outside its divider, so the reading order is a lie,
 *   - the compact mode losing its gate, so folding the bar hides nothing (or
 *     hides the AI button, which is the one thing it must keep),
 *   - a `kind: "action"` panel drifting back into the panel-toggle group, where
 *     a click would slide a panel out instead of doing the thing.
 *
 * Source text, not imports: StatusBar is JSX behind three path aliases and a
 * zustand store, none of which is worth booting for a question about order.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

const bar = read("src/modules/statusbar/StatusBar.tsx");
const items = read("src/modules/extensions/components/ExtensionStatusItems.tsx");
const toggles = read("src/modules/extensions/components/RightPanelToggleButtons.tsx");
const prefs = read("src/modules/settings/store.ts");

// ---- group order ---------------------------------------------------------
// Everything below is positional, so read the offsets once and compare.
const at = (needle: string) => bar.indexOf(needle);
const updater = at("<UpdaterPill />");
const statusGroup = at('<ExtensionStatusItems kind="status"');
const actionGroup = at('<ExtensionStatusItems kind="action"');
const panelGroup = at("<RightPanelCompactToggles />");
const aiButton = at("<AiOpenButton");

check("the update pill is in the bar", updater > 0);
check("the update pill leads the cluster", updater < statusGroup, { updater, statusGroup });
check("status items come before actions", statusGroup < actionGroup, { statusGroup, actionGroup });
check("actions come before panel toggles", actionGroup < panelGroup, { actionGroup, panelGroup });
check("the AI button closes the row", panelGroup < aiButton, { panelGroup, aiButton });
check("three dividers separate the groups", (bar.match(/<GroupDivider \/>/g) ?? []).length === 3, {
  found: (bar.match(/<GroupDivider \/>/g) ?? []).length,
});

// ---- compact mode --------------------------------------------------------
// What compact KEEPS is the whole point: the update prompt, the AI meters and
// the AI panel button. Everything else has to sit behind a `compact ?` gate.
check("compact reads the persisted preference", bar.includes("s.statusBarCompact"));
check("compact is persisted", prefs.includes('const KEY_STATUS_BAR_COMPACT = "statusBarCompact"'));
check("compact has a setter", prefs.includes("export async function setStatusBarCompact"));
check("compact keeps the meters", bar.includes("metersOnly={compact}"));
for (const kept of ["<UpdaterPill />", "<AgentStatusPill", "<AiOpenButton", "<CompactToggle"]) {
  // A kept item must not appear inside a `{compact ? null : (` block. Cheap
  // proxy: it appears exactly once, and not after the LAST gate opener.
  const idx = bar.indexOf(kept);
  const gates = [...bar.matchAll(/\{compact \? null : \(/g)].map((m) => m.index ?? 0);
  const inGate = gates.some((g) => idx > g && idx < bar.indexOf(")}", g));
  check(`compact keeps ${kept}`, idx > 0 && !inGate, { idx, gates });
}
for (const hidden of [
  "<ZoomControl />",
  "<RightPanelCompactToggles />",
  "<RightPanelDefaultToggles />",
  "<ScmRightOpenButton />",
  "<SchedulerStatusPill />",
]) {
  const idx = bar.indexOf(hidden);
  const gates = [...bar.matchAll(/\{compact \? null : \(/g)].map((m) => m.index ?? 0);
  const inGate = gates.some((g) => idx > g && idx < bar.indexOf(")}", g));
  check(`compact hides ${hidden}`, idx > 0 && inGate, { idx });
}

// ---- kinds ---------------------------------------------------------------
check("status items can be filtered by kind", items.includes("statusItemKind"));
check(
  "an item that displays data is a status even when clickable",
  /item\.progress !== undefined \|\| item\.label \|\| item\.detail\) return "status"/.test(items),
);
check("an action-kind panel runs its command", toggles.includes("commandsRegistry.getRuntime"));
check(
  "the action group excludes panel-kind toggles",
  toggles.includes('match={(p) => p.kind === "action"}'),
);
for (const row of ["RightPanelCompactToggles", "RightPanelDefaultToggles"]) {
  const body = toggles.slice(toggles.indexOf(`export function ${row}`));
  check(`${row} skips action-kind panels`, body.slice(0, 200).includes('p.kind !== "action"'));
}

// The Screenshot extension is the reason `kind: "action"` exists: it used to
// intercept its own button with a document-wide capture listener.
try {
  const manifest = JSON.parse(read("extensions/tedi.screenshot/manifest.json")) as {
    contributes?: { panels?: { kind?: string }[] };
  };
  const panel = manifest.contributes?.panels?.[0];
  check("Screenshot declares kind: action", panel?.kind === "action", panel);
  const src = read("extensions/tedi.screenshot/src/index.js");
  check("Screenshot no longer hijacks its own click", !src.includes("addEventListener(\"click\""));
} catch {
  console.log("  skip: the Screenshot extension is not checked out");
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
