import {
  setOpenExtensionTab,
  setOpenExtensionPane,
  setSetExtensionTabState,
  setSidebarSetter,
  setRightSidebarSetter,
  type OpenExtensionTabOpts,
  type SetExtensionTabStateOpts,
} from "@/modules/extensions/tabsBridge";
import { useChatStore } from "@/modules/ai";
import { useRightPanelStore } from "@/modules/extensions";
import { useScmRightPanelStore } from "@/modules/scm/scmRightPanelStore";
import type { Tab } from "@/modules/tabs";
import { useEffect, type RefObject } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

/** Snapshot of whichever of the two auto-restorable right surfaces
 *  (AI chat, extension right panel) was open at the moment an extension
 *  asked the right slot to close. `null` means the slot was either empty
 *  or only had Source Control open — SCM is manual-only and is never
 *  auto-restored, so it gets closed alongside the others on hide but is
 *  never recorded for replay. */
export type RightAuxSnapshot =
  | { kind: "chat" }
  | { kind: "rightPanel"; extensionId: string; panelId: string }
  | null;

type Params = {
  openExtensionTab: (opts: OpenExtensionTabOpts) => number | null;
  openExtensionPane: (opts: OpenExtensionTabOpts) => number | null;
  setExtensionTabState: (opts: SetExtensionTabStateOpts) => void;
  sidebarRef: RefObject<PanelImperativeHandle | null>;
  sidebarHiderRef: RefObject<{ extensionId: string; prior: boolean } | null>;
  rightSidebarHiderRef: RefObject<{
    extensionId: string;
    prior: RightAuxSnapshot;
  } | null>;
  activeTab: Tab | undefined;
  tabs: Tab[];
};

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
      const visibleNow = p.getSize().asPercentage > 0;
      if (ownerExtensionId && !visible) {
        if (!sidebarHiderRef.current) {
          sidebarHiderRef.current = { extensionId: ownerExtensionId, prior: visibleNow };
        }
      } else {
        sidebarHiderRef.current = null;
      }
      if (visible && !visibleNow) p.expand();
      else if (!visible && visibleNow) p.collapse();
    });
    return () => setSidebarSetter(null);
  }, []);

  // Mirror of the left-sidebar setter for the right-side aux column. The
  // three right surfaces (AI chat, extension right panel, SCM right panel)
  // are mutually exclusive so we just snapshot whichever was open, close
  // them all on hide, and replay the snapshot when the owning ext tab goes
  // away. `visible === true` clears the latch (no re-open: the user can
  // toggle it manually).
  //
  // Source Control is intentionally excluded from the snapshot: the user
  // has asked for SCM to be strictly status-bar-icon-driven, so even if
  // it was open when the extension hid the sidebar, we don't auto-restore
  // it. They close behind the extension and stay closed.
  useEffect(() => {
    setRightSidebarSetter((visible, ownerExtensionId) => {
      const chat = useChatStore.getState();
      const rightPanel = useRightPanelStore.getState();
      const scm = useScmRightPanelStore.getState();
      const snapshot: RightAuxSnapshot = chat.panelOpen
        ? { kind: "chat" }
        : rightPanel.active
          ? {
              kind: "rightPanel",
              extensionId: rightPanel.active.extensionId,
              panelId: rightPanel.active.panelId,
            }
          : null;
      if (ownerExtensionId && !visible) {
        if (!rightSidebarHiderRef.current) {
          rightSidebarHiderRef.current = { extensionId: ownerExtensionId, prior: snapshot };
        }
      } else {
        rightSidebarHiderRef.current = null;
      }
      if (!visible) {
        if (chat.panelOpen) chat.closePanel();
        if (rightPanel.active) rightPanel.close();
        if (scm.open) scm.closePanel();
      }
      // `visible === true` is a no-op: we don't know which of the three
      // surfaces to reopen from a bare call. The owner-restore effect
      // below handles the actual replay when the ext tab goes away.
    });
    return () => setRightSidebarSetter(null);
  }, []);

  // Auto-restore the right-side aux column around the ext tab that hid
  // it. Same shape as the left-sidebar effect above. Restoring is a
  // best-effort replay: if the panel the user had open no longer exists
  // (extension uninstalled), we silently skip rather than show an empty
  // slot.
  useEffect(() => {
    const hider = rightSidebarHiderRef.current;
    if (!hider) return;
    const stillOpen = tabs.some((t) => t.kind === "ext" && t.extensionId === hider.extensionId);
    const replay = (): void => {
      const prior = hider.prior;
      if (!prior) return;
      // SCM is deliberately not in the union: see the setter above. The
      // user must reopen it via the status-bar GitBranch icon.
      if (prior.kind === "chat") useChatStore.getState().openPanel();
      else if (prior.kind === "rightPanel")
        useRightPanelStore.getState().open(prior.extensionId, prior.panelId);
    };
    if (!stillOpen) {
      replay();
      rightSidebarHiderRef.current = null;
      return;
    }
    const onHiderTab = activeTab?.kind === "ext" && activeTab.extensionId === hider.extensionId;
    if (onHiderTab) {
      const chat = useChatStore.getState();
      const rightPanel = useRightPanelStore.getState();
      const scm = useScmRightPanelStore.getState();
      if (chat.panelOpen) chat.closePanel();
      if (rightPanel.active) rightPanel.close();
      if (scm.open) scm.closePanel();
    } else {
      replay();
    }
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
    const visibleNow = p.getSize().asPercentage > 0;
    const stillOpen = tabs.some((t) => t.kind === "ext" && t.extensionId === hider.extensionId);
    if (!stillOpen) {
      if (hider.prior && !visibleNow) p.expand();
      else if (!hider.prior && visibleNow) p.collapse();
      sidebarHiderRef.current = null;
      return;
    }
    const onHiderTab = activeTab?.kind === "ext" && activeTab.extensionId === hider.extensionId;
    if (onHiderTab) {
      if (visibleNow) p.collapse();
    } else {
      if (hider.prior && !visibleNow) p.expand();
      else if (!hider.prior && visibleNow) p.collapse();
    }
  }, [activeTab, tabs]);
}
