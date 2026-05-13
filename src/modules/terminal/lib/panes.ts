// Unified pane tree. A leaf can be either a terminal or an editor - the
// host renders the appropriate component per leaf. `kind: "leaf"` is kept
// for back-compat with all the existing terminal-only call sites; the new
// discriminator is `leafKind`.

export type PaneId = number;

export type SplitDir = "row" | "col";

export type TerminalLeafState = {
  leafKind: "terminal";
  cwd?: string;
};

export type EditorLeafState = {
  leafKind: "editor";
  /** Absolute (forward-slash) path of the file open in this leaf. */
  path: string;
  /** Mirrors the unsaved-edits state of the underlying CodeMirror buffer. */
  dirty: boolean;
  /** VSCode-style preview tab indicator (italic title). */
  preview: boolean;
};

export type LeafState = TerminalLeafState | EditorLeafState;

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

/** Update a terminal leaf's cwd. No-op for editor leaves or non-matching ids. */
export function setLeafCwd(
  n: PaneNode,
  id: PaneId,
  cwd: string,
): PaneNode {
  if (isLeaf(n)) {
    if (n.id !== id || n.leafKind !== "terminal") return n;
    return { ...n, cwd };
  }
  return { ...n, children: n.children.map((c) => setLeafCwd(c, id, cwd)) };
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
 * Insert a new leaf next to `targetId` in direction `dir`. If the target's
 * enclosing split already runs in `dir`, the new leaf joins as a sibling.
 */
export function splitLeaf(
  tree: PaneNode,
  targetId: PaneId,
  newSplitId: PaneId,
  newLeafId: PaneId,
  dir: SplitDir,
  newLeafState: LeafState,
): PaneNode {
  if (tree.kind === "split" && tree.dir === dir) {
    const idx = tree.children.findIndex(
      (c) => c.kind === "leaf" && c.id === targetId,
    );
    if (idx >= 0) {
      const newLeaf: PaneLeaf = {
        kind: "leaf",
        id: newLeafId,
        ...newLeafState,
      };
      return {
        ...tree,
        children: [
          ...tree.children.slice(0, idx + 1),
          newLeaf,
          ...tree.children.slice(idx + 1),
        ],
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

export function removeLeaf(
  tree: PaneNode,
  targetId: PaneId,
): PaneNode | null {
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

export function nextLeafId(
  tree: PaneNode,
  currentId: PaneId,
  delta: 1 | -1,
): PaneId {
  const ids = leafIds(tree);
  if (ids.length === 0) return currentId;
  const idx = ids.indexOf(currentId);
  if (idx < 0) return ids[0];
  return ids[(idx + delta + ids.length) % ids.length];
}

export function siblingLeafOf(
  tree: PaneNode,
  leafId: PaneId,
): PaneId | null {
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

/** First leaf of a given kind (used to find a default editor target etc.). */
export function firstLeafOfKind(
  tree: PaneNode,
  kind: LeafState["leafKind"],
): PaneLeaf | null {
  for (const l of leaves(tree)) {
    if (l.leafKind === kind) return l;
  }
  return null;
}
