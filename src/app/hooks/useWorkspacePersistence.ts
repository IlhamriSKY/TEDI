import { type Tab } from "@/modules/tabs";
import {
  savedActiveTabIndex,
  savedToTab,
  serializeTabs,
  useWorkspacesStore,
} from "@/modules/workspaces";
import { useEffect, useRef, type RefObject } from "react";

type Workspace = ReturnType<typeof useWorkspacesStore.getState>["workspaces"][number];

type Params = {
  wsHydrate: () => void;
  wsHydrated: boolean;
  wsList: Workspace[];
  wsActiveId: string | null;
  wsSaveTabs: (
    workspaceId: string,
    saved: ReturnType<typeof serializeTabs>,
    activeTabIndex: number,
  ) => void;
  tabs: Tab[];
  activeId: number;
  allocId: () => number;
  replaceAllTabs: (tabs: Tab[], activeId: number | null) => void;
  skipNextSnapshotRef: RefObject<boolean>;
};

/**
 * Workspace persistence side of the workspaces wiring: hydrate the store on
 * mount, load the active workspace's saved tabs into live state once, and
 * auto-snapshot live tabs back to the store on every change.
 *
 * The disk snapshot (`serializeTabs` -> `wsSaveTabs`) is lightly debounced by
 * the workspaces LazyStore's autoSave window. `skipNextSnapshotRef` is shared
 * with `useWorkspaceSwitching` (a workspace close sets it so the closing
 * workspace's live tabs don't clobber the neighbor's saved tabs), so it lives
 * in App and is passed in. `hydratedWorkspaceRef` is local. Effects are moved
 * verbatim with identical dependency arrays.
 */
export function useWorkspacePersistence({
  wsHydrate,
  wsHydrated,
  wsList,
  wsActiveId,
  wsSaveTabs,
  tabs,
  activeId,
  allocId,
  replaceAllTabs,
  skipNextSnapshotRef,
}: Params): void {
  useEffect(() => {
    void wsHydrate();
  }, [wsHydrate]);

  // Once the workspace store hydrates, load the active workspace's saved
  // tabs into live state. Skip if there are none (first run already covered
  // by the default `useTabs` state).
  const hydratedWorkspaceRef = useRef(false);
  useEffect(() => {
    if (!wsHydrated || hydratedWorkspaceRef.current) return;
    const active = wsList.find((w) => w.id === wsActiveId);
    if (!active) {
      hydratedWorkspaceRef.current = true;
      return;
    }
    if (active.tabs.length === 0) {
      hydratedWorkspaceRef.current = true;
      return;
    }
    const liveTabs: Tab[] = active.tabs.map((s) => savedToTab(s, allocId));
    const target = liveTabs[Math.min(active.activeTabIndex, liveTabs.length - 1)];
    replaceAllTabs(liveTabs, target?.id ?? null);
    hydratedWorkspaceRef.current = true;
  }, [wsHydrated, wsList, wsActiveId, replaceAllTabs, allocId]);

  // Auto-snapshot tabs whenever they change. Lightly debounced via the
  // autoSave window inside the workspaces LazyStore.
  useEffect(() => {
    if (!wsHydrated || !wsActiveId || !hydratedWorkspaceRef.current) return;
    if (skipNextSnapshotRef.current) {
      skipNextSnapshotRef.current = false;
      return;
    }
    const saved = serializeTabs(tabs);
    wsSaveTabs(wsActiveId, saved, savedActiveTabIndex(tabs, activeId));
  }, [tabs, activeId, wsHydrated, wsActiveId, wsSaveTabs]);
}
