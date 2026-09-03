import { basename } from "@/lib/path";
import {
  findLeaf,
  hasLeaf,
  leaves,
  type PaneLeaf,
  type PaneNode,
} from "@/modules/terminal/lib/panes";
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
  aiTitles?: ReadonlyMap<string, string>,
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
  const label = leafLabel(leaf, sshHosts, fallbackCwd, aiTitles);
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
  /** Chat titles by session id, for `ai` leaves. See `useAiSessionTitles`. */
  aiTitles?: ReadonlyMap<string, string>,
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
  if (leaf.leafKind === "extension-panel") return leaf.title || "panel";
  if (leaf.leafKind === "board") return "Board";
  if (leaf.leafKind === "scm") return "Source Control";
  // Resolved from `aiTitles`, exactly as an SSH leaf resolves its host name: the
  // chat's title is auto-derived from its first message, so stamping it on the
  // leaf would leave a pane opened on a fresh chat saying "New chat" forever.
  // The map is passed IN rather than read from the chat store here, because
  // this module is imported by the node-run verify scripts and must not drag
  // the AI stack (and xterm behind it) into them.
  if (leaf.leafKind === "ai") return aiTitles?.get(leaf.sessionId)?.trim() || "AI";
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

/**
 * Where a chat is already open, or null. THE rule behind "a chat may appear in
 * exactly one pane": two `useChat` views over one Chat are the same
 * conversation rendered twice sharing one composer, not two chats.
 *
 * Pure and here rather than inline in `openAiPane` so it is testable, and so
 * the canvas menu can ask the same question it enforces.
 */
export function findAiPane(
  tabs: Tab[],
  sessionId: string,
): { tabId: number; leafId: number } | null {
  for (const t of tabs) {
    if (t.kind !== "pane") continue;
    for (const l of leaves(t.paneTree)) {
      if (l.leafKind === "ai" && l.sessionId === sessionId) return { tabId: t.id, leafId: l.id };
    }
  }
  return null;
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

/**
 * Apply `update` to the pane tree of whichever tab holds `leafId`, and re-sync
 * that tab's mirror. Every other tab, and a tab whose tree is unchanged by
 * `update`, comes back by reference so callers can bail on a no-op. Shared
 * shape behind `renameLeaf`, `setLeafTerminalTheme`, `setLeafPtyId`,
 * `reorderLeafInGroup` (useTabs.ts) and `setBrowserLeafUrl`/
 * `setBrowserLeafTitle` (useAuxTabs.ts) - each just picks which `panes.ts`
 * mutator `update` calls.
 */
export function updateLeafTree(
  tabs: Tab[],
  leafId: number,
  update: (tree: PaneNode) => PaneNode,
): Tab[] {
  return tabs.map((t) => {
    if (t.kind !== "pane") return t;
    if (!hasLeaf(t.paneTree, leafId)) return t;
    const paneTree = update(t.paneTree);
    if (paneTree === t.paneTree) return t;
    return syncPaneMirror({ ...t, paneTree });
  });
}

/** Helpers for discriminating on the active leaf kind. */
export function activeLeaf(tab: Tab): PaneLeaf | null {
  if (tab.kind !== "pane") return null;
  return findLeaf(tab.paneTree, tab.activeLeafId);
}

export function activeLeafKind(tab: Tab): "terminal" | "editor" | null {
  const leaf = activeLeaf(tab);
  if (!leaf) return null;
  // Extension-panel, board, scm and ai leaves aren't one of the
  // terminal/editor kinds the chrome derivations branch on; report null so
  // callers fall to their defaults instead of every one special-casing them.
  return leaf.leafKind === "terminal" || leaf.leafKind === "editor" ? leaf.leafKind : null;
}

export function isTerminalLikeTab(tab: Tab): boolean {
  return tab.kind === "pane" && activeLeafKind(tab) === "terminal";
}

export function isEditorLikeTab(tab: Tab): boolean {
  return tab.kind === "pane" && activeLeafKind(tab) === "editor";
}

// The pinned-first invariant is shared with the Workspaces panel, so it lives
// in `@/lib/pinned`. Re-exported here because the tab code reads more
// naturally importing it alongside the other tab helpers.
export { sortPinnedFirst } from "@/lib/pinned";

/**
 * Which tab to activate once the ACTIVE one closes.
 *
 * NOT the left neighbour, which is what both close paths did. Opening a file
 * APPENDS a tab and activates it, so its left neighbour is simply whatever
 * happened to be last in the strip - a tab the user never chose and usually was
 * not working in. Closing the editor therefore threw them to the far end of the
 * strip rather than back where they came from, and the more tabs they had open
 * the further away they landed.
 *
 * Most-recently-used instead, which is the answer every editor gives: go back to
 * the tab that was active before this one. `mru` is newest-first and may name
 * tabs that have since been closed (or belong to another workspace), so
 * membership in `remaining` is what qualifies an entry, not its presence in the
 * stack.
 *
 * The neighbour survives as the fallback, for when there is no history to go
 * back to at all: a freshly restored workspace, or a stack whose every entry has
 * already been closed.
 *
 * @param mru        tab ids, most recently active first
 * @param closedId   the tab being closed
 * @param remaining  ids still open AFTER the close, in strip order
 * @param idx        index the closed tab had, for the neighbour fallback
 */
export function nextActiveAfterClose(
  mru: readonly number[],
  closedId: number,
  remaining: readonly number[],
  idx: number,
): number {
  const back = mru.find((id) => id !== closedId && remaining.includes(id));
  return back ?? remaining[Math.max(0, idx - 1)];
}
