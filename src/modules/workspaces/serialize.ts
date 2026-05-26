import type { PaneTab, Tab } from "@/modules/tabs";
import type { PaneLeaf, PaneNode } from "@/modules/terminal/lib/panes";
import { leaves } from "@/modules/terminal/lib/panes";
import type { SavedPaneNode, SavedTab } from "./store";

// live -> saved

function leafToSaved(leaf: PaneLeaf): SavedPaneNode {
  if (leaf.leafKind === "terminal") {
    return {
      kind: "leaf",
      leafKind: "terminal",
      cwd: leaf.cwd,
      sshConnectionId: leaf.sshConnectionId,
      terminalOrdinal: leaf.terminalOrdinal,
      ...(leaf.private ? { private: true } : {}),
      // Only local PTYs use the daemon backend; SSH leaves carry their
      // remote session id separately and aren't restored via pty_attach.
      ...(leaf.ptyId && !leaf.sshConnectionId ? { ptyId: leaf.ptyId } : {}),
    };
  }
  return {
    kind: "leaf",
    leafKind: "editor",
    path: leaf.path,
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

function tabToSaved(tab: Tab): SavedTab | null {
  if (tab.kind === "preview") {
    return { kind: "preview", url: tab.url, title: tab.title };
  }
  if (tab.kind === "ai-diff") return null; // session-only
  if (tab.kind === "git-diff") return null; // session-only
  if (tab.kind === "ext") return null; // session-only — extension re-opens on demand
  const all = leaves(tab.paneTree);
  const idx = all.findIndex((l) => l.id === tab.activeLeafId);
  return {
    kind: "pane",
    title: tab.title,
    paneTree: nodeToSaved(tab.paneTree),
    activeLeafIndex: Math.max(0, idx),
  };
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
        // `savedPtyId` is the signal for `useTerminalSession.attachSession`
        // to attempt `reattachPty` before falling back to `openPty`. The
        // hot `ptyId` field is populated by the session itself on attach.
        ...(node.ptyId ? { savedPtyId: node.ptyId } : {}),
      };
    }
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
    kind: "split",
    id: allocId(),
    dir: node.dir,
    children: node.children.map((c) => savedToNode(c, allocId, outLeafIds)),
  };
}

export function savedToTab(saved: SavedTab, allocId: () => number): Tab {
  if (saved.kind === "preview") {
    const id = allocId();
    return {
      id,
      kind: "preview",
      title: saved.title ?? saved.url,
      url: saved.url,
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
