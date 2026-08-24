import type { PaneTab, Tab } from "@/modules/tabs";
import type { PaneLeaf, PaneNode } from "@/modules/terminal/lib/panes";
import { leaves } from "@/modules/terminal/lib/panes";
import { useTerminalTitles } from "@/modules/terminal/lib/terminalTitles";
import type { SavedPaneNode, SavedTab } from "./store";

/** Count terminal leaves in a serialised pane tree. Used to tally
 *  terminals across inactive workspaces without rehydrating them into
 *  live `Tab[]` objects. */
export function countSavedTerminalLeaves(node: SavedPaneNode): number {
  if (node.kind === "leaf") {
    return node.leafKind === "terminal" ? 1 : 0;
  }
  let n = 0;
  for (const child of node.children) n += countSavedTerminalLeaves(child);
  return n;
}

/** Count all leaves (terminal + editor) in a serialised pane tree. */
export function countSavedLeaves(node: SavedPaneNode): number {
  if (node.kind === "leaf") return 1;
  let n = 0;
  for (const child of node.children) n += countSavedLeaves(child);
  return n;
}

/** Tab-strip entry count for a serialised (unvisited) workspace: every leaf of
 *  each pane tab plus one per standalone (preview) tab. Mirrors the live
 *  `countTabEntries` so the badge stays consistent once the workspace is
 *  opened - a multi-pane group tab counts as its panes, not 1. */
export function countSavedTabEntries(tabs: SavedTab[]): number {
  let n = 0;
  for (const t of tabs) n += t.kind === "pane" ? countSavedLeaves(t.paneTree) : 1;
  return n;
}

// live -> saved

function leafToSaved(leaf: PaneLeaf): SavedPaneNode {
  if (leaf.leafKind === "terminal") {
    // Capture the live program title (OSC 0/2) so an inactive workspace still
    // shows it next to the folder name. Read straight from the singleton title
    // store (same store the live rows use). Private leaves never persist it.
    const title = leaf.private ? undefined : useTerminalTitles.getState().titles[leaf.id];
    return {
      kind: "leaf",
      leafKind: "terminal",
      cwd: leaf.cwd,
      sshConnectionId: leaf.sshConnectionId,
      terminalOrdinal: leaf.terminalOrdinal,
      ...(leaf.private ? { private: true } : {}),
      // Persisted even for private leaves: a name the user typed reveals
      // nothing about the shell, its cwd or its output.
      ...(leaf.customTitle ? { customTitle: leaf.customTitle } : {}),
      ...(leaf.terminalThemeId ? { terminalThemeId: leaf.terminalThemeId } : {}),
      ...(title ? { title } : {}),
      // Only local PTYs use the daemon backend; SSH leaves carry their
      // remote session id separately and aren't restored via pty_attach.
      ...(leaf.ptyId && !leaf.sshConnectionId ? { ptyId: leaf.ptyId } : {}),
      // Persist the running agent kind only for reattachable local leaves
      // (same gate as ptyId), and never for private ones. On restore it
      // pre-activates the detector so a still-running agent's badge survives.
      ...(leaf.activeTool && leaf.ptyId && !leaf.sshConnectionId && !leaf.private
        ? { activeTool: leaf.activeTool }
        : {}),
    };
  }
  if (leaf.leafKind === "editor") {
    return {
      kind: "leaf",
      leafKind: "editor",
      path: leaf.path,
      // Only the STABLE half of a remote binding is persisted. `sshSessionId`
      // is deliberately dropped: see `isUnrestorableEditorLeaf`.
      ...(leaf.sshConnectionId ? { sshConnectionId: leaf.sshConnectionId } : {}),
      ...(leaf.sshConnectionId && leaf.sshHostLabel ? { sshHostLabel: leaf.sshHostLabel } : {}),
      ...(leaf.private ? { private: true } : {}),
      ...(leaf.customTitle ? { customTitle: leaf.customTitle } : {}),
    };
  }
  if (leaf.leafKind === "extension-panel") {
    // Session-only: `tabToSaved` skips any pane tab containing an
    // extension-panel leaf, so this is never reached. Guard for exhaustiveness.
    throw new Error("extension-panel leaves are not serialized");
  }
  if (leaf.leafKind === "board") {
    // Restorable from nothing but its own existence: the columns are rebuilt
    // from the live tab tree. Unlike an extension panel it needs no host, so
    // the pane tab holding it is saved whole rather than dropped - which
    // matters when a board is split next to a terminal worth keeping.
    return {
      kind: "leaf",
      leafKind: "board",
      ...(leaf.private ? { private: true } : {}),
      ...(leaf.customTitle ? { customTitle: leaf.customTitle } : {}),
    };
  }
  return {
    kind: "leaf",
    leafKind: "browser",
    url: leaf.url,
    ...(leaf.browserOrdinal != null ? { browserOrdinal: leaf.browserOrdinal } : {}),
    ...(leaf.private ? { private: true } : {}),
    ...(leaf.customTitle ? { customTitle: leaf.customTitle } : {}),
  };
}

/**
 * True for a remote editor leaf that has nothing stable to come back as: an
 * AD-HOC connection, identified only by a LIVE russh session number that is
 * dead in a later launch (and, since the counter restarts at 1, may then name a
 * different host entirely). There is no saved profile to reconnect to, so the
 * leaf is dropped and its siblings kept.
 *
 * A leaf carrying `sshConnectionId` round-trips instead: the connection id is
 * stable across restarts and the pane re-resolves it to a live session, holding
 * the file unread until then. What must never happen is a remote leaf restored
 * as a LOCAL one, which is what a naive persist did: `useDocument` routed
 * through SFTP only while a session id was set, so the remote path was read
 * from, and on the next save written to, the local filesystem.
 */
function isUnrestorableEditorLeaf(leaf: PaneLeaf): boolean {
  return (
    leaf.leafKind === "editor" &&
    leaf.sshSessionId !== undefined &&
    leaf.sshConnectionId === undefined
  );
}

/** Serialises a pane subtree, pruning leaves that cannot be restored.
 *  Returns null when nothing in this subtree survives. */
function nodeToSaved(node: PaneNode): SavedPaneNode | null {
  if (node.kind === "leaf") return isUnrestorableEditorLeaf(node) ? null : leafToSaved(node);
  const children: SavedPaneNode[] = [];
  for (const c of node.children) {
    const s = nodeToSaved(c);
    if (s !== null) children.push(s);
  }
  if (children.length === 0) return null;
  // A lone survivor collapses into its parent: a one-child split is not a
  // valid pane tree.
  if (children.length === 1) return children[0];
  // Only persist sizes that still match the child count (a split/close can
  // leave a stale-length array, and pruning above invalidates the ratios);
  // a mismatch restores as an equal split.
  const pruned = children.length !== node.children.length;
  return {
    kind: "split",
    dir: node.dir,
    children,
    ...(!pruned && node.sizes && node.sizes.length === children.length
      ? { sizes: node.sizes }
      : {}),
  };
}

/**
 * True for exactly the tabs `tabToSaved` emits. The session-only kinds
 * (ai-diff, git-diff, ext, scm) are never persisted - only pane tabs are.
 * A pane tab holding an extension-panel leaf is skipped whole, and a pane tab
 * whose every leaf is an ad-hoc remote editor has nothing left to save.
 *
 * Single source of truth for "which tabs are saved", shared by `tabToSaved`
 * and `savedActiveTabIndex` so the saved active-index can't drift from the
 * saved array. It previously counted every pane tab, including the
 * extension-panel ones `tabToSaved` drops, which mis-focused the restored
 * workspace whenever such a tab preceded the active one.
 */
function isPersistedTab(tab: Tab): tab is PaneTab {
  if (tab.kind !== "pane") return false;
  const all = leaves(tab.paneTree);
  // Extension-panel leaves are session-only. If a pane tab contains one, skip
  // persisting the whole tab so the serializer never hits a non-saveable leaf.
  // (MVP: a terminal split next to an extension panel isn't restored either;
  // acceptable until extension-panel leaves round-trip.)
  if (all.some((l) => l.leafKind === "extension-panel")) return false;
  return all.some((l) => !isUnrestorableEditorLeaf(l));
}

function tabToSaved(tab: Tab): SavedTab | null {
  if (!isPersistedTab(tab)) return null;
  const paneTree = nodeToSaved(tab.paneTree);
  // isPersistedTab already proved at least one leaf survives; this narrows.
  if (paneTree === null) return null;
  // Index within the leaves that were actually SAVED, not the live ones: a
  // pruned remote editor shifts every later leaf. A dropped active leaf lands
  // on the first survivor via the Math.max below.
  const kept = leaves(tab.paneTree).filter((l) => !isUnrestorableEditorLeaf(l));
  const idx = kept.findIndex((l) => l.id === tab.activeLeafId);
  return {
    kind: "pane",
    title: tab.title,
    paneTree,
    activeLeafIndex: Math.max(0, idx),
    // Written only when true, so an unpinned tab does not grow every saved
    // workspace by a redundant flag.
    ...(tab.pinned ? { pinned: true } : {}),
  };
}

/**
 * Index of the active tab within the serialized tab list (`serializeTabs`),
 * used to restore focus. Counts only persisted tabs preceding the active one,
 * so it stays aligned with the saved array even when a session-only
 * (ai-diff / git-diff / scm / ext) tab sits before the active tab. The former
 * per-call loops skipped only `ai-diff`, which mis-focused the restored
 * workspace whenever another session-only kind preceded the active tab.
 */
export function savedActiveTabIndex(tabs: Tab[], activeId: number): number {
  let idx = 0;
  for (const t of tabs) {
    if (t.id === activeId) break;
    if (isPersistedTab(t)) idx++;
  }
  return idx;
}

export function serializeTabs(tabs: Tab[]): SavedTab[] {
  const out: SavedTab[] = [];
  for (const t of tabs) {
    const s = tabToSaved(t);
    if (s !== null) out.push(s);
  }
  return out;
}

// saved -> live

function savedToNode(node: SavedPaneNode, allocId: () => number, outLeafIds: number[]): PaneNode {
  if (node.kind === "leaf") {
    const id = allocId();
    outLeafIds.push(id);
    if (node.leafKind === "terminal") {
      return {
        kind: "leaf",
        id,
        leafKind: "terminal",
        cwd: node.cwd,
        sshConnectionId: node.sshConnectionId,
        terminalOrdinal: node.terminalOrdinal,
        ...(node.private ? { private: true } : {}),
        ...(node.terminalThemeId ? { terminalThemeId: node.terminalThemeId } : {}),
        // `savedPtyId` is the signal for `useTerminalSession.attachSession`
        // to attempt `reattachPty` before falling back to `openPty`. The
        // hot `ptyId` field is populated by the session itself on attach.
        ...(node.ptyId ? { savedPtyId: node.ptyId } : {}),
        // Pre-activate the detector for a still-running agent on reattach.
        ...(node.activeTool ? { activeTool: node.activeTool } : {}),
        ...(node.customTitle ? { customTitle: node.customTitle } : {}),
      };
    }
    if (node.leafKind === "editor") {
      return {
        kind: "leaf",
        id,
        leafKind: "editor",
        path: node.path,
        dirty: false,
        preview: false,
        // Remote leaves come back bound to the saved PROFILE only. No
        // `sshSessionId`: the pane resolves one from whichever session for this
        // connection is live, and shows a reconnect prompt until then, so an
        // unbound remote path can never reach the local filesystem.
        ...(node.sshConnectionId ? { sshConnectionId: node.sshConnectionId } : {}),
        ...(node.sshHostLabel ? { sshHostLabel: node.sshHostLabel } : {}),
        ...(node.private ? { private: true } : {}),
        ...(node.customTitle ? { customTitle: node.customTitle } : {}),
      };
    }
    if (node.leafKind === "board") {
      return {
        kind: "leaf",
        id,
        leafKind: "board",
        ...(node.private ? { private: true } : {}),
        ...(node.customTitle ? { customTitle: node.customTitle } : {}),
      };
    }
    return {
      kind: "leaf",
      id,
      leafKind: "browser",
      url: node.url,
      ...(node.browserOrdinal != null ? { browserOrdinal: node.browserOrdinal } : {}),
      ...(node.private ? { private: true } : {}),
      ...(node.customTitle ? { customTitle: node.customTitle } : {}),
    };
  }
  const children = node.children.map((c) => savedToNode(c, allocId, outLeafIds));
  return {
    kind: "split",
    id: allocId(),
    dir: node.dir,
    children,
    // Restore divider positions only when the saved sizes still line up with
    // the child count; otherwise fall back to an equal split.
    ...(node.sizes && node.sizes.length === children.length ? { sizes: node.sizes } : {}),
  };
}

export function savedToTab(saved: SavedTab, allocId: () => number): Tab {
  if (saved.kind === "preview") {
    // Legacy standalone browser ("preview") tab -> migrate to a pane tab whose
    // tree is a single browser leaf, matching the unified model.
    const tabId = allocId();
    const leafId = allocId();
    const leaf: PaneNode = { kind: "leaf", id: leafId, leafKind: "browser", url: saved.url };
    return {
      id: tabId,
      kind: "pane",
      title: saved.title ?? saved.url,
      paneTree: leaf,
      activeLeafId: leafId,
    };
  }
  const id = allocId();
  const leafIds: number[] = [];
  const paneTree = savedToNode(saved.paneTree, allocId, leafIds);
  const activeLeafId =
    leafIds[Math.min(Math.max(0, saved.activeLeafIndex), leafIds.length - 1)] ?? leafIds[0];
  const tab: Tab = {
    id,
    kind: "pane",
    title: saved.title ?? "",
    paneTree,
    activeLeafId,
    ...(saved.pinned ? { pinned: true } : {}),
  };
  return tab;
}

/** Default pane tab with one terminal leaf. `terminalOrdinal` is omitted; `useTabs.replaceAllTabs` backfills it. */
export function defaultTabForEmptyWorkspace(allocId: () => number, cwd: string | undefined): Tab {
  const leafId = allocId();
  return {
    id: allocId(),
    kind: "pane",
    title: "shell",
    paneTree: {
      kind: "leaf",
      id: leafId,
      leafKind: "terminal",
      cwd,
    },
    activeLeafId: leafId,
  };
}
