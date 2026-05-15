import type { PaneTab, Tab } from "@/modules/tabs";
import type {
  PaneLeaf,
  PaneNode,
} from "@/modules/terminal/lib/panes";
import { leaves } from "@/modules/terminal/lib/panes";
import type { SavedPaneNode, SavedTab } from "./store";

// -------- live → saved --------

function leafToSaved(leaf: PaneLeaf): SavedPaneNode {
  if (leaf.leafKind === "terminal") {
    return {
      kind: "leaf",
      leafKind: "terminal",
      cwd: leaf.cwd,
      sshConnectionId: leaf.sshConnectionId,
    };
  }
  return { kind: "leaf", leafKind: "editor", path: leaf.path };
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

// -------- saved → live --------

function savedToNode(
  node: SavedPaneNode,
  allocId: () => number,
  outLeafIds: number[],
): PaneNode {
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
      };
    }
    return {
      kind: "leaf",
      id,
      leafKind: "editor",
      path: node.path,
      dirty: false,
      preview: false,
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
    leafIds[
      Math.min(Math.max(0, saved.activeLeafIndex), leafIds.length - 1)
    ] ?? leafIds[0];
  const tab: PaneTab = {
    id,
    kind: "pane",
    title: saved.title ?? "",
    paneTree,
    activeLeafId,
  };
  return tab;
}

/** Returns a default-seeded pane tab (one terminal leaf) for empty workspaces. */
export function defaultTabForEmptyWorkspace(
  allocId: () => number,
  cwd: string | undefined,
): Tab {
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
