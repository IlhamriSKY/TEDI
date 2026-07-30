import { type RefObject } from "react";
import {
  previewEmbedAct,
  previewEmbedDispatch,
  previewEmbedNavigate,
  previewEmbedRead,
  previewEmbedConsole,
  previewEmbedScreenshot,
  type BrowserDiag,
} from "@/modules/browser";
import { useFloatStore } from "@/modules/panes";
import { activeLeaf, MAX_PANES_PER_TAB, useTabs, type Tab } from "@/modules/tabs";
import {
  findLeaf,
  hasLeaf,
  isRemoteEditorLeaf,
  leafIds,
  leafParentDir,
  leaves,
  type TerminalPaneHandle,
} from "@/modules/terminal";
import type { BrowserInfo, TerminalTarget } from "@/modules/scheduler/types";
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
  openPreviewTab: (url: string, activate?: boolean) => number | null;
  setBrowserLeafUrl: TabsApi["setBrowserLeafUrl"];
  newTab: TabsApi["newTab"];
  inheritedCwdForNewTab: () => string | undefined;
  splitActivePane: TabsApi["splitActivePane"];
  setActiveId: TabsApi["setActiveId"];
  moveLeafToTab: TabsApi["moveLeafToTab"];
  rotateLeafSplit: TabsApi["rotateLeafSplit"];
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

/** A browser pane the AI is allowed to see: exists as a public (non-private) browser leaf. */
function isPublicBrowserLeaf(ctx: LiveContext, leafId: number): boolean {
  return (
    ctx.tabs.some(
      (t) => t.kind === "pane" && findLeaf(t.paneTree, leafId)?.leafKind === "browser",
    ) && !isLeafPrivate(ctx, leafId)
  );
}

export function buildLiveContext(deps: LiveContextDeps) {
  const { liveContextRef, terminalRefs } = deps;
  return {
    getCwd: () => {
      const { tabs, activeId, explorerRoot, home } = liveContextRef.current;
      const active = tabs.find((x) => x.id === activeId);
      // Private leaves never leak their cwd. SSH leaves are skipped too: their
      // OSC 7 cwd names a path on the REMOTE host, and every consumer of this
      // value (resolvePath, the fs/edit tools, the agent shell's cwd) runs
      // LOCALLY, so a remote `/home/u/app` would be read or written against
      // this machine. Same predicate `useWorkspaceCwd` uses to keep the local
      // explorer off a remote root. Fall back to the workspace root the same
      // way an empty terminal tab would.
      if (active?.kind === "pane") {
        const leaf = activeLeaf(active);
        if (leaf?.leafKind === "terminal" && !leaf.private && !leaf.sshConnectionId && leaf.cwd)
          return leaf.cwd;
      }
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (t.kind !== "pane") continue;
        for (const l of leaves(t.paneTree)) {
          if (l.leafKind === "terminal" && !l.private && !l.sshConnectionId && l.cwd) return l.cwd;
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
      // So do remote ones: this lands in `<env>` as `active_file`, and every
      // file tool the model can reach from there runs against the LOCAL disk.
      if (isRemoteEditorLeaf(leaf)) return null;
      return leaf.path;
    },
    openPreview: (url: string) => {
      // activate:false - the agent opens browsers in the background so it can
      // read them without stealing focus from whatever the user is doing. The
      // inactive pane still creates its native webview OFF-SCREEN (see
      // preview_embed_update's background-create branch), so the page loads and
      // read_browser works headless even while the user never focuses the tab.
      return liveContextRef.current.openPreviewTab(url, false);
    },
    // Drive an existing browser pane (by leaf id from listBrowsers). navigate
    // just sets the leaf url - BrowserPane navigates the live webview and syncs
    // the address bar, and a not-yet-shown pane loads the new url when opened.
    navigateBrowser: (leafId: number, url: string): boolean => {
      const { setBrowserLeafUrl } = liveContextRef.current;
      if (!isPublicBrowserLeaf(liveContextRef.current, leafId)) return false;
      setBrowserLeafUrl(leafId, url);
      // A FLOATED pane's component lives in its float window and no longer
      // follows this leaf's url, so setting the leaf alone would report success
      // and navigate nothing at all. Drive the webview directly in that case;
      // the float's address bar catches up from the navigation event. Only in
      // that case, so the ordinary path keeps its single navigation.
      if (useFloatStore.getState().floating.has(leafId)) {
        void previewEmbedNavigate(leafId, url).catch(() => {});
      }
      return true;
    },
    dispatchBrowser: (leafId: number, action: "back" | "forward" | "reload" | "stop"): boolean => {
      if (!isPublicBrowserLeaf(liveContextRef.current, leafId)) return false;
      void previewEmbedDispatch(leafId, action).catch(() => {});
      return true;
    },
    readBrowser: async (leafId: number, fields = false): Promise<string | null> => {
      if (!isPublicBrowserLeaf(liveContextRef.current, leafId)) return null;
      try {
        return await previewEmbedRead(leafId, fields);
      } catch {
        return null;
      }
    },
    actBrowser: async (
      leafId: number,
      index: number,
      action: "click" | "type" | "hover" | "key" | "scroll" | "clickxy",
      text: string,
      submit: boolean,
    ): Promise<string | null> => {
      if (!isPublicBrowserLeaf(liveContextRef.current, leafId)) return null;
      try {
        return await previewEmbedAct(leafId, index, action, text, submit);
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    consoleBrowser: async (leafId: number): Promise<BrowserDiag[] | null> => {
      if (!isPublicBrowserLeaf(liveContextRef.current, leafId)) return null;
      try {
        return await previewEmbedConsole(leafId);
      } catch {
        return null;
      }
    },
    screenshotBrowser: async (leafId: number): Promise<string | null> => {
      if (!isPublicBrowserLeaf(liveContextRef.current, leafId)) return null;
      try {
        return await previewEmbedScreenshot(leafId);
      } catch {
        return null;
      }
    },
    listBrowsers: (): BrowserInfo[] => {
      const { tabs, activeId } = liveContextRef.current;
      const out: BrowserInfo[] = [];
      for (const t of tabs) {
        if (t.kind !== "pane") continue;
        for (const l of leaves(t.paneTree)) {
          // Skip private browser panes so they stay invisible to the AI.
          if (l.leafKind === "browser" && !l.private) {
            out.push({
              tabId: t.id,
              leafId: l.id,
              url: l.url,
              isActive: t.id === activeId && t.activeLeafId === l.id,
            });
          }
        }
      }
      return out;
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
    groupLeavesIntoTab: (
      ids: number[],
      targetTabId?: number,
    ):
      | { ok: true; targetTabId: number; moved: number; alreadyInGroup: number }
      | { ok: false; error: string } => {
      const { tabs, moveLeafToTab, setActiveId } = liveContextRef.current;
      // Resolve each requested leaf to the pane tab that owns it; ignore unknown
      // ids and private leaves (those are hidden from the AI).
      const found: { leafId: number; tabId: number }[] = [];
      for (const id of ids) {
        if (isLeafPrivate(liveContextRef.current, id)) continue;
        const owner = tabs.find((t) => t.kind === "pane" && hasLeaf(t.paneTree, id));
        if (owner) found.push({ leafId: id, tabId: owner.id });
      }
      if (found.length < 2)
        return { ok: false, error: "need at least 2 existing panes (by leaf_id) to group" };
      // Destination: explicit target (must be a pane tab) or the first leaf's tab.
      const dest = targetTabId ?? found[0].tabId;
      const destTab = tabs.find((t) => t.id === dest);
      if (!destTab || destTab.kind !== "pane")
        return { ok: false, error: `tab ${dest} is not a pane tab` };
      const incoming = found.filter((f) => f.tabId !== dest);
      if (leafIds(destTab.paneTree).length + incoming.length > MAX_PANES_PER_TAB)
        return {
          ok: false,
          error: `grouping would exceed the ${MAX_PANES_PER_TAB}-pane-per-tab cap`,
        };
      let moved = 0;
      for (const f of incoming) {
        const r = moveLeafToTab(f.leafId, dest);
        if (r === "ok") moved += 1;
        else if (r === "full")
          return { ok: false, error: `target group filled up (max ${MAX_PANES_PER_TAB})` };
        else return { ok: false, error: `could not move pane leaf=${f.leafId}` };
      }
      setActiveId(dest);
      return { ok: true, targetTabId: dest, moved, alreadyInGroup: found.length - incoming.length };
    },
    rotatePaneSplit: (
      leafId: number,
      direction?: "row" | "col",
    ):
      { ok: true; orientation: "row" | "col"; changed: boolean } | { ok: false; error: string } => {
      const { tabs, rotateLeafSplit } = liveContextRef.current;
      if (isLeafPrivate(liveContextRef.current, leafId))
        return { ok: false, error: `leaf ${leafId} not found` };
      const owner = tabs.find((t) => t.kind === "pane" && hasLeaf(t.paneTree, leafId));
      if (!owner || owner.kind !== "pane") return { ok: false, error: `leaf ${leafId} not found` };
      const current = leafParentDir(owner.paneTree, leafId);
      if (current === null)
        return { ok: false, error: "this pane is alone in its tab; split or group it first" };
      // With an explicit target, rotate only when it differs (idempotent);
      // without one, just toggle to the opposite orientation.
      if (direction && direction === current)
        return { ok: true, orientation: current, changed: false };
      rotateLeafSplit(leafId);
      return { ok: true, orientation: current === "row" ? "col" : "row", changed: true };
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
