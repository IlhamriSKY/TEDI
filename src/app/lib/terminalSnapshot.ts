import { findLeaf, leaves, type PaneLeaf } from "@/modules/terminal";
import type { TerminalInfo, TerminalTarget } from "@/modules/scheduler/types";
import type { useTabs } from "@/modules/tabs";
import { pathSegments } from "@/lib/path";

/** Narrow context for live-terminal helpers. Subset of `liveContextRef.current`. */
export type LiveTerminalCtx = {
  tabs: ReturnType<typeof useTabs>["tabs"];
  activeId: number;
};

/**
 * Per-leaf title used in the AI-facing terminal snapshot. Derived from
 * the leaf itself (not the pane-tab mirror) so a private active leaf
 * cannot leak its cwd basename into a public sibling's `title` row -
 * `t.title` reflects whichever leaf is currently focused, including a
 * private one, which would otherwise surface inside the `<env>` block.
 */
function leafTitleForSnapshot(l: PaneLeaf): string {
  if (l.leafKind !== "terminal") return "";
  if (l.sshConnectionId) return "ssh";
  if (l.cwd) {
    const b = pathSegments(l.cwd).at(-1);
    if (b) return b;
  }
  return "shell";
}

/**
 * Snapshots all terminal leaves in tab order. `ordinal` is the leaf's
 * FIFO `terminalOrdinal` (the number on the TabBar chip), so "terminal 3"
 * maps to the same leaf across closes, drags, and restarts. Falls back to
 * positional numbering if the saved field is missing.
 *
 * Private leaves are filtered out entirely so the AI never learns of their
 * existence (no ordinal, no leafId, no cwd, no title). Privacy is per-leaf
 * - a split group can mix private and public terminals; only marked
 * leaves disappear. This is the single chokepoint backing `listTerminals`,
 * the per-turn `<env>` block, and every `target`-based AI tool.
 */
export function snapshotTerminals(ctx: LiveTerminalCtx): TerminalInfo[] {
  const out: TerminalInfo[] = [];
  let fallback = 0;
  for (const t of ctx.tabs) {
    if (t.kind !== "pane") continue;
    for (const l of leaves(t.paneTree)) {
      if (l.leafKind !== "terminal") continue;
      if (l.private) continue;
      fallback += 1;
      out.push({
        tabId: t.id,
        leafId: l.id,
        ordinal: l.terminalOrdinal ?? fallback,
        // Per-leaf derivation. See leafTitleForSnapshot comment.
        title: leafTitleForSnapshot(l),
        cwd: l.cwd ?? null,
        isActive: t.id === ctx.activeId && t.activeLeafId === l.id,
      });
    }
  }
  return out;
}

/**
 * True when the leaf carries the per-leaf private flag. The setLive bridge
 * uses this to refuse injects/runs/reads even when a tool resolves to a
 * leafId directly.
 */
export function isLeafPrivate(ctx: LiveTerminalCtx, leafId: number): boolean {
  for (const t of ctx.tabs) {
    if (t.kind !== "pane") continue;
    const leaf = findLeaf(t.paneTree, leafId);
    if (leaf?.private) return true;
  }
  return false;
}

/** Resolves a TerminalTarget to a leaf id. Order: leafId, tabId, ordinal, title substring. Empty target picks the active terminal. */
export function resolveTerminalLeaf(target: TerminalTarget, ctx: LiveTerminalCtx): number | null {
  const list = snapshotTerminals(ctx);
  if (list.length === 0) return null;
  if (typeof target.leafId === "number") {
    const hit = list.find((r) => r.leafId === target.leafId);
    return hit ? hit.leafId : null;
  }
  if (typeof target.tabId === "number") {
    const hit =
      list.find((r) => r.tabId === target.tabId && r.isActive) ??
      list.find((r) => r.tabId === target.tabId);
    return hit ? hit.leafId : null;
  }
  if (typeof target.ordinal === "number") {
    const hit = list.find((r) => r.ordinal === target.ordinal);
    return hit ? hit.leafId : null;
  }
  if (typeof target.title === "string" && target.title.trim()) {
    const needle = target.title.trim().toLowerCase();
    const hit = list.find((r) => r.title.toLowerCase().includes(needle));
    return hit ? hit.leafId : null;
  }
  // Fall back to the active terminal.
  const active = list.find((r) => r.isActive);
  return active ? active.leafId : null;
}
