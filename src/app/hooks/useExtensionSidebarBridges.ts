import {
  setOpenExtensionTab,
  setOpenExtensionPane,
  setSetExtensionTabState,
  setSidebarSetter,
  setRightSidebarSetter,
  type OpenExtensionTabOpts,
  type SetExtensionTabStateOpts,
} from "@/modules/extensions/tabsBridge";
import type { Tab } from "@/modules/tabs";
import { useEffect, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { isPanelOpen, setPanelOpen } from "@/app/lib/panelSize";

type Params = {
  openExtensionTab: (opts: OpenExtensionTabOpts) => number | null;
  openExtensionPane: (opts: OpenExtensionTabOpts) => number | null;
  setExtensionTabState: (opts: SetExtensionTabStateOpts) => void;
  sidebarRef: RefObject<PanelImperativeHandle | null>;
  sidebarHiderRef: RefObject<{ extensionId: string; prior: boolean } | null>;
  /** Twin of `sidebarRef` for the right column. It only became collapsible in
   *  its own right recently; before that, hiding it meant CLOSING its surfaces,
   *  which is why this file used to carry a snapshot/replay machine. */
  rightSlotRef: RefObject<PanelImperativeHandle | null>;
  /** App's single source of truth for the sidebar's closed-by-intent state. This
   *  hook keeps it in sync when it programmatically shows/hides the sidebar, so
   *  App's minimize->restore guard never reads a stale collapse intent. */
  rightSidebarHiderRef: RefObject<{ extensionId: string; prior: boolean } | null>;
  activeTab: Tab | undefined;
  tabs: Tab[];
};

/** Imperatively show/hide the sidebar AND record the resulting closed-intent in
 *  the shared ref. App's minimize->restore guard reads that ref and cannot
 *  observe an imperative expand()/collapse() the way it observes a user drag, so
 *  a programmatic show/hide that skipped the ref would leave a stale intent and
 *  the sidebar could come back the wrong way after a restore. Guards the panel
 *  calls so a redundant show/hide is a no-op, but always writes the intended
 *  state. */
function setSidebarVisibleImperative(p: PanelImperativeHandle, visible: boolean): void {
  // Guarded: expand() and collapse() throw from the same lookups getSize()
  // does, so reading safely and then acting blind still crashed.
  setPanelOpen(p, visible);
}

/**
 * Registers the extension-host bridge setters for the tabs/sidebar surfaces
 * and runs the sidebar / right-aux auto-restore effects that pair with them.
 *
 * The refs (sidebar handle + the two hider latches) live in App so other
 * effects can read them; they are passed in here. Effects are moved verbatim
 * with identical dependency arrays.
 */
export function useExtensionSidebarBridges({
  openExtensionTab,
  openExtensionPane,
  setExtensionTabState,
  sidebarRef,
  sidebarHiderRef,
  rightSlotRef,
  rightSidebarHiderRef,
  activeTab,
  tabs,
}: Params): void {
  // Wire the tabsBridge so `ctx.tabs.openExtensionTab(...)` in the host
  // API can push a new tab. `openExtensionTab` is stable across renders.
  useEffect(() => {
    setOpenExtensionTab((opts) => openExtensionTab(opts));
    return () => setOpenExtensionTab(null);
  }, [openExtensionTab]);

  // Wire `ctx.tabs.openExtensionPane(...)` so an extension can open its panel
  // as a native split-pane leaf (drag/close frame, splittable) instead of a tab.
  useEffect(() => {
    setOpenExtensionPane((opts) => openExtensionPane(opts));
    return () => setOpenExtensionPane(null);
  }, [openExtensionPane]);

  // Wire `ctx.tabs.setExtensionTabState(...)` for extensions to tint their
  // tab title by lifecycle (SQL Explorer uses it to mirror the SSH palette).
  useEffect(() => {
    setSetExtensionTabState((opts) => setExtensionTabState(opts));
    return () => setSetExtensionTabState(null);
  }, [setExtensionTabState]);

  // Wire `ctx.app.setSidebarVisible(visible)` through the imperative
  // `sidebarRef` so an extension can collapse / expand the file explorer
  // pane without having to know how it is laid out. The handle is
  // mutable across renders, so the callback dereferences it on every
  // invocation rather than closing over the current value.
  //
  // When called with an `ownerExtensionId` and `visible === false`, the
  // host snapshots the current visibility so it can restore the user's
  // prior state once they switch away from that extension's tab (see the
  // effect below that watches `activeTab`).
  useEffect(() => {
    setSidebarSetter((visible, ownerExtensionId) => {
      const p = sidebarRef.current;
      if (!p) return;
      const visibleNow = isPanelOpen(p);
      if (ownerExtensionId && !visible) {
        if (!sidebarHiderRef.current) {
          sidebarHiderRef.current = { extensionId: ownerExtensionId, prior: visibleNow };
        }
      } else {
        sidebarHiderRef.current = null;
      }
      setSidebarVisibleImperative(p, visible);
    });
    return () => setSidebarSetter(null);
  }, []);

  // TRUE mirror of the left-sidebar setter now: it collapses the column and
  // closes nothing.
  //
  // It used to close the surfaces themselves - the AI chat, every extension
  // panel, the SCM panel - and then replay a snapshot to put them back, because
  // the right column had no collapse of its own to reach for. That was the one
  // place the two host APIs were documented as twins and were not: hiding the
  // left sidebar lost nothing and restored exactly, hiding the right one tore
  // its contents down and rebuilt them approximately (a panel whose extension
  // had since been uninstalled simply never came back, and Source Control was
  // carved out of the replay entirely, so it closed and stayed closed).
  // Collapsing has nothing to lose, so the snapshot, the replay and the carve-out
  // are all gone with it - and `visible: true` is a real show instead of the
  // no-op it had to be when the host could not infer what to reopen.
  useEffect(() => {
    setRightSidebarSetter((visible, ownerExtensionId) => {
      const p = rightSlotRef.current;
      // Null while nothing is docked right: the column renders no panel, so
      // there is neither anything to hide nor anything to remember.
      if (!p) return;
      const visibleNow = isPanelOpen(p);
      if (ownerExtensionId && !visible) {
        if (!rightSidebarHiderRef.current) {
          rightSidebarHiderRef.current = { extensionId: ownerExtensionId, prior: visibleNow };
        }
      } else {
        rightSidebarHiderRef.current = null;
      }
      setSidebarVisibleImperative(p, visible);
    });
    return () => setRightSidebarSetter(null);
  }, []);

  // Auto-restore / re-hide the right column around the ext tab that requested a
  // hide. Line for line the left sidebar's effect below, which is the point.
  useEffect(() => {
    const hider = rightSidebarHiderRef.current;
    if (!hider) return;
    const p = rightSlotRef.current;
    if (!p) return;
    const stillOpen = tabs.some((t) => t.kind === "ext" && t.extensionId === hider.extensionId);
    if (!stillOpen) {
      setSidebarVisibleImperative(p, hider.prior);
      rightSidebarHiderRef.current = null;
      return;
    }
    const onHiderTab = activeTab?.kind === "ext" && activeTab.extensionId === hider.extensionId;
    setSidebarVisibleImperative(p, onHiderTab ? false : hider.prior);
  }, [activeTab, tabs]);

  // Auto-restore / re-hide the sidebar around the ext tab that requested
  // a hide. When the user navigates to a different tab, expand back to
  // the snapshotted state; when they return to the ext's tab, re-collapse.
  // If the ext closes all of its tabs, restore once and clear the latch.
  useEffect(() => {
    const hider = sidebarHiderRef.current;
    if (!hider) return;
    const p = sidebarRef.current;
    if (!p) return;
    const stillOpen = tabs.some((t) => t.kind === "ext" && t.extensionId === hider.extensionId);
    if (!stillOpen) {
      setSidebarVisibleImperative(p, hider.prior);
      sidebarHiderRef.current = null;
      return;
    }
    const onHiderTab = activeTab?.kind === "ext" && activeTab.extensionId === hider.extensionId;
    // On the hider extension's own tab the sidebar stays hidden; anywhere else,
    // restore the visibility the user had when the extension hid it.
    setSidebarVisibleImperative(p, onHiderTab ? false : hider.prior);
  }, [activeTab, tabs]);
}
