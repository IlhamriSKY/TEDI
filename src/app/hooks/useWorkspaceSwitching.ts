import { leaves, disposeSession } from "@/modules/terminal";
import { type Tab } from "@/modules/tabs";
import {
  defaultTabForEmptyWorkspace,
  savedActiveTabIndex,
  restoreTabs,
  serializeTabs,
  useWorkspacesStore,
} from "@/modules/workspaces";
import { useCallback, type RefObject } from "react";

type Params = {
  wsActiveId: string | null;
  wsList: { id: string }[];
  tabs: Tab[];
  activeId: number;
  wsSaveTabs: (
    workspaceId: string,
    saved: ReturnType<typeof serializeTabs>,
    activeTabIndex: number,
    liveTabCount?: number,
  ) => void;
  wsSetActive: (id: string | null) => void;
  wsCreate: (name: string) => { id: string };
  wsRemove: (id: string) => void;
  allocId: () => number;
  home: string | null;
  replaceAllTabs: (tabs: Tab[], activeId: number | null) => void;
  liveTabsByWorkspace: RefObject<Map<string, { tabs: Tab[]; activeId: number | null }>>;
  skipNextSnapshotRef: RefObject<boolean>;
};

/**
 * Workspace switch / create / close orchestration. Bundles the three
 * callbacks that move live tab trees between workspaces while keeping PTY /
 * xterm sessions attached. The shared refs (`liveTabsByWorkspace`,
 * `skipNextSnapshotRef`) live in App because other effects read them; they
 * are passed in here.
 */
export function useWorkspaceSwitching({
  wsActiveId,
  wsList,
  tabs,
  activeId,
  wsSaveTabs,
  wsSetActive,
  wsCreate,
  wsRemove,
  allocId,
  home,
  replaceAllTabs,
  liveTabsByWorkspace,
  skipNextSnapshotRef,
}: Params): {
  switchToWorkspace: (workspaceId: string) => void;
  createNewWorkspace: () => void;
  closeWorkspace: (workspaceId: string) => void;
} {
  const switchToWorkspace = useCallback(
    (workspaceId: string) => {
      if (workspaceId === wsActiveId) return;
      // Snapshot current first.
      if (wsActiveId) {
        // Disk snapshot for restart. Drops live ids, keeps cwd/path.
        const saved = serializeTabs(tabs);
        wsSaveTabs(wsActiveId, saved, savedActiveTabIndex(tabs, activeId), tabs.length);
        // Live snapshot for in-session switches. Keeps leaf ids so the
        // existing PTY/xterm sessions stay attached on return.
        liveTabsByWorkspace.current.set(wsActiveId, {
          tabs,
          activeId,
        });
      }
      wsSetActive(workspaceId);
      // Prefer the live cache so the leaf ids match the running terminal
      // sessions and the dispose effect doesn't kill them.
      const cached = liveTabsByWorkspace.current.get(workspaceId);
      if (cached && cached.tabs.length > 0) {
        replaceAllTabs(cached.tabs, cached.activeId);
        return;
      }
      const next = useWorkspacesStore.getState().workspaces.find((w) => w.id === workspaceId);
      if (!next) return;
      // Emptiness is decided AFTER restoring, not before: a workspace whose
      // every tab was a browser has saved tabs and no live ones, and switching
      // into it must still land on a usable pane rather than a blank window.
      const restored = next.tabs.length === 0 ? [] : restoreTabs(next.tabs, allocId);
      const liveTabs: Tab[] =
        restored.length === 0
          ? [defaultTabForEmptyWorkspace(allocId, home ?? undefined)]
          : restored;
      const target = liveTabs[Math.min(next.activeTabIndex, liveTabs.length - 1)] ?? liveTabs[0];
      replaceAllTabs(liveTabs, target?.id ?? null);
    },
    [wsActiveId, tabs, activeId, wsSaveTabs, wsSetActive, allocId, home, replaceAllTabs],
  );

  const createNewWorkspace = useCallback(() => {
    const n = wsList.length + 1;
    const ws = wsCreate(`Workspace ${n}`);
    switchToWorkspace(ws.id);
  }, [wsList.length, wsCreate, switchToWorkspace]);

  const closeWorkspace = useCallback(
    (workspaceId: string) => {
      const wasActive = workspaceId === wsActiveId;
      // Closing the active workspace: skip the next auto-snapshot so the
      // closing workspace's live tabs don't clobber the neighbor's saved
      // tabs.
      if (wasActive) skipNextSnapshotRef.current = true;
      // Dispose the closed workspace's terminal sessions before dropping the
      // cache. For a NON-active workspace these leaves live only in this cache
      // (not in `tabs`), so the `[tabs]`-keyed orphan-reconcile effect never
      // runs for them - their xterm + 5k-line scrollback (~6 MB each) would
      // otherwise leak in the module `sessions` Map until the app exits.
      // disposeSession is idempotent, so this is safe even when the reconcile
      // pass (active-workspace close) also covers them.
      const closing = liveTabsByWorkspace.current.get(workspaceId);
      if (closing) {
        for (const t of closing.tabs) {
          if (t.kind !== "pane") continue;
          for (const leaf of leaves(t.paneTree)) {
            if (leaf.leafKind === "terminal") disposeSession(leaf.id);
          }
        }
      }
      // Drop the cached live tabs so the closed workspace's leaves stop
      // being "live" and the next tabs-effect pass disposes their PTYs.
      liveTabsByWorkspace.current.delete(workspaceId);
      wsRemove(workspaceId);
      if (!wasActive) return;
      const nextActiveId = useWorkspacesStore.getState().activeId;
      const next = useWorkspacesStore.getState().workspaces.find((w) => w.id === nextActiveId);
      if (!next) return;
      const cached = nextActiveId !== null ? liveTabsByWorkspace.current.get(nextActiveId) : null;
      if (cached && cached.tabs.length > 0) {
        replaceAllTabs(cached.tabs, cached.activeId);
        return;
      }
      // Emptiness is decided AFTER restoring, not before: a workspace whose
      // every tab was a browser has saved tabs and no live ones, and switching
      // into it must still land on a usable pane rather than a blank window.
      const restored = next.tabs.length === 0 ? [] : restoreTabs(next.tabs, allocId);
      const liveTabs: Tab[] =
        restored.length === 0
          ? [defaultTabForEmptyWorkspace(allocId, home ?? undefined)]
          : restored;
      const target = liveTabs[Math.min(next.activeTabIndex, liveTabs.length - 1)] ?? liveTabs[0];
      replaceAllTabs(liveTabs, target?.id ?? null);
    },
    [wsActiveId, wsRemove, allocId, home, replaceAllTabs],
  );

  return { switchToWorkspace, createNewWorkspace, closeWorkspace };
}
