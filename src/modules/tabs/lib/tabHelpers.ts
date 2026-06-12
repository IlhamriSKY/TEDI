import { basename } from "@/lib/path";
import { findLeaf, type PaneLeaf } from "@/modules/terminal/lib/panes";
import { type PaneTab, type Tab } from "./tabTypes";

export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url || "browser";
  }
}

/** Derive a tab title from its active leaf. */
function titleFromLeaf(leaf: PaneLeaf): string {
  if (leaf.leafKind === "editor") return basename(leaf.path);
  if (leaf.leafKind === "browser") return leaf.title || titleFromUrl(leaf.url);
  // SSH leaves get a real title via updateTab after newSshTab. This is the interim fallback.
  if (leaf.sshConnectionId) return "ssh";
  // Terminal: cwd basename, falling back to "shell".
  if (leaf.cwd) {
    const b = basename(leaf.cwd);
    if (b) return b;
  }
  return "shell";
}

/** Recompute the top-level mirrors from the active leaf. */
export function syncPaneMirror(tab: PaneTab): PaneTab {
  const leaf = findLeaf(tab.paneTree, tab.activeLeafId);
  if (!leaf) return tab;
  const next: PaneTab = {
    ...tab,
    title: titleFromLeaf(leaf),
  };
  if (leaf.leafKind === "terminal") {
    next.cwd = leaf.cwd;
    delete next.path;
    delete next.dirty;
    delete next.preview;
  } else if (leaf.leafKind === "editor") {
    delete next.cwd;
    next.path = leaf.path;
    next.dirty = leaf.dirty;
    next.preview = leaf.preview;
  } else {
    // preview leaf: no terminal/editor mirrors.
    delete next.cwd;
    delete next.path;
    delete next.dirty;
    delete next.preview;
  }
  return next;
}

/** Helpers for discriminating on the active leaf kind. */
export function activeLeaf(tab: Tab): PaneLeaf | null {
  if (tab.kind !== "pane") return null;
  return findLeaf(tab.paneTree, tab.activeLeafId);
}

export function activeLeafKind(tab: Tab): "terminal" | "editor" | "browser" | null {
  const leaf = activeLeaf(tab);
  return leaf ? leaf.leafKind : null;
}

export function isTerminalLikeTab(tab: Tab): boolean {
  return tab.kind === "pane" && activeLeafKind(tab) === "terminal";
}

export function isEditorLikeTab(tab: Tab): boolean {
  return tab.kind === "pane" && activeLeafKind(tab) === "editor";
}

export function isPreviewLikeTab(tab: Tab): boolean {
  return tab.kind === "pane" && activeLeafKind(tab) === "browser";
}
