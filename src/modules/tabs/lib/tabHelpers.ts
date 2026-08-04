import { basename } from "@/lib/path";
import { findLeaf, type PaneLeaf } from "@/modules/terminal/lib/panes";
import { type SshConnection } from "@/modules/ssh/connections";
import { type PaneTab, type Tab } from "./tabTypes";

export function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url || "browser";
  }
}

/**
 * THE display label for a pane leaf. Single source for every surface that names
 * one: the tab strip (`buildEntries`), the pane header, `tab.title` (which the
 * "Join Group" submenu and friends read), and the Workspaces panel's terminal
 * list. They all have to agree, or a renamed tab keeps showing its old folder
 * name somewhere.
 *
 * `sshHosts` resolves an SSH leaf to `ssh:<name>`; a caller with no connection
 * map (`tab.title`, which is recomputed before the map is even loaded) gets the
 * bare "ssh" interim label. `fallbackCwd` is the owning tab's cwd, used only
 * when the leaf itself carries none.
 */
export function leafLabel(
  leaf: PaneLeaf,
  sshHosts?: Map<string, SshConnection>,
  fallbackCwd?: string,
): string {
  // A user-set name wins over every derived one. Renaming exists precisely
  // because "the folder this opened in" is often not what the tab should say,
  // so nothing below may override it.
  if (leaf.customTitle) return leaf.customTitle;
  if (leaf.leafKind === "editor") return basename(leaf.path);
  if (leaf.leafKind === "browser") return leaf.title || titleFromUrl(leaf.url);
  if (leaf.leafKind === "extension-panel") return leaf.title || "panel";
  // SSH leaves: show "ssh:<name>" when the saved connection has a name, else
  // fall back to the host/IP. Bare "ssh" if the connection was deleted.
  if (leaf.sshConnectionId) {
    const conn = sshHosts?.get(leaf.sshConnectionId);
    if (!conn) return "ssh";
    return `ssh:${conn.name.trim() || conn.host}`;
  }
  for (const cwd of [leaf.cwd, fallbackCwd]) {
    const b = cwd ? basename(cwd) : "";
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
    title: leafLabel(leaf),
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
  if (!leaf) return null;
  // Extension-panel leaves aren't one of the terminal/editor/browser kinds the
  // chrome derivations branch on; report null so callers fall to their
  // defaults instead of every one having to special-case it.
  return leaf.leafKind === "extension-panel" ? null : leaf.leafKind;
}

export function isTerminalLikeTab(tab: Tab): boolean {
  return tab.kind === "pane" && activeLeafKind(tab) === "terminal";
}

export function isEditorLikeTab(tab: Tab): boolean {
  return tab.kind === "pane" && activeLeafKind(tab) === "editor";
}
