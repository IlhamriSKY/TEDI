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

/** What an extension puts between its own name and the detail it is showing:
 *  "SQL Explorer · sakila", "API Client · checkout". */
const EXT_TITLE_SEP = "·";

/**
 * The KIND tag that stays in front of a tab's name, or null when the kind needs
 * no word (a terminal, an editor, a browser - their names already read as what
 * they are).
 *
 * Renaming replaces the NAME, never this. An SSH pane called "prod" is still
 * `ssh:prod`, and a renamed SQL Explorer / API Client pane still says which tool
 * it is, in the strip AND in the Workspaces panel, where the icon alone was the
 * only clue left once the derived title was gone.
 *
 * The extension tag is the first word of the extension's own title, because core
 * must not carry a table of which extensions exist: "SQL Explorer · sakila"
 * gives `SQL`, "API Client · checkout" gives `API`.
 */
export function leafKindTag(leaf: PaneLeaf): string | null {
  if (leaf.leafKind === "terminal" && leaf.sshConnectionId) return "ssh";
  if (leaf.leafKind === "extension-panel") {
    const head = (leaf.title ?? "").split(EXT_TITLE_SEP)[0].trim().split(/\s+/)[0];
    return head || null;
  }
  return null;
}

/**
 * What the inline rename field starts with: the current name WITHOUT the kind
 * tag. Both rename surfaces seeded their input with the full label, so keeping
 * an SSH tab's name and pressing Enter stored "ssh:prod" as the name and the
 * tab read `ssh:ssh:prod`.
 */
export function leafRenameSeed(
  leaf: PaneLeaf,
  sshHosts?: Map<string, SshConnection>,
  fallbackCwd?: string,
): string {
  if (leaf.customTitle) return leaf.customTitle;
  if (leaf.leafKind === "extension-panel") {
    // The extension's title is "<its name> · <detail>". Only the detail is a
    // name; the head is the tag we re-apply.
    const t = (leaf.title ?? "").trim();
    const i = t.indexOf(EXT_TITLE_SEP);
    return i >= 0 ? t.slice(i + EXT_TITLE_SEP.length).trim() : "";
  }
  const tag = leafKindTag(leaf);
  const label = leafLabel(leaf, sshHosts, fallbackCwd);
  if (!tag) return label;
  // A leaf whose connection was deleted reads as a bare "ssh": that is all tag
  // and no name, so seed it empty rather than handing back the tag to be
  // committed as one ("ssh" -> "ssh:ssh").
  if (label === tag) return "";
  return label.startsWith(`${tag}:`) ? label.slice(tag.length + 1) : label;
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
  // so nothing below may override it - except the KIND tag, which is not a
  // name and is not the user's to drop (see leafKindTag).
  if (leaf.customTitle) {
    const tag = leafKindTag(leaf);
    return tag ? `${tag}:${leaf.customTitle}` : leaf.customTitle;
  }
  if (leaf.leafKind === "editor") return basename(leaf.path);
  if (leaf.leafKind === "browser") return leaf.title || titleFromUrl(leaf.url);
  if (leaf.leafKind === "extension-panel") return leaf.title || "panel";
  if (leaf.leafKind === "board") return "Board";
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
  // Extension-panel and board leaves aren't one of the terminal/editor/browser
  // kinds the chrome derivations branch on; report null so callers fall to
  // their defaults instead of every one having to special-case them.
  return leaf.leafKind === "extension-panel" || leaf.leafKind === "board" ? null : leaf.leafKind;
}

export function isTerminalLikeTab(tab: Tab): boolean {
  return tab.kind === "pane" && activeLeafKind(tab) === "terminal";
}

export function isEditorLikeTab(tab: Tab): boolean {
  return tab.kind === "pane" && activeLeafKind(tab) === "editor";
}
