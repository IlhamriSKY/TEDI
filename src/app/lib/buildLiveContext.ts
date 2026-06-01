import { type RefObject } from "react";
import { activeLeaf, MAX_PANES_PER_TAB, useTabs, type Tab } from "@/modules/tabs";
import { findLeaf, hasLeaf, leafIds, leaves, type TerminalPaneHandle } from "@/modules/terminal";
import type { TerminalTarget } from "@/modules/scheduler/types";
import { isLeafPrivate, resolveTerminalLeaf, snapshotTerminals } from "./terminalSnapshot";

type TabsApi = ReturnType<typeof useTabs>;

/**
 * Shape mirrored into `liveContextRef.current` in App. Holds the slice of
 * live state + callbacks the AI bridge closures read through the ref so
 * they stay stable across re-renders. Kept in sync with the two literals
 * App writes into the ref.
 */
export interface LiveContext {
  tabs: Tab[];
  activeId: number;
  explorerRoot: string | null;
  home: string | null;
  openPreviewTab: (url: string) => number | null;
  newTab: TabsApi["newTab"];
  inheritedCwdForNewTab: () => string | undefined;
  splitActivePane: TabsApi["splitActivePane"];
  setActiveId: TabsApi["setActiveId"];
  moveLeafToTab: TabsApi["moveLeafToTab"];
  closePaneByLeaf: TabsApi["closePaneByLeaf"];
}

/**
 * Component-local identifiers from App that the AI live-context object
 * closes over. Module-level helpers (snapshotTerminals / resolveTerminalLeaf
 * / isLeafPrivate from ./terminalSnapshot, plus activeLeaf / leaves /
 * leafIds / findLeaf / hasLeaf / MAX_PANES_PER_TAB) are imported directly
 * above. The return type is left inferred so it stays structurally
 * identical to what setLive expects.
 */
export interface LiveContextDeps {
  liveContextRef: RefObject<LiveContext>;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
}

export function buildLiveContext(deps: LiveContextDeps) {
  const { liveContextRef, terminalRefs } = deps;
  return {
    getCwd: () => {
      const { tabs, activeId, explorerRoot, home } = liveContextRef.current;
      const active = tabs.find((x) => x.id === activeId);
      // Private leaves never leak their cwd. Fall back to the workspace
      // root the same way an empty terminal tab would.
      if (active?.kind === "pane") {
        const leaf = activeLeaf(active);
        if (leaf?.leafKind === "terminal" && !leaf.private && leaf.cwd) return leaf.cwd;
      }
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (t.kind !== "pane") continue;
        for (const l of leaves(t.paneTree)) {
          if (l.leafKind === "terminal" && !l.private && l.cwd) return l.cwd;
        }
      }
      return explorerRoot ?? home ?? null;
    },
    getTerminalContext: (lines?: number) => {
      const { tabs, activeId } = liveContextRef.current;
      const t = tabs.find((x) => x.id === activeId);
      if (!t || t.kind !== "pane") return null;
      const leaf = activeLeaf(t);
      if (!leaf || leaf.leafKind !== "terminal") return null;
      // Private leaves deny scrollback reads entirely. The AI sees null,
      // same as if the active leaf weren't a terminal.
      if (leaf.private) return null;
      const n = Math.max(1, Math.min(2000, lines ?? 300));
      return terminalRefs.current.get(leaf.id)?.getBuffer(n) ?? null;
    },
    injectIntoActivePty: (text: string) => {
      const { tabs, activeId } = liveContextRef.current;
      const t = tabs.find((x) => x.id === activeId);
      if (!t || t.kind !== "pane") return false;
      const leaf = activeLeaf(t);
      if (!leaf || leaf.leafKind !== "terminal") return false;
      // Refuse injection into private leaves. The AI sees `no active
      // terminal`, identical to the no-terminal fallback.
      if (leaf.private) return false;
      const term = terminalRefs.current.get(leaf.id);
      if (!term) return false;
      term.write(text);
      term.focus();
      return true;
    },
    getWorkspaceRoot: () => {
      const { explorerRoot, home } = liveContextRef.current;
      return explorerRoot ?? home ?? null;
    },
    getActiveFile: () => {
      const { tabs, activeId } = liveContextRef.current;
      const t = tabs.find((x) => x.id === activeId);
      if (!t || t.kind !== "pane") return null;
      const leaf = activeLeaf(t);
      if (!leaf || leaf.leafKind !== "editor") return null;
      // Private editor leaves keep their path hidden too.
      if (leaf.private) return null;
      return leaf.path;
    },
    openPreview: (url: string) => {
      return liveContextRef.current.openPreviewTab(url) !== null;
    },
    openTerminal: (cwd?: string | null) => {
      const { explorerRoot, newTab, inheritedCwdForNewTab } = liveContextRef.current;
      const target = cwd ?? explorerRoot ?? inheritedCwdForNewTab();
      newTab(target ?? undefined);
      return true;
    },
    runInActiveTerminal: (command: string) => {
      const { tabs, activeId } = liveContextRef.current;
      const t = tabs.find((x) => x.id === activeId);
      if (!t || t.kind !== "pane") return false;
      const leaf = activeLeaf(t);
      if (!leaf || leaf.leafKind !== "terminal") return false;
      // Private leaves refuse all AI-driven command submission.
      if (leaf.private) return false;
      const term = terminalRefs.current.get(leaf.id);
      if (!term) return false;
      // Strip trailing newlines, submit with CR. Windows ConPTY + pwsh
      // require \r, not \n. Matches sendCd / cdInNewTab above.
      const trimmed = command.replace(/[\r\n]+$/, "");
      term.write(`${trimmed}\r`);
      term.focus();
      return true;
    },
    listTerminals: () => snapshotTerminals(liveContextRef.current),
    injectIntoTerminal: (target: TerminalTarget, text: string) => {
      const leafId = resolveTerminalLeaf(target, liveContextRef.current);
      if (leafId === null) return false;
      // Defense in depth: snapshotTerminals already filters private, but
      // re-check by leafId in case future code paths bypass the snapshot.
      if (isLeafPrivate(liveContextRef.current, leafId)) return false;
      const term = terminalRefs.current.get(leafId);
      if (!term) return false;
      term.write(text);
      return true;
    },
    runInTerminal: (target: TerminalTarget, command: string) => {
      const leafId = resolveTerminalLeaf(target, liveContextRef.current);
      if (leafId === null) return false;
      if (isLeafPrivate(liveContextRef.current, leafId)) return false;
      const term = terminalRefs.current.get(leafId);
      if (!term) return false;
      const trimmed = command.replace(/[\r\n]+$/, "");
      term.write(`${trimmed}\r`);
      return true;
    },
    openTerminalAdvanced: (opts: {
      cwd?: string | null;
      mode?: "tab" | "split";
      splitDir?: "row" | "col";
      targetTabId?: number | null;
    }):
      | { ok: true; tabId: number; leafId: number | null; mode: "tab" | "split" }
      | { ok: false; error: string } => {
      const {
        tabs,
        activeId,
        explorerRoot,
        inheritedCwdForNewTab,
        splitActivePane,
        newTab,
        setActiveId,
      } = liveContextRef.current;
      const mode = opts.mode ?? "tab";
      const cwd = opts.cwd ?? null;
      if (mode === "split") {
        const targetTabId = opts.targetTabId ?? activeId;
        const target = tabs.find((x) => x.id === targetTabId);
        if (!target) return { ok: false, error: `tab ${targetTabId} not found` };
        if (target.kind !== "pane")
          return { ok: false, error: `tab ${targetTabId} is not a pane tab` };
        if (leafIds(target.paneTree).length >= MAX_PANES_PER_TAB)
          return { ok: false, error: `tab ${targetTabId} already has MAX_PANES_PER_TAB panes` };
        // Focus the target tab so the split operates on it.
        if (targetTabId !== activeId) setActiveId(targetTabId);
        const dir = opts.splitDir ?? "row";
        const cwdResolved =
          cwd ??
          (() => {
            const active = findLeaf(target.paneTree, target.activeLeafId);
            return active?.leafKind === "terminal" ? (active.cwd ?? null) : null;
          })() ??
          explorerRoot ??
          null;
        const newLeafId = splitActivePane(targetTabId, dir, "terminal", cwdResolved ?? undefined);
        if (newLeafId === null)
          return { ok: false, error: "could not split (active leaf missing or limit reached)" };
        return { ok: true, tabId: targetTabId, leafId: newLeafId, mode: "split" };
      }
      const targetCwd = cwd ?? explorerRoot ?? inheritedCwdForNewTab();
      try {
        const newTabId = newTab(targetCwd ?? undefined);
        return { ok: true, tabId: newTabId, leafId: null, mode: "tab" };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },
    consolidateTerminalsIntoGroup: (
      targetTabId: number,
    ):
      | { ok: true; targetTabId: number; moved: number; alreadyInGroup: number }
      | { ok: false; error: string; movedBeforeFailure?: number } => {
      const { tabs, moveLeafToTab, setActiveId } = liveContextRef.current;
      const target = tabs.find((x) => x.id === targetTabId);
      if (!target) return { ok: false, error: `tab ${targetTabId} not found` };
      if (target.kind !== "pane")
        return { ok: false, error: `tab ${targetTabId} is not a pane tab` };
      const allTerminals = snapshotTerminals(liveContextRef.current);
      if (allTerminals.length === 0)
        return { ok: false, error: "no terminals open to consolidate" };
      if (allTerminals.length > MAX_PANES_PER_TAB)
        return {
          ok: false,
          error: `cannot consolidate ${allTerminals.length} terminals into one tab - the per-tab cap is ${MAX_PANES_PER_TAB}. Close some or merge in batches.`,
        };
      let moved = 0;
      let alreadyInGroup = 0;
      for (const t of allTerminals) {
        if (t.tabId === targetTabId) {
          alreadyInGroup += 1;
          continue;
        }
        const r = moveLeafToTab(t.leafId, targetTabId);
        if (r === "ok") {
          moved += 1;
        } else if (r === "full") {
          return {
            ok: false,
            error: "target tab filled up mid-move",
            movedBeforeFailure: moved,
          };
        } else {
          return {
            ok: false,
            error: `move failed (${r})`,
            movedBeforeFailure: moved,
          };
        }
      }
      // Focus the consolidated group.
      setActiveId(targetTabId);
      return { ok: true, targetTabId, moved, alreadyInGroup };
    },
    closeTerminalLeaf: (
      leafId: number,
    ): { ok: true; closedTab: boolean } | { ok: false; error: string } => {
      const { tabs, closePaneByLeaf } = liveContextRef.current;
      const owner = tabs.find((t) => t.kind === "pane" && hasLeaf(t.paneTree, leafId));
      if (!owner || owner.kind !== "pane") return { ok: false, error: `leaf ${leafId} not found` };
      // Private leaves are invisible to the AI; report not-found rather
      // than letting the AI close one.
      if (isLeafPrivate(liveContextRef.current, leafId))
        return { ok: false, error: `leaf ${leafId} not found` };
      const onlyLeafInTab = leafIds(owner.paneTree).length === 1;
      const onlyTab = tabs.filter((t) => t.kind === "pane").length === 1;
      if (onlyLeafInTab && onlyTab)
        return { ok: false, error: "refusing to close the last terminal" };
      closePaneByLeaf(leafId);
      return { ok: true, closedTab: onlyLeafInTab };
    },
    isTerminalBusy: (target?: TerminalTarget) => {
      // Resolve target (default = active terminal). Missing terminal is
      // reported as busy so callers fall through to "open new terminal".
      // Private leaves are also reported as busy so suggest_command and
      // run_in_terminal route the AI into a fresh public terminal
      // instead of writing to the private one.
      const leafId =
        target === undefined
          ? (() => {
              const { tabs, activeId } = liveContextRef.current;
              const t = tabs.find((x) => x.id === activeId);
              if (!t || t.kind !== "pane") return null;
              const leaf = activeLeaf(t);
              if (!leaf || leaf.leafKind !== "terminal") return null;
              if (leaf.private) return null;
              return leaf.id;
            })()
          : resolveTerminalLeaf(target, liveContextRef.current);
      if (leafId === null) return true;
      if (isLeafPrivate(liveContextRef.current, leafId)) return true;
      const term = terminalRefs.current.get(leafId);
      if (!term) return true;
      return !term.isAtPrompt();
    },
  };
}
