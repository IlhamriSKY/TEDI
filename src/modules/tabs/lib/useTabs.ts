import { useCallback, useRef, useState } from "react";
import {
  findLeaf,
  hasLeaf,
  leafIds,
  leaves,
  nextLeafId,
  removeLeaf,
  setLeafCwd as setLeafCwdInTree,
  siblingLeafOf,
  splitLeaf,
  updateEditorLeaf,
  type EditorLeafState,
  type LeafState,
  type PaneLeaf,
  type PaneNode,
  type SplitDir,
  type TerminalLeafState,
} from "@/modules/terminal/lib/panes";

// Browsers cap WebGL contexts at ~16; one xterm renderer per terminal leaf.
export const MAX_PANES_PER_TAB = 8;

/**
 * Unified tab — holds a pane tree of mixed leaves (terminal or editor).
 *
 * Single-leaf pane tabs reproduce the old "terminal tab" or "editor tab"
 * behavior; multi-leaf pane tabs render side-by-side via the pane tree and
 * may mix terminal+editor leaves freely.
 *
 * `title` / `cwd` / `path` / `dirty` / `preview` are derived from the active
 * leaf and resynced whenever the tree or active leaf changes — call sites
 * that read these top-level fields keep working as before.
 */
export type PaneTab = {
  id: number;
  kind: "pane";
  title: string;
  paneTree: PaneNode;
  activeLeafId: number;
  // Mirrors of the active leaf — populated by `syncPaneMirror`.
  cwd?: string;
  path?: string;
  dirty?: boolean;
  preview?: boolean;
};

// Back-compat type aliases — many existing call sites still narrow on
// `t.kind === "terminal"` / `t.kind === "editor"`. The runtime tab kind is
// always `"pane"` now; use `activeLeafKind(t)` to discriminate.
//
// New code should not use these — read the active leaf instead.
export type TerminalTab = PaneTab;
export type EditorTab = PaneTab;

export type PreviewTab = {
  id: number;
  kind: "preview";
  title: string;
  url: string;
};

export type AiDiffStatus = "pending" | "approved" | "rejected";

export type AiDiffTab = {
  id: number;
  kind: "ai-diff";
  title: string;
  path: string;
  originalContent: string;
  proposedContent: string;
  approvalId: string;
  status: AiDiffStatus;
  isNewFile: boolean;
};

export type Tab = PaneTab | PreviewTab | AiDiffTab;

export type TabPatch = Partial<{
  title: string;
  cwd: string;
  path: string;
  dirty: boolean;
  url: string;
}>;

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url || "preview";
  }
}

/** Derive a tab title from its active leaf. */
function titleFromLeaf(leaf: PaneLeaf): string {
  if (leaf.leafKind === "editor") return basename(leaf.path);
  // Terminal: prefer the cwd basename, fall back to "shell".
  if (leaf.cwd) {
    const b = basename(leaf.cwd);
    if (b) return b;
  }
  return "shell";
}

/** Recompute the top-level mirrors from the active leaf. */
function syncPaneMirror(tab: PaneTab): PaneTab {
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
  } else {
    delete next.cwd;
    next.path = leaf.path;
    next.dirty = leaf.dirty;
    next.preview = leaf.preview;
  }
  return next;
}

/**
 * Helpers for callers that want to discriminate on the **active leaf** kind
 * (the natural replacement for the old `t.kind === "terminal"` check).
 */
export function activeLeaf(tab: Tab): PaneLeaf | null {
  if (tab.kind !== "pane") return null;
  return findLeaf(tab.paneTree, tab.activeLeafId);
}

export function activeLeafKind(
  tab: Tab,
): "terminal" | "editor" | null {
  const leaf = activeLeaf(tab);
  return leaf ? leaf.leafKind : null;
}

export function isTerminalLikeTab(tab: Tab): boolean {
  return tab.kind === "pane" && activeLeafKind(tab) === "terminal";
}

export function isEditorLikeTab(tab: Tab): boolean {
  return tab.kind === "pane" && activeLeafKind(tab) === "editor";
}

export function useTabs(initial?: { cwd?: string; title?: string }) {
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const tabId = 1;
    const leafId = 2;
    const leaf: PaneLeaf = {
      kind: "leaf",
      id: leafId,
      leafKind: "terminal",
      cwd: initial?.cwd,
    };
    return [
      syncPaneMirror({
        id: tabId,
        kind: "pane",
        title: initial?.title ?? "shell",
        paneTree: leaf,
        activeLeafId: leafId,
      }),
    ];
  });
  const [activeId, setActiveId] = useState(1);
  const nextIdRef = useRef(3);

  const newTab = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    const leaf: PaneLeaf = {
      kind: "leaf",
      id: leafId,
      leafKind: "terminal",
      cwd,
    };
    setTabs((t) => [
      ...t,
      syncPaneMirror({
        id: tabId,
        kind: "pane",
        title: "shell",
        paneTree: leaf,
        activeLeafId: leafId,
      }),
    ]);
    setActiveId(tabId);
    return tabId;
  }, []);

  /**
   * Find a pane tab that has any editor leaf matching `predicate`. Used by
   * openFileTab to dedup across split-with-editor tabs as well as the simple
   * single-leaf case.
   */
  const findEditorLeafIn = useCallback(
    (
      curr: Tab[],
      path: string,
      predicate: (l: PaneLeaf & EditorLeafState) => boolean = () => true,
    ): { tab: PaneTab; leaf: PaneLeaf & EditorLeafState } | null => {
      for (const t of curr) {
        if (t.kind !== "pane") continue;
        for (const l of leaves(t.paneTree)) {
          if (l.leafKind !== "editor") continue;
          if (l.path !== path) continue;
          if (!predicate(l)) continue;
          return { tab: t, leaf: l };
        }
      }
      return null;
    },
    [],
  );

  /**
   * Opens a file in an editor leaf.
   *
   * - `pin = true` — persistent open. Re-uses an existing editor leaf for
   *   the path (promoting it out of preview if needed), or creates a new
   *   editor tab.
   * - `pin = false` — VSCode-style preview slot.
   */
  const openFileTab = useCallback((path: string, pin = true) => {
    let targetTabId: number | null = null;
    setTabs((curr) => {
      if (pin) {
        const hit = findEditorLeafIn(curr, path);
        if (hit) {
          targetTabId = hit.tab.id;
          return curr.map((t) => {
            if (t.id !== hit.tab.id || t.kind !== "pane") return t;
            let tree = t.paneTree;
            if (hit.leaf.preview) {
              tree = updateEditorLeaf(tree, hit.leaf.id, { preview: false });
            }
            return syncPaneMirror({
              ...t,
              paneTree: tree,
              activeLeafId: hit.leaf.id,
            });
          });
        }
        const id = nextIdRef.current++;
        const leafId = nextIdRef.current++;
        targetTabId = id;
        const leaf: PaneLeaf = {
          kind: "leaf",
          id: leafId,
          leafKind: "editor",
          path,
          dirty: false,
          preview: false,
        };
        return [
          ...curr,
          syncPaneMirror({
            id,
            kind: "pane",
            title: basename(path),
            paneTree: leaf,
            activeLeafId: leafId,
          }),
        ];
      }

      // Preview open
      const persistent = findEditorLeafIn(curr, path, (l) => !l.preview);
      if (persistent) {
        targetTabId = persistent.tab.id;
        return curr.map((t) => {
          if (t.id !== persistent.tab.id || t.kind !== "pane") return t;
          return syncPaneMirror({
            ...t,
            activeLeafId: persistent.leaf.id,
          });
        });
      }
      const existingPreview = findEditorLeafIn(curr, path, (l) => l.preview);
      if (existingPreview) {
        targetTabId = existingPreview.tab.id;
        return curr.map((t) => {
          if (t.id !== existingPreview.tab.id || t.kind !== "pane") return t;
          return syncPaneMirror({
            ...t,
            activeLeafId: existingPreview.leaf.id,
          });
        });
      }
      // Find the existing single-leaf editor preview tab to reuse.
      const previewIdx = curr.findIndex(
        (t) =>
          t.kind === "pane" &&
          leafIds(t.paneTree).length === 1 &&
          (() => {
            const l = findLeaf(t.paneTree, t.activeLeafId);
            return l?.leafKind === "editor" && l.preview;
          })(),
      );
      const id = nextIdRef.current++;
      const leafId = nextIdRef.current++;
      targetTabId = id;
      const leaf: PaneLeaf = {
        kind: "leaf",
        id: leafId,
        leafKind: "editor",
        path,
        dirty: false,
        preview: true,
      };
      const tab: PaneTab = syncPaneMirror({
        id,
        kind: "pane",
        title: basename(path),
        paneTree: leaf,
        activeLeafId: leafId,
      });
      if (previewIdx === -1) return [...curr, tab];
      const next = [...curr];
      next[previewIdx] = tab;
      return next;
    });
    if (targetTabId !== null) setActiveId(targetTabId);
    return targetTabId as number | null;
  }, [findEditorLeafIn]);

  /** Promote the active leaf of `id` out of preview mode. */
  const pinTab = useCallback((id: number) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== id || t.kind !== "pane") return t;
        const leaf = findLeaf(t.paneTree, t.activeLeafId);
        if (!leaf || leaf.leafKind !== "editor" || !leaf.preview) return t;
        const paneTree = updateEditorLeaf(t.paneTree, leaf.id, {
          preview: false,
        });
        return syncPaneMirror({ ...t, paneTree });
      }),
    );
  }, []);

  const openAiDiffTab = useCallback(
    (input: {
      path: string;
      originalContent: string;
      proposedContent: string;
      approvalId: string;
      isNewFile: boolean;
    }) => {
      let targetId: number | null = null;
      setTabs((curr) => {
        const existing = curr.find(
          (t) => t.kind === "ai-diff" && t.approvalId === input.approvalId,
        );
        if (existing) {
          targetId = existing.id;
          return curr;
        }
        const id = nextIdRef.current++;
        targetId = id;
        const title = `${basename(input.path)} (AI diff)`;
        return [
          ...curr,
          {
            id,
            kind: "ai-diff",
            title,
            path: input.path,
            originalContent: input.originalContent,
            proposedContent: input.proposedContent,
            approvalId: input.approvalId,
            status: "pending",
            isNewFile: input.isNewFile,
          },
        ];
      });
      if (targetId !== null) setActiveId(targetId);
      return targetId as number | null;
    },
    [],
  );

  const setAiDiffStatus = useCallback(
    (approvalId: string, status: AiDiffStatus) => {
      setTabs((curr) =>
        curr.map((t) =>
          t.kind === "ai-diff" && t.approvalId === approvalId
            ? { ...t, status }
            : t,
        ),
      );
    },
    [],
  );

  const newPreviewTab = useCallback((url: string) => {
    const id = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      { id, kind: "preview", title: titleFromUrl(url), url },
    ]);
    setActiveId(id);
    return id;
  }, []);

  const closeTab = useCallback((id: number) => {
    setTabs((curr) => {
      if (curr.length <= 1) return curr;
      const idx = curr.findIndex((t) => t.id === id);
      const next = curr.filter((t) => t.id !== id);
      setActiveId((active) =>
        id === active ? next[Math.max(0, idx - 1)].id : active,
      );
      return next;
    });
  }, []);

  const updateTab = useCallback((id: number, patch: TabPatch) => {
    setTabs((t) =>
      t.map((x) => {
        if (x.id !== id) return x;
        if (x.kind === "preview") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.url !== undefined && {
              url: patch.url,
              title: patch.title ?? titleFromUrl(patch.url),
            }),
          };
        }
        if (x.kind === "ai-diff") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.path !== undefined && { path: patch.path }),
          };
        }
        // pane tab — patches apply to the active leaf where relevant.
        const leaf = findLeaf(x.paneTree, x.activeLeafId);
        if (!leaf) return x;
        let tree = x.paneTree;
        if (leaf.leafKind === "editor") {
          const leafPatch: Partial<Pick<EditorLeafState, "path" | "dirty" | "preview">> = {};
          if (patch.dirty !== undefined) {
            leafPatch.dirty = patch.dirty;
            if (patch.dirty === true && leaf.preview) leafPatch.preview = false;
          }
          if (patch.path !== undefined) leafPatch.path = patch.path;
          if (Object.keys(leafPatch).length > 0) {
            tree = updateEditorLeaf(tree, leaf.id, leafPatch);
          }
        } else if (leaf.leafKind === "terminal") {
          if (patch.cwd !== undefined) {
            tree = setLeafCwdInTree(tree, leaf.id, patch.cwd);
          }
        }
        return syncPaneMirror({
          ...x,
          paneTree: tree,
          ...(patch.title !== undefined && { title: patch.title }),
        });
      }),
    );
  }, []);

  const selectByIndex = useCallback(
    (idx: number) => {
      const t = tabs[idx];
      if (t) setActiveId(t.id);
    },
    [tabs],
  );

  /** Update a terminal leaf's cwd. Mirrors to the tab when leaf is active. */
  const setLeafCwd = useCallback((leafId: number, cwd: string) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "pane") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = setLeafCwdInTree(t.paneTree, leafId, cwd);
        return syncPaneMirror({ ...t, paneTree });
      }),
    );
  }, []);

  const setEditorLeafDirty = useCallback((leafId: number, dirty: boolean) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "pane") return t;
        const leaf = findLeaf(t.paneTree, leafId);
        if (!leaf || leaf.leafKind !== "editor") return t;
        const patch: Partial<Pick<EditorLeafState, "dirty" | "preview">> = {
          dirty,
        };
        if (dirty && leaf.preview) patch.preview = false;
        const paneTree = updateEditorLeaf(t.paneTree, leafId, patch);
        return syncPaneMirror({ ...t, paneTree });
      }),
    );
  }, []);

  const setEditorLeafPath = useCallback((leafId: number, path: string) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "pane") return t;
        const leaf = findLeaf(t.paneTree, leafId);
        if (!leaf || leaf.leafKind !== "editor") return t;
        const paneTree = updateEditorLeaf(t.paneTree, leafId, { path });
        return syncPaneMirror({ ...t, paneTree });
      }),
    );
  }, []);

  const focusPane = useCallback((tabId: number, leafId: number) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== tabId || t.kind !== "pane") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        if (t.activeLeafId === leafId) return t;
        return syncPaneMirror({ ...t, activeLeafId: leafId });
      }),
    );
  }, []);

  const focusNextPaneInTab = useCallback(
    (tabId: number, delta: 1 | -1) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "pane") return t;
          const next = nextLeafId(t.paneTree, t.activeLeafId, delta);
          if (next === t.activeLeafId) return t;
          return syncPaneMirror({ ...t, activeLeafId: next });
        }),
      );
    },
    [],
  );

  /**
   * Split the active leaf of `tabId` along `dir`, inserting a new leaf.
   *
   * Rules:
   * - terminal ↔ terminal: allowed.
   * - terminal ↔ editor (and vice versa): allowed.
   * - editor ↔ editor: **forbidden** — a tab can hold at most one editor leaf.
   *
   * Default new-leaf kind:
   * - active leaf is terminal → new pane is terminal (mirrors prior behavior).
   * - active leaf is editor → new pane is terminal (the only legal companion).
   *
   * Pass `newKind` explicitly to override. A request for a second editor leaf
   * is rejected (returns `null`, tree unchanged).
   */
  const splitActivePane = useCallback(
    (
      tabId: number,
      dir: SplitDir,
      newKind?: "terminal" | "editor",
    ): number | null => {
      let newLeafId: number | null = null;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "pane") return t;
          if (leafIds(t.paneTree).length >= MAX_PANES_PER_TAB) return t;
          const active = findLeaf(t.paneTree, t.activeLeafId);
          if (!active) return t;

          // Default: terminal. Editors never spawn a sibling editor.
          const kind: "terminal" | "editor" = newKind ?? "terminal";

          // Reject editor↔editor: at most one editor leaf per tab.
          if (kind === "editor") {
            const hasEditor = leaves(t.paneTree).some(
              (l) => l.leafKind === "editor",
            );
            if (hasEditor) {
              newLeafId = null;
              return t;
            }
          }

          const splitId = nextIdRef.current++;
          const leafId = nextIdRef.current++;
          newLeafId = leafId;
          let state: LeafState;
          if (kind === "terminal") {
            const cwd =
              active.leafKind === "terminal" ? active.cwd : t.cwd;
            const ts: TerminalLeafState = { leafKind: "terminal", cwd };
            state = ts;
          } else {
            // Adding an editor leaf to a terminal tab — need a file path to
            // open. There's no obvious source path here (active is terminal,
            // and we just verified no other editor leaf exists), so skip.
            const sourcePath = leaves(t.paneTree).find(
              (l): l is PaneLeaf & EditorLeafState =>
                l.leafKind === "editor",
            )?.path;
            if (!sourcePath) {
              newLeafId = null;
              return t;
            }
            const es: EditorLeafState = {
              leafKind: "editor",
              path: sourcePath,
              dirty: false,
              preview: false,
            };
            state = es;
          }
          const paneTree = splitLeaf(
            t.paneTree,
            t.activeLeafId,
            splitId,
            leafId,
            dir,
            state,
          );
          return syncPaneMirror({ ...t, paneTree, activeLeafId: leafId });
        }),
      );
      return newLeafId;
    },
    [],
  );

  const closePaneByLeaf = useCallback((leafId: number): void => {
    setTabs((curr) => {
      const tab = curr.find(
        (t) => t.kind === "pane" && hasLeaf(t.paneTree, leafId),
      );
      if (!tab || tab.kind !== "pane") return curr;
      const newTree = removeLeaf(tab.paneTree, leafId);
      if (newTree === null) {
        if (curr.length <= 1) return curr;
        const idx = curr.findIndex((x) => x.id === tab.id);
        const next = curr.filter((x) => x.id !== tab.id);
        setActiveId((active) =>
          active === tab.id ? next[Math.max(0, idx - 1)].id : active,
        );
        return next;
      }
      const remaining = leafIds(newTree);
      let newActive = tab.activeLeafId;
      if (tab.activeLeafId === leafId) {
        const sib = siblingLeafOf(tab.paneTree, leafId);
        newActive = sib && remaining.includes(sib) ? sib : remaining[0];
      }
      return curr.map((x) => {
        if (x.id !== tab.id || x.kind !== "pane") return x;
        return syncPaneMirror({
          ...x,
          paneTree: newTree,
          activeLeafId: newActive,
        });
      });
    });
  }, []);

  const closeActivePane = useCallback((tabId: number): boolean => {
    let closedTab = false;
    setTabs((curr) => {
      const t = curr.find((x) => x.id === tabId);
      if (!t || t.kind !== "pane") return curr;
      const target = t.activeLeafId;
      const newTree = removeLeaf(t.paneTree, target);
      if (newTree === null) {
        if (curr.length <= 1) return curr;
        const idx = curr.findIndex((x) => x.id === tabId);
        const next = curr.filter((x) => x.id !== tabId);
        setActiveId((active) =>
          active === tabId ? next[Math.max(0, idx - 1)].id : active,
        );
        closedTab = true;
        return next;
      }
      const remaining = leafIds(newTree);
      const sib = siblingLeafOf(t.paneTree, target);
      const newActive =
        sib && remaining.includes(sib) ? sib : remaining[0];
      return curr.map((x) => {
        if (x.id !== tabId || x.kind !== "pane") return x;
        return syncPaneMirror({
          ...x,
          paneTree: newTree,
          activeLeafId: newActive,
        });
      });
    });
    return closedTab;
  }, []);

  /**
   * Workspaces switch — replace the full tab list + active id atomically.
   * Also rebases `nextIdRef` so new ids never collide with the incoming set.
   */
  const replaceAllTabs = useCallback(
    (nextTabs: Tab[], nextActiveId: number | null) => {
      setTabs(nextTabs);
      if (nextActiveId !== null) setActiveId(nextActiveId);
      let maxId = 0;
      for (const t of nextTabs) {
        if (t.id > maxId) maxId = t.id;
        if (t.kind === "pane") {
          for (const l of leaves(t.paneTree)) {
            if (l.id > maxId) maxId = l.id;
          }
        }
      }
      nextIdRef.current = Math.max(nextIdRef.current, maxId + 1);
    },
    [],
  );

  /** Allocate a fresh id from the same counter that drives tabs/leaves. */
  const allocId = useCallback(() => nextIdRef.current++, []);

  return {
    tabs,
    activeId,
    setActiveId,
    newTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    openAiDiffTab,
    setAiDiffStatus,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    setEditorLeafDirty,
    setEditorLeafPath,
    focusPane,
    focusNextPaneInTab,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    replaceAllTabs,
    allocId,
  };
}
