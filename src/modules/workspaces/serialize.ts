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
      ...(leaf.terminalThemeId ? { terminalThemeId: leaf.terminalThemeId } : {}),
      ...(title ? { title } : {}),
      // Only local PTYs use the daemon backend; SSH leaves carry their
      // remote session id separately and aren't restored via pty_attach.
      ...(leaf.ptyId && !leaf.sshConnectionId ? { ptyId: leaf.ptyId } : {}),
    };
  }
  if (leaf.leafKind === "editor") {
    return {
      kind: "leaf",
      leafKind: "editor",
      path: leaf.path,
      ...(leaf.private ? { private: true } : {}),
    };
  }
  if (leaf.leafKind === "extension-panel") {
    // Session-only: `tabToSaved` skips any pane tab containing an
    // extension-panel leaf, so this is never reached. Guard for exhaustiveness.
    throw new Error("extension-panel leaves are not serialized");
  }
  return {
    kind: "leaf",
    leafKind: "browser",
    url: leaf.url,
    ...(leaf.browserOrdinal != null ? { browserOrdinal: leaf.browserOrdinal } : {}),
    ...(leaf.private ? { private: true } : {}),
  };
}

function nodeToSaved(node: PaneNode): SavedPaneNode {
  if (node.kind === "leaf") return leafToSaved(node);
  return {
    kind: "split",
    dir: node.dir,
    children: node.children.map(nodeToSaved),
  };
}

/**
 * True for tabs that survive serialization. The session-only kinds (ai-diff,
 * git-diff, ext, scm) are never persisted - only pane tabs are. Single source
 * of truth for "which tabs are saved", shared by `tabToSaved` and
 * `savedActiveTabIndex` so the saved active-index can't drift from the saved
 * array.
 */
function isPersistedTab(tab: Tab): tab is PaneTab {
  return tab.kind === "pane";
}

function tabToSaved(tab: Tab): SavedTab | null {
  // ai-diff / git-diff / ext / scm are session-only (re-opened on demand).
  if (!isPersistedTab(tab)) return null;
  // Extension-panel leaves are session-only too. If a pane tab contains one,
  // skip persisting the whole tab so the serializer never hits a non-saveable
  // leaf. (MVP: a terminal split next to an extension panel isn't restored
  // either; acceptable until extension-panel leaves round-trip.)
  if (leaves(tab.paneTree).some((l) => l.leafKind === "extension-panel")) return null;
  const all = leaves(tab.paneTree);
  const idx = all.findIndex((l) => l.id === tab.activeLeafId);
  return {
    kind: "pane",
    title: tab.title,
    paneTree: nodeToSaved(tab.paneTree),
    activeLeafIndex: Math.max(0, idx),
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
        ...(node.private ? { private: true } : {}),
      };
    }
    return {
      kind: "leaf",
      id,
      leafKind: "browser",
      url: node.url,
      ...(node.browserOrdinal != null ? { browserOrdinal: node.browserOrdinal } : {}),
      ...(node.private ? { private: true } : {}),
    };
  }
  return {
    kind: "split",
    id: allocId(),
    dir: node.dir,
    children: node.children.map((c) => savedToNode(c, allocId, outLeafIds)),
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
  const tab: PaneTab = {
    id,
    kind: "pane",
    title: saved.title ?? "",
    paneTree,
    activeLeafId,
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
