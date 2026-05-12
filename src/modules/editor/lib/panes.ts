export type EditorPaneId = number;

export type EditorSplitDir = "row" | "col";

export type EditorLeafState = {
  path: string;
  dirty: boolean;
  preview: boolean;
};

export type EditorPaneNode =
  | ({ kind: "leaf"; id: EditorPaneId } & EditorLeafState)
  | {
      kind: "split";
      id: EditorPaneId;
      dir: EditorSplitDir;
      children: EditorPaneNode[];
    };

export function isLeaf(
  n: EditorPaneNode,
): n is Extract<EditorPaneNode, { kind: "leaf" }> {
  return n.kind === "leaf";
}

export function leafIds(n: EditorPaneNode): EditorPaneId[] {
  if (isLeaf(n)) return [n.id];
  return n.children.flatMap(leafIds);
}

export function leaves(
  n: EditorPaneNode,
): Extract<EditorPaneNode, { kind: "leaf" }>[] {
  if (isLeaf(n)) return [n];
  return n.children.flatMap(leaves);
}

export function findLeaf(
  n: EditorPaneNode,
  id: EditorPaneId,
): Extract<EditorPaneNode, { kind: "leaf" }> | null {
  if (isLeaf(n)) return n.id === id ? n : null;
  for (const c of n.children) {
    const found = findLeaf(c, id);
    if (found) return found;
  }
  return null;
}

export function hasLeaf(n: EditorPaneNode, id: EditorPaneId): boolean {
  return findLeaf(n, id) !== null;
}

export function updateLeaf(
  tree: EditorPaneNode,
  id: EditorPaneId,
  patch: Partial<EditorLeafState>,
): EditorPaneNode {
  if (isLeaf(tree)) return tree.id === id ? { ...tree, ...patch } : tree;
  return {
    ...tree,
    children: tree.children.map((c) => updateLeaf(c, id, patch)),
  };
}

export function splitLeaf(
  tree: EditorPaneNode,
  targetId: EditorPaneId,
  newSplitId: EditorPaneId,
  newLeafId: EditorPaneId,
  dir: EditorSplitDir,
  state: EditorLeafState,
): EditorPaneNode {
  if (tree.kind === "split" && tree.dir === dir) {
    const idx = tree.children.findIndex(
      (c) => c.kind === "leaf" && c.id === targetId,
    );
    if (idx >= 0) {
      const newLeaf: EditorPaneNode = {
        kind: "leaf",
        id: newLeafId,
        ...state,
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
    const newLeaf: EditorPaneNode = {
      kind: "leaf",
      id: newLeafId,
      ...state,
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
      splitLeaf(c, targetId, newSplitId, newLeafId, dir, state),
    ),
  };
}

export function removeLeaf(
  tree: EditorPaneNode,
  targetId: EditorPaneId,
): EditorPaneNode | null {
  if (isLeaf(tree)) return tree.id === targetId ? null : tree;
  const newChildren: EditorPaneNode[] = [];
  for (const c of tree.children) {
    const r = removeLeaf(c, targetId);
    if (r !== null) newChildren.push(r);
  }
  if (newChildren.length === 0) return null;
  if (newChildren.length === 1) return newChildren[0];
  return { ...tree, children: newChildren };
}

export function nextLeafId(
  tree: EditorPaneNode,
  currentId: EditorPaneId,
  delta: 1 | -1,
): EditorPaneId {
  const ids = leafIds(tree);
  if (ids.length === 0) return currentId;
  const idx = ids.indexOf(currentId);
  if (idx < 0) return ids[0];
  return ids[(idx + delta + ids.length) % ids.length];
}

export function siblingLeafOf(
  tree: EditorPaneNode,
  leafId: EditorPaneId,
): EditorPaneId | null {
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
