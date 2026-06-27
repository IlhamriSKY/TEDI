// Unified pane tree. Leaves are terminal, editor, or preview (an embedded
// native browser). `kind: "leaf"` stays for back-compat; the discriminator is
// `leafKind`.

import type { ExtensionTabState } from "@/modules/tabs/lib/tabTypes";

export type PaneId = number;

export type SplitDir = "row" | "col";

/** Drop edge for drag-and-drop pane moves. */
export type PaneEdge = "left" | "right" | "top" | "bottom";

export type TerminalLeafState = {
  leafKind: "terminal";
  cwd?: string;
  /**
   * Saved SSH connection id. When set, connects to that host instead of
   * spawning a local PTY; `cwd` is ignored.
   */
  sshConnectionId?: string;
  /**
   * FIFO creation index. 1-based, shown on the tab chip and surfaced to the
   * AI in `<env>`. Set at creation, preserved across split/drag/restart.
   * Optional for back-compat with older saved state.
   */
  terminalOrdinal?: number;
  /**
   * Privacy flag. Per-leaf (not per pane-tab) so a split group can mix
   * private and public terminals. When true the AI subsystem never sees
   * the leaf's existence, cwd, scrollback, or accepts injects/runs on it.
   */
  private?: boolean;
  /**
   * Daemon-owned PTY UUID for this leaf. Stamped onto the leaf when its
   * `useTerminalSession` Session successfully calls `openPty`/`reattachPty`
   * and the daemon returns a non-empty `sessionId`. The workspace
   * serializer persists this so the next GUI launch can ask the daemon to
   * resume the same shell via `pty_attach`. Empty/undefined means
   * "respawn fresh on restore" (no persistent backend or first run).
   */
  ptyId?: string;
  /**
   * Set by the workspace restore path (`savedToTab`) so
   * `useTerminalSession.attachSession` knows to try `reattachPty` before
   * falling back to a fresh `openPty`. Cleared once the session attaches
   * (or fails to) so a manual close-and-reopen of the tab spawns fresh.
   */
  savedPtyId?: string;
  /**
   * Per-leaf terminal theme override. Holds a `TERMINAL_PRESETS` id so this
   * pane paints its own palette regardless of the global terminal theme.
   * Undefined = follow the global terminal theme (Settings -> Terminal). Set
   * from the pane header's right-click "Terminal theme" menu and persisted by
   * the workspace serializer so it survives restart.
   */
  terminalThemeId?: string;
};

export type EditorLeafState = {
  leafKind: "editor";
  /** Absolute forward-slash path of the open file. */
  path: string;
  /** Unsaved-edits state of the CodeMirror buffer. */
  dirty: boolean;
  /** VSCode-style preview indicator (italic title). */
  preview: boolean;
  /** When set, edits a remote file via the matching russh session (SFTP). */
  sshSessionId?: number;
  /** `user@host:port` for the remote host. Only set when `sshSessionId` is set. */
  sshHostLabel?: string;
  /** Privacy flag. AI autocomplete + tools refuse on private editor leaves. */
  private?: boolean;
};

export type BrowserLeafState = {
  leafKind: "browser";
  /** Current page URL of the embedded browser. Empty = show the address bar. */
  url: string;
  /** Live `document.title` of the page, reported by the webview. Drives the
   *  tab/pane label; falls back to the URL host when empty. */
  title?: string;
  /**
   * FIFO creation index for browser leaves, 1-based. Shown on the tab chip
   * exactly like `terminalOrdinal` on terminals, with its own counter (so
   * browsers number "Browser 1, 2, 3" independently of terminals). Set at
   * creation, preserved across split/drag/move/restart. Optional for
   * back-compat with older saved state.
   */
  browserOrdinal?: number;
  /** Privacy flag, kept for uniformity with the other leaf kinds. */
  private?: boolean;
};

export type ExtensionPanelLeafState = {
  leafKind: "extension-panel";
  /** Owning extension id + the panel id registered via
   *  `ctx.registerPanelRenderer`. Together they resolve the mount function. */
  extensionId: string;
  panelId: string;
  /** Mirrors `ExtensionTab.reuseKey`; used to dedup so the same panel is
   *  never mounted twice (the SQL Explorer keeps module singletons). */
  reuseKey?: string;
  /** Cached chrome for the pane header / tab strip. The extension's renderer
   *  owns the body; these are just the label + icon hint. Updated at runtime
   *  via `ctx.tabs.setExtensionTabState({ title })`. */
  title?: string;
  icon?: string;
  /** Extension-driven lifecycle tone (connection / job state). Same palette as
   *  the SSH label + the standalone ext tab; set via
   *  `ctx.tabs.setExtensionTabState({ state })`. */
  state?: ExtensionTabState;
  /** Privacy flag kept for uniformity with the other leaf kinds. AI never
   *  reads extension panels regardless. */
  private?: boolean;
};

export type LeafState =
  | TerminalLeafState
  | EditorLeafState
  | BrowserLeafState
  | ExtensionPanelLeafState;

export type PaneLeaf = { kind: "leaf"; id: PaneId } & LeafState;

export type PaneNode =
  | PaneLeaf
  | {
      kind: "split";
      id: PaneId;
      dir: SplitDir;
      children: PaneNode[];
    };

export function isLeaf(n: PaneNode): n is PaneLeaf {
  return n.kind === "leaf";
}

export function leafIds(n: PaneNode): PaneId[] {
  if (isLeaf(n)) return [n.id];
  return n.children.flatMap(leafIds);
}

/** Direction of the split that directly contains `leafId`: `"row"` = the leaf
 *  sits beside its sibling (left/right), `"col"` = stacked (above/below). Null
 *  when the leaf is the tab's only pane, so there is no split to rotate. */
export function leafParentDir(n: PaneNode, leafId: PaneId): SplitDir | null {
  if (n.kind !== "split") return null;
  if (n.children.some((c) => c.kind === "leaf" && c.id === leafId)) return n.dir;
  for (const c of n.children) {
    const d = leafParentDir(c, leafId);
    if (d) return d;
  }
  return null;
}

export function leaves(n: PaneNode): PaneLeaf[] {
  if (isLeaf(n)) return [n];
  return n.children.flatMap(leaves);
}

export function findLeaf(n: PaneNode, id: PaneId): PaneLeaf | null {
  if (isLeaf(n)) return n.id === id ? n : null;
  for (const c of n.children) {
    const r = findLeaf(c, id);
    if (r) return r;
  }
  return null;
}

export function findLeafCwd(n: PaneNode, id: PaneId): string | undefined {
  const leaf = findLeaf(n, id);
  return leaf && leaf.leafKind === "terminal" ? leaf.cwd : undefined;
}

export function hasLeaf(tree: PaneNode, id: PaneId): boolean {
  return findLeaf(tree, id) !== null;
}

/** Update a terminal leaf's cwd. No-op for editor leaves or mismatched ids. */
export function setLeafCwd(n: PaneNode, id: PaneId, cwd: string): PaneNode {
  if (isLeaf(n)) {
    if (n.id !== id || n.leafKind !== "terminal") return n;
    return { ...n, cwd };
  }
  return { ...n, children: n.children.map((c) => setLeafCwd(c, id, cwd)) };
}

/**
 * Stamp a daemon-side PTY UUID onto a terminal leaf. Also clears
 * `savedPtyId` so any later retry/respawn does not redundantly try to
 * reattach the same uuid (which would race the daemon killing the
 * original). No-op for editor leaves or mismatched ids.
 */
export function setLeafPtyId(n: PaneNode, id: PaneId, ptyId: string): PaneNode {
  if (isLeaf(n)) {
    if (n.id !== id || n.leafKind !== "terminal") return n;
    if (n.ptyId === ptyId && n.savedPtyId === undefined) return n;
    // Narrow to the terminal branch by leafKind before reassembling so
    // TypeScript keeps the PaneLeaf union tight (editor branch has no
    // ptyId / savedPtyId fields to drop).
    const { savedPtyId: _drop, ...rest } = n;
    const updated: PaneLeaf = { ...rest, leafKind: "terminal", ptyId };
    return updated;
  }
  return { ...n, children: n.children.map((c) => setLeafPtyId(c, id, ptyId)) };
}

/**
 * Set or clear the per-leaf privacy flag. Pass `undefined` (or false) to
 * clear and remove the optional field entirely. Works on both terminal
 * and editor leaves.
 */
export function setLeafPrivate(n: PaneNode, id: PaneId, value: boolean): PaneNode {
  if (isLeaf(n)) {
    if (n.id !== id) return n;
    if (value) return { ...n, private: true };
    if (n.private === undefined) return n;
    const { private: _drop, ...rest } = n;
    return rest as PaneLeaf;
  }
  return { ...n, children: n.children.map((c) => setLeafPrivate(c, id, value)) };
}

/**
 * Set or clear a terminal leaf's per-leaf theme override. `themeId` is a
 * `TERMINAL_PRESETS` id; pass `null` to clear it (the pane reverts to the
 * global terminal theme). Returns the same tree by reference on no-op. No-op
 * for non-terminal leaves or mismatched ids.
 */
export function setLeafTerminalTheme(n: PaneNode, id: PaneId, themeId: string | null): PaneNode {
  if (isLeaf(n)) {
    if (n.id !== id || n.leafKind !== "terminal") return n;
    if (themeId) {
      if (n.terminalThemeId === themeId) return n;
      return { ...n, terminalThemeId: themeId };
    }
    if (n.terminalThemeId === undefined) return n;
    const { terminalThemeId: _drop, ...rest } = n;
    return rest as PaneLeaf;
  }
  return { ...n, children: n.children.map((c) => setLeafTerminalTheme(c, id, themeId)) };
}

/** Update a preview leaf's current URL. No-op for other leaves or mismatched ids. */
export function updateBrowserLeaf(n: PaneNode, id: PaneId, url: string): PaneNode {
  if (isLeaf(n)) {
    if (n.id !== id || n.leafKind !== "browser" || n.url === url) return n;
    return { ...n, url };
  }
  return { ...n, children: n.children.map((c) => updateBrowserLeaf(c, id, url)) };
}

/** Update a preview leaf's page title. No-op for other leaves or mismatched ids. */
export function updateBrowserLeafTitle(n: PaneNode, id: PaneId, title: string): PaneNode {
  if (isLeaf(n)) {
    if (n.id !== id || n.leafKind !== "browser" || n.title === title) return n;
    return { ...n, title };
  }
  return { ...n, children: n.children.map((c) => updateBrowserLeafTitle(c, id, title)) };
}

/** Patch an extension-panel leaf's `title` and/or lifecycle `state` by id.
 *  `state: null` clears the tone. Returns the same tree by reference when
 *  nothing changed so callers can bail. No-op for other leaves / mismatched
 *  ids. */
export function updateExtensionPanelLeaf(
  n: PaneNode,
  id: PaneId,
  patch: { title?: string; state?: ExtensionTabState | null },
): PaneNode {
  if (isLeaf(n)) {
    if (n.id !== id || n.leafKind !== "extension-panel") return n;
    let next: PaneLeaf = n;
    if (patch.title !== undefined && patch.title !== n.title) {
      next = { ...next, title: patch.title };
    }
    if (patch.state !== undefined) {
      if (patch.state === null) {
        if (next.state !== undefined) {
          const { state: _drop, ...rest } = next;
          next = rest as PaneLeaf;
        }
      } else if (next.state !== patch.state) {
        next = { ...next, state: patch.state };
      }
    }
    return next;
  }
  return { ...n, children: n.children.map((c) => updateExtensionPanelLeaf(c, id, patch)) };
}

/** Patch an editor leaf's mutable state. */
export function updateEditorLeaf(
  n: PaneNode,
  id: PaneId,
  patch: Partial<Pick<EditorLeafState, "path" | "dirty" | "preview">>,
): PaneNode {
  if (isLeaf(n)) {
    if (n.id !== id || n.leafKind !== "editor") return n;
    return { ...n, ...patch };
  }
  return {
    ...n,
    children: n.children.map((c) => updateEditorLeaf(c, id, patch)),
  };
}

/**
 * Clone a leaf's state (without its id) for a live move/extract, so the leaf's
 * attached PTY / editor session / browser webview travels with it. Drops the
 * serialization-only `ptyId`/`savedPtyId` (the live session re-stamps them).
 */
export function cloneLeafState(leaf: PaneLeaf): LeafState {
  if (leaf.leafKind === "terminal") {
    return {
      leafKind: "terminal",
      cwd: leaf.cwd,
      sshConnectionId: leaf.sshConnectionId,
      terminalOrdinal: leaf.terminalOrdinal,
      ...(leaf.private ? { private: true } : {}),
      ...(leaf.terminalThemeId ? { terminalThemeId: leaf.terminalThemeId } : {}),
    };
  }
  if (leaf.leafKind === "editor") {
    return {
      leafKind: "editor",
      path: leaf.path,
      dirty: leaf.dirty,
      preview: leaf.preview,
      sshSessionId: leaf.sshSessionId,
      sshHostLabel: leaf.sshHostLabel,
      ...(leaf.private ? { private: true } : {}),
    };
  }
  if (leaf.leafKind === "extension-panel") {
    return {
      leafKind: "extension-panel",
      extensionId: leaf.extensionId,
      panelId: leaf.panelId,
      ...(leaf.reuseKey ? { reuseKey: leaf.reuseKey } : {}),
      ...(leaf.title ? { title: leaf.title } : {}),
      ...(leaf.icon ? { icon: leaf.icon } : {}),
      ...(leaf.state ? { state: leaf.state } : {}),
      ...(leaf.private ? { private: true } : {}),
    };
  }
  return {
    leafKind: "browser",
    url: leaf.url,
    ...(leaf.title ? { title: leaf.title } : {}),
    ...(leaf.browserOrdinal != null ? { browserOrdinal: leaf.browserOrdinal } : {}),
    ...(leaf.private ? { private: true } : {}),
  };
}

/** Insert a new leaf next to `targetId` in `dir`. Joins as a sibling if the enclosing split already runs that way. */
export function splitLeaf(
  tree: PaneNode,
  targetId: PaneId,
  newSplitId: PaneId,
  newLeafId: PaneId,
  dir: SplitDir,
  newLeafState: LeafState,
): PaneNode {
  if (tree.kind === "split" && tree.dir === dir) {
    const idx = tree.children.findIndex((c) => c.kind === "leaf" && c.id === targetId);
    if (idx >= 0) {
      const newLeaf: PaneLeaf = {
        kind: "leaf",
        id: newLeafId,
        ...newLeafState,
      };
      return {
        ...tree,
        children: [...tree.children.slice(0, idx + 1), newLeaf, ...tree.children.slice(idx + 1)],
      };
    }
  }
  if (isLeaf(tree)) {
    if (tree.id !== targetId) return tree;
    const newLeaf: PaneLeaf = {
      kind: "leaf",
      id: newLeafId,
      ...newLeafState,
    };
    return {
      kind: "split",
      id: newSplitId,
      dir,
      children: [tree, newLeaf],
    };
  }
  return {
    ...tree,
    children: tree.children.map((c) =>
      splitLeaf(c, targetId, newSplitId, newLeafId, dir, newLeafState),
    ),
  };
}

export function removeLeaf(tree: PaneNode, targetId: PaneId): PaneNode | null {
  if (isLeaf(tree)) return tree.id === targetId ? null : tree;
  const newChildren: PaneNode[] = [];
  for (const c of tree.children) {
    const r = removeLeaf(c, targetId);
    if (r !== null) newChildren.push(r);
  }
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0];
  return { ...tree, children: newChildren };
}

export function nextLeafId(tree: PaneNode, currentId: PaneId, delta: 1 | -1): PaneId {
  const ids = leafIds(tree);
  if (ids.length === 0) return currentId;
  const idx = ids.indexOf(currentId);
  if (idx < 0) return ids[0];
  return ids[(idx + delta + ids.length) % ids.length];
}

export function siblingLeafOf(tree: PaneNode, leafId: PaneId): PaneId | null {
  if (isLeaf(tree)) return null;
  for (let i = 0; i < tree.children.length; i++) {
    const c = tree.children[i];
    if (isLeaf(c) && c.id === leafId) {
      const sibling = tree.children[i + 1] ?? tree.children[i - 1];
      if (!sibling) return null;
      return leafIds(sibling)[0] ?? null;
    }
  }
  for (const c of tree.children) {
    if (!isLeaf(c)) {
      const r = siblingLeafOf(c, leafId);
      if (r !== null) return r;
    }
  }
  return null;
}

/**
 * Pair `leafId` with its immediate sibling and wrap them in a sub-split with
 * opposite direction. Prefers the right neighbor, falls back to left. Other
 * siblings of the parent split are untouched. For a flat 2-leaf split, this
 * collapses to flipping the parent's direction. Returns null on no-op.
 */
export function rotateLeafWithNeighbor(
  tree: PaneNode,
  leafId: PaneId,
  newSplitId: PaneId,
): PaneNode | null {
  if (isLeaf(tree)) return null;
  const idx = tree.children.findIndex((c) => isLeaf(c) && c.id === leafId);
  if (idx >= 0) {
    // Prefer right neighbor. Fall back to left when at the tail.
    const neighborIdx = idx + 1 < tree.children.length ? idx + 1 : idx - 1;
    if (neighborIdx < 0) return null;
    const lo = Math.min(idx, neighborIdx);
    const hi = Math.max(idx, neighborIdx);
    const pair: PaneNode = {
      kind: "split",
      id: newSplitId,
      dir: tree.dir === "row" ? "col" : "row",
      children: [tree.children[lo], tree.children[hi]],
    };
    const newChildren = [...tree.children];
    newChildren.splice(lo, 2, pair);
    // One-child wrapper after a 2-leaf collapse. Unwrap to keep the tree canonical.
    if (newChildren.length === 1) return newChildren[0];
    return { ...tree, children: newChildren };
  }
  // Leaf is deeper. Recurse and rebuild only on the matching path.
  let changed = false;
  const newChildren = tree.children.map((c) => {
    const r = rotateLeafWithNeighbor(c, leafId, newSplitId);
    if (r !== null) {
      changed = true;
      return r;
    }
    return c;
  });
  if (!changed) return null;
  return { ...tree, children: newChildren };
}

/**
 * Reorder `leafId` within its immediate split parent. Lands before
 * `beforeLeafId`, or at the end when null. No-op when the two leaves aren't
 * direct siblings. Returns the same tree by reference on no-op.
 */
export function reorderLeafInTree(
  tree: PaneNode,
  leafId: PaneId,
  beforeLeafId: PaneId | null,
): PaneNode {
  if (isLeaf(tree)) return tree;
  const fromIdx = tree.children.findIndex((c) => isLeaf(c) && c.id === leafId);
  if (fromIdx >= 0) {
    let insertIdx: number;
    if (beforeLeafId === null) {
      insertIdx = tree.children.length;
    } else {
      const toIdx = tree.children.findIndex((c) => isLeaf(c) && c.id === beforeLeafId);
      if (toIdx < 0) return tree;
      insertIdx = toIdx;
    }
    if (fromIdx === insertIdx || fromIdx + 1 === insertIdx) return tree;
    const moving = tree.children[fromIdx];
    const without = [...tree.children.slice(0, fromIdx), ...tree.children.slice(fromIdx + 1)];
    const targetIdx = fromIdx < insertIdx ? insertIdx - 1 : insertIdx;
    return {
      ...tree,
      children: [...without.slice(0, targetIdx), moving, ...without.slice(targetIdx)],
    };
  }
  let changed = false;
  const newChildren = tree.children.map((c) => {
    if (isLeaf(c)) return c;
    const r = reorderLeafInTree(c, leafId, beforeLeafId);
    if (r !== c) {
      changed = true;
      return r;
    }
    return c;
  });
  if (!changed) return tree;
  return { ...tree, children: newChildren };
}

/**
 * Insert an existing `source` leaf as a sibling of `targetLeafId` on the
 * given side. When the target's enclosing split already runs in `dir`, the
 * leaf joins as a direct sibling; otherwise the target is wrapped in a fresh
 * sub-split of that direction. `before` controls which side of the target the
 * leaf lands on.
 */
function insertLeafBeside(
  tree: PaneNode,
  targetLeafId: PaneId,
  source: PaneLeaf,
  dir: SplitDir,
  before: boolean,
  newSplitId: PaneId,
): PaneNode {
  if (isLeaf(tree)) {
    if (tree.id !== targetLeafId) return tree;
    return {
      kind: "split",
      id: newSplitId,
      dir,
      children: before ? [source, tree] : [tree, source],
    };
  }
  const idx = tree.children.findIndex((c) => isLeaf(c) && c.id === targetLeafId);
  if (idx >= 0) {
    if (tree.dir === dir) {
      const insertAt = before ? idx : idx + 1;
      return {
        ...tree,
        children: [...tree.children.slice(0, insertAt), source, ...tree.children.slice(insertAt)],
      };
    }
    const wrapped: PaneNode = {
      kind: "split",
      id: newSplitId,
      dir,
      children: before ? [source, tree.children[idx]] : [tree.children[idx], source],
    };
    const next = [...tree.children];
    next[idx] = wrapped;
    return { ...tree, children: next };
  }
  return {
    ...tree,
    children: tree.children.map((c) =>
      insertLeafBeside(c, targetLeafId, source, dir, before, newSplitId),
    ),
  };
}

/**
 * Drag-and-drop move: relocate `sourceLeafId` so it sits on the `edge` side of
 * `targetLeafId`. The leaf keeps its id and full state, so its attached PTY /
 * editor session survives the move. `left`/`right` land in a row split,
 * `top`/`bottom` in a column split; a target already inside a split of that
 * direction gains the leaf as a direct sibling rather than nesting deeper. The
 * result is normalized. Returns null on no-op (same leaf, missing id, or the
 * removal would also drop the target).
 */
export function movePaneLeafToEdge(
  tree: PaneNode,
  sourceLeafId: PaneId,
  targetLeafId: PaneId,
  edge: PaneEdge,
  newSplitId: PaneId,
): PaneNode | null {
  if (sourceLeafId === targetLeafId) return null;
  const source = findLeaf(tree, sourceLeafId);
  if (!source) return null;
  if (!hasLeaf(tree, targetLeafId)) return null;
  const without = removeLeaf(tree, sourceLeafId);
  if (without === null || !hasLeaf(without, targetLeafId)) return null;
  const dir: SplitDir = edge === "left" || edge === "right" ? "row" : "col";
  const before = edge === "left" || edge === "top";
  const inserted = insertLeafBeside(without, targetLeafId, source, dir, before, newSplitId);
  return normalizePaneTree(inserted);
}

/**
 * Canonicalize the tree. Flattens nested splits matching the parent's
 * direction and unwraps single-child splits. Used after rotations so
 * successive toggles round-trip the tree.
 */
export function normalizePaneTree(node: PaneNode): PaneNode {
  if (isLeaf(node)) return node;
  const flattened: PaneNode[] = [];
  for (const raw of node.children) {
    const c = normalizePaneTree(raw);
    if (c.kind === "split" && c.dir === node.dir) {
      flattened.push(...c.children);
    } else {
      flattened.push(c);
    }
  }
  if (flattened.length === 1) return flattened[0];
  return { ...node, children: flattened };
}

/** First leaf of a given kind. */
export function firstLeafOfKind(tree: PaneNode, kind: LeafState["leafKind"]): PaneLeaf | null {
  for (const l of leaves(tree)) {
    if (l.leafKind === kind) return l;
  }
  return null;
}
