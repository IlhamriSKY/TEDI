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

/** Every saved leaf kind may carry a canvas rectangle, so it is appended once
 *  here rather than repeated in all six branches of `leafKindToSaved`. */
type SavedLeaf = Extract<SavedPaneNode, { kind: "leaf" }>;

function leafToSaved(leaf: PaneLeaf): SavedLeaf {
  const saved = leafKindToSaved(leaf);
  return leaf.canvasRect ? { ...saved, canvasRect: leaf.canvasRect } : saved;
}

function leafKindToSaved(leaf: PaneLeaf): SavedLeaf {
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
    // Round-trips on its ids: `ExtensionPanelMount` waits for the renderer and
    // paints once the extension activates. Dropping these used to take the
    // whole pane tab with them, which a canvas holding a database or API
    // window cannot afford.
    return {
      kind: "leaf",
      leafKind: "extension-panel",
      extensionId: leaf.extensionId,
      panelId: leaf.panelId,
      ...(leaf.reuseKey ? { reuseKey: leaf.reuseKey } : {}),
      ...(leaf.title ? { title: leaf.title } : {}),
      ...(leaf.icon ? { icon: leaf.icon } : {}),
      ...(leaf.private ? { private: true } : {}),
      ...(leaf.customTitle ? { customTitle: leaf.customTitle } : {}),
    };
  }
  if (leaf.leafKind === "ai") {
    return {
      kind: "leaf",
      leafKind: "ai",
      sessionId: leaf.sessionId,
      ...(leaf.private ? { private: true } : {}),
      ...(leaf.customTitle ? { customTitle: leaf.customTitle } : {}),
    };
  }
  if (leaf.leafKind === "scm") {
    // Stateless like the board: the panel follows the live workspace root.
    return {
      kind: "leaf",
      leafKind: "scm",
      ...(leaf.private ? { private: true } : {}),
      ...(leaf.customTitle ? { customTitle: leaf.customTitle } : {}),
    };
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
  // Exhaustive: `LeafState` has no member left after `ai`. Assigning to `never`
  // makes a newly added leaf kind a compile error here rather than a leaf that
  // silently fails to persist.
  const unhandled: never = leaf;
  return unhandled;
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
  return leaves(tab.paneTree).some((l) => !isUnrestorableEditorLeaf(l));
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

/**
 * Rebuild a pane subtree, pruning leaves that no longer restore.
 *
 * The mirror of `nodeToSaved`, and it prunes for the same reason, one direction
 * over: a saved browser leaf has no live kind to become. `outLeafIds` collects
 * only the leaves that SURVIVED, which is what keeps `activeLeafIndex` pointing
 * at the leaf it named - counting dropped ones would shift the focus onto a
 * neighbour on every restore.
 *
 * Returns null when nothing in this subtree survives.
 */
function savedToNode(
  node: SavedPaneNode,
  allocId: () => number,
  outLeafIds: number[],
): PaneNode | null {
  if (node.kind === "leaf") {
    const id = allocId();
    const leaf = savedToLeaf(node, id);
    if (leaf === null) return null;
    outLeafIds.push(id);
    // Appended once, like `leafToSaved` does going the other way.
    return node.canvasRect ? { ...leaf, canvasRect: node.canvasRect } : leaf;
  }
  const children: PaneNode[] = [];
  for (const c of node.children) {
    const restored = savedToNode(c, allocId, outLeafIds);
    if (restored !== null) children.push(restored);
  }
  if (children.length === 0) return null;
  // A lone survivor collapses into its parent, exactly as on the save side: a
  // one-child split is not a valid pane tree.
  if (children.length === 1) return children[0];
  return {
    kind: "split",
    id: allocId(),
    dir: node.dir,
    children,
    // Restore divider positions only when the saved sizes still line up with
    // the child count; otherwise fall back to an equal split. Pruning is one
    // more way they can stop lining up.
    ...(node.sizes && node.sizes.length === children.length ? { sizes: node.sizes } : {}),
  };
}

function savedToLeaf(node: SavedLeaf, id: number): PaneLeaf | null {
  {
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
    if (node.leafKind === "ai") {
      return {
        kind: "leaf",
        id,
        leafKind: "ai",
        sessionId: node.sessionId,
        ...(node.private ? { private: true } : {}),
        ...(node.customTitle ? { customTitle: node.customTitle } : {}),
      };
    }
    if (node.leafKind === "scm") {
      return {
        kind: "leaf",
        id,
        leafKind: "scm",
        ...(node.private ? { private: true } : {}),
        ...(node.customTitle ? { customTitle: node.customTitle } : {}),
      };
    }
    if (node.leafKind === "extension-panel") {
      return {
        kind: "leaf",
        id,
        leafKind: "extension-panel",
        extensionId: node.extensionId,
        panelId: node.panelId,
        ...(node.reuseKey ? { reuseKey: node.reuseKey } : {}),
        ...(node.title ? { title: node.title } : {}),
        ...(node.icon ? { icon: node.icon } : {}),
        ...(node.private ? { private: true } : {}),
        ...(node.customTitle ? { customTitle: node.customTitle } : {}),
      };
    }
    // A saved `browser` leaf restores as NOTHING: there is no such live leaf
    // kind, and inventing one - a blank terminal, an empty board - would put a
    // surface the user never asked for in its place. The saved TYPE still has
    // the member because workspace files in the wild contain it; this is where
    // those stop.
    return null;
  }
}

/**
 * Rebuild one saved tab, or null when nothing in it survives.
 *
 * Nullable because a restore can legitimately come up empty: a tab that held
 * only browser leaves has nothing left now that the browser is an extension.
 * The alternative - returning a tab with a fabricated leaf - would put a shell
 * or an empty board where the user left a page. Callers drop the nulls;
 * `restoreTabs` does it for them.
 */
export function savedToTab(saved: SavedTab, allocId: () => number): Tab | null {
  // The legacy standalone browser ("preview") tab was a browser and nothing
  // else, so there is no longer anything to migrate it INTO. It is dropped
  // whole rather than restored as an empty pane.
  if (saved.kind === "preview") return null;
  const id = allocId();
  const leafIds: number[] = [];
  const paneTree = savedToNode(saved.paneTree, allocId, leafIds);
  if (paneTree === null) return null;
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

/** Restore a workspace's tabs, dropping the ones that no longer come back.
 *  Every caller wanted the same `map` + filter; having it once means a new
 *  droppable kind cannot be handled in three places and missed in a fourth. */
export function restoreTabs(saved: SavedTab[], allocId: () => number): Tab[] {
  const out: Tab[] = [];
  for (const s of saved) {
    const tab = savedToTab(s, allocId);
    if (tab !== null) out.push(tab);
  }
  return out;
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
