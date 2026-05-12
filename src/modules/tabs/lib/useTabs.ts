import { useCallback, useRef, useState } from "react";
import {
  hasLeaf,
  leafIds,
  nextLeafId,
  removeLeaf,
  setLeafCwd as setLeafCwdInTree,
  siblingLeafOf,
  splitLeaf,
  type PaneNode,
  type SplitDir,
} from "@/modules/terminal/lib/panes";
import {
  findLeaf as findEditorLeaf,
  hasLeaf as hasEditorLeaf,
  leafIds as editorLeafIds,
  leaves as editorLeaves,
  nextLeafId as nextEditorLeafId,
  removeLeaf as removeEditorLeaf,
  siblingLeafOf as editorSiblingLeafOf,
  splitLeaf as splitEditorLeaf,
  updateLeaf as updateEditorLeaf,
  type EditorPaneNode,
  type EditorSplitDir,
} from "@/modules/editor/lib/panes";

// Browsers cap WebGL contexts at ~16; one xterm renderer per leaf.
export const MAX_PANES_PER_TAB = 8;

export type TerminalTab = {
  id: number;
  kind: "terminal";
  title: string;
  cwd?: string;
  paneTree: PaneNode;
  activeLeafId: number;
};

/**
 * Top-level `path` / `dirty` / `preview` / `title` mirror the **active leaf**
 * of `paneTree`. Single-leaf editors behave exactly as before splits existed;
 * multi-leaf editors render side-by-side via the pane tree.
 */
export type EditorTab = {
  id: number;
  kind: "editor";
  title: string;
  path: string;
  dirty: boolean;
  preview: boolean;
  paneTree: EditorPaneNode;
  activeLeafId: number;
};

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
  /** "" for newly created files. */
  originalContent: string;
  proposedContent: string;
  /** Tool-call approval id used to resolve the AI SDK approval. */
  approvalId: string;
  status: AiDiffStatus;
  isNewFile: boolean;
};

export type Tab = TerminalTab | EditorTab | PreviewTab | AiDiffTab;

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

/** Sync the top-level mirror fields with the current active leaf. */
function syncEditorMirror(tab: EditorTab): EditorTab {
  const leaf = findEditorLeaf(tab.paneTree, tab.activeLeafId);
  if (!leaf) return tab;
  return {
    ...tab,
    path: leaf.path,
    dirty: leaf.dirty,
    preview: leaf.preview,
    title: basename(leaf.path),
  };
}

export function useTabs(initial?: Partial<TerminalTab>) {
  const [tabs, setTabs] = useState<Tab[]>(() => {
    const tabId = 1;
    const leafId = 2;
    return [
      {
        id: tabId,
        kind: "terminal",
        title: initial?.title ?? "shell",
        cwd: initial?.cwd,
        paneTree: { kind: "leaf", id: leafId, cwd: initial?.cwd },
        activeLeafId: leafId,
      },
    ];
  });
  const [activeId, setActiveId] = useState(1);
  const nextIdRef = useRef(3);

  const newTab = useCallback((cwd?: string) => {
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    setTabs((t) => [
      ...t,
      {
        id: tabId,
        kind: "terminal",
        title: "shell",
        cwd,
        paneTree: { kind: "leaf", id: leafId, cwd },
        activeLeafId: leafId,
      },
    ]);
    setActiveId(tabId);
    return tabId;
  }, []);

  /**
   * Opens a file in an editor tab.
   *
   * - `pin = true` (default) — opens or activates a **persistent** tab.
   *   If the path is currently in the preview slot it is promoted in-place.
   *   Use this for programmatic opens (AI diff, New File dialog, etc.).
   * - `pin = false` — VSCode-style **preview** tab. A single shared slot is
   *   reused: if a persistent tab for the path already exists it is activated;
   *   otherwise the current preview slot is replaced with the new path.
   *
   * Editor tabs with multiple panes are skipped for the persistent/preview
   * dedup — opening a path that's already shown in a split picks that tab,
   * but never replaces a split tab's preview slot.
   */
  const openFileTab = useCallback((path: string, pin = true) => {
    let targetId: number | null = null;
    setTabs((curr) => {
      const findEditorWithPath = (predicate: (leaf: ReturnType<typeof editorLeaves>[number]) => boolean) => {
        for (const t of curr) {
          if (t.kind !== "editor") continue;
          const leaf = editorLeaves(t.paneTree).find((l) => l.path === path && predicate(l));
          if (leaf) return { tab: t, leaf };
        }
        return null;
      };

      if (pin) {
        const hit = findEditorWithPath(() => true);
        if (hit) {
          targetId = hit.tab.id;
          // If the matching leaf is in preview state, promote it.
          if (hit.leaf.preview) {
            return curr.map((t) => {
              if (t.id !== hit.tab.id || t.kind !== "editor") return t;
              const paneTree = updateEditorLeaf(t.paneTree, hit.leaf.id, {
                preview: false,
              });
              return syncEditorMirror({
                ...t,
                paneTree,
                activeLeafId: hit.leaf.id,
              });
            });
          }
          // Just focus that leaf.
          return curr.map((t) => {
            if (t.id !== hit.tab.id || t.kind !== "editor") return t;
            return syncEditorMirror({ ...t, activeLeafId: hit.leaf.id });
          });
        }
        const id = nextIdRef.current++;
        const leafId = nextIdRef.current++;
        targetId = id;
        const tab: EditorTab = {
          id,
          kind: "editor",
          title: basename(path),
          path,
          dirty: false,
          preview: false,
          paneTree: {
            kind: "leaf",
            id: leafId,
            path,
            dirty: false,
            preview: false,
          },
          activeLeafId: leafId,
        };
        return [...curr, tab];
      } else {
        // Preview open: persistent leaf for this path takes priority.
        const persistent = findEditorWithPath((l) => !l.preview);
        if (persistent) {
          targetId = persistent.tab.id;
          return curr.map((t) => {
            if (t.id !== persistent.tab.id || t.kind !== "editor") return t;
            return syncEditorMirror({
              ...t,
              activeLeafId: persistent.leaf.id,
            });
          });
        }
        // Reuse the slot if it already shows the same path in preview mode.
        const existingPreview = findEditorWithPath((l) => l.preview);
        if (existingPreview) {
          targetId = existingPreview.tab.id;
          return curr.map((t) => {
            if (t.id !== existingPreview.tab.id || t.kind !== "editor") return t;
            return syncEditorMirror({
              ...t,
              activeLeafId: existingPreview.leaf.id,
            });
          });
        }
        // Replace the current preview slot, or append a new editor tab.
        // Only single-leaf editor tabs are eligible to act as "the" preview
        // slot — split tabs are user-curated and shouldn't be reused.
        const previewIdx = curr.findIndex(
          (t) =>
            t.kind === "editor" &&
            editorLeafIds(t.paneTree).length === 1 &&
            t.preview,
        );
        const id = nextIdRef.current++;
        const leafId = nextIdRef.current++;
        targetId = id;
        const tab: EditorTab = {
          id,
          kind: "editor",
          title: basename(path),
          path,
          dirty: false,
          preview: true,
          paneTree: {
            kind: "leaf",
            id: leafId,
            path,
            dirty: false,
            preview: true,
          },
          activeLeafId: leafId,
        };
        if (previewIdx === -1) return [...curr, tab];
        const next = [...curr];
        next[previewIdx] = tab;
        return next;
      }
    });
    if (targetId !== null) setActiveId(targetId);
    return targetId as number | null;
  }, []);

  /**
   * Promotes a preview tab to a persistent one. Called on double-click of the
   * tab title in the tab bar. Dirty edits also auto-promote (see `updateTab`).
   */
  const pinTab = useCallback((id: number) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== id || t.kind !== "editor") return t;
        const paneTree = updateEditorLeaf(t.paneTree, t.activeLeafId, {
          preview: false,
        });
        return syncEditorMirror({ ...t, paneTree });
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
        if (x.kind === "terminal") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.cwd !== undefined && { cwd: patch.cwd }),
          };
        }
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
        // editor tab: patch the active leaf and auto-promote it from preview
        // the moment the file becomes dirty.
        const leaf = findEditorLeaf(x.paneTree, x.activeLeafId);
        if (!leaf) return x;
        const leafPatch: Partial<{ path: string; dirty: boolean; preview: boolean }> = {};
        if (patch.dirty !== undefined) {
          leafPatch.dirty = patch.dirty;
          if (patch.dirty === true && leaf.preview) leafPatch.preview = false;
        }
        if (patch.path !== undefined) leafPatch.path = patch.path;
        const paneTree =
          Object.keys(leafPatch).length > 0
            ? updateEditorLeaf(x.paneTree, x.activeLeafId, leafPatch)
            : x.paneTree;
        return syncEditorMirror({
          ...x,
          paneTree,
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

  /**
   * Set the dirty flag for a specific editor leaf. Auto-promotes the leaf out
   * of preview mode if it becomes dirty (matches single-pane behavior).
   */
  const setEditorLeafDirty = useCallback((leafId: number, dirty: boolean) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "editor") return t;
        if (!hasEditorLeaf(t.paneTree, leafId)) return t;
        const leaf = findEditorLeaf(t.paneTree, leafId);
        if (!leaf) return t;
        const patch: Partial<{ dirty: boolean; preview: boolean }> = { dirty };
        if (dirty && leaf.preview) patch.preview = false;
        const paneTree = updateEditorLeaf(t.paneTree, leafId, patch);
        return syncEditorMirror({ ...t, paneTree });
      }),
    );
  }, []);

  /** Set the file path for a specific editor leaf (used on rename). */
  const setEditorLeafPath = useCallback((leafId: number, path: string) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "editor") return t;
        if (!hasEditorLeaf(t.paneTree, leafId)) return t;
        const paneTree = updateEditorLeaf(t.paneTree, leafId, { path });
        return syncEditorMirror({ ...t, paneTree });
      }),
    );
  }, []);

  /** Update a leaf's cwd; mirror to the tab's `cwd` when the leaf is active. */
  const setLeafCwd = useCallback((leafId: number, cwd: string) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "terminal") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = setLeafCwdInTree(t.paneTree, leafId, cwd);
        const isActive = t.activeLeafId === leafId;
        return { ...t, paneTree, ...(isActive && { cwd }) };
      }),
    );
  }, []);

  const focusPane = useCallback((tabId: number, leafId: number) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== tabId) return t;
        if (t.kind === "terminal") {
          if (!hasLeaf(t.paneTree, leafId)) return t;
          if (t.activeLeafId === leafId) return t;
          return { ...t, activeLeafId: leafId };
        }
        if (t.kind === "editor") {
          if (!hasEditorLeaf(t.paneTree, leafId)) return t;
          if (t.activeLeafId === leafId) return t;
          return syncEditorMirror({ ...t, activeLeafId: leafId });
        }
        return t;
      }),
    );
  }, []);

  const focusNextPaneInTab = useCallback(
    (tabId: number, delta: 1 | -1) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId) return t;
          if (t.kind === "terminal") {
            const next = nextLeafId(t.paneTree, t.activeLeafId, delta);
            if (next === t.activeLeafId) return t;
            return { ...t, activeLeafId: next };
          }
          if (t.kind === "editor") {
            const next = nextEditorLeafId(t.paneTree, t.activeLeafId, delta);
            if (next === t.activeLeafId) return t;
            return syncEditorMirror({ ...t, activeLeafId: next });
          }
          return t;
        }),
      );
    },
    [],
  );

  /**
   * Split the active leaf of `tabId` along `dir`. Works for both terminal and
   * editor tabs. For editors, the new pane opens with the same file as the
   * active leaf (mirrors VSCode's "Split Editor"). Returns the new leaf id.
   */
  const splitActivePane = useCallback(
    (tabId: number, dir: SplitDir | EditorSplitDir): number | null => {
      let newLeafId: number | null = null;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId) return t;
          if (t.kind === "terminal") {
            if (leafIds(t.paneTree).length >= MAX_PANES_PER_TAB) return t;
            const splitId = nextIdRef.current++;
            const leafId = nextIdRef.current++;
            newLeafId = leafId;
            const paneTree = splitLeaf(
              t.paneTree,
              t.activeLeafId,
              splitId,
              leafId,
              dir as SplitDir,
              t.cwd,
            );
            return { ...t, paneTree, activeLeafId: leafId };
          }
          if (t.kind === "editor") {
            if (editorLeafIds(t.paneTree).length >= MAX_PANES_PER_TAB) return t;
            const active = findEditorLeaf(t.paneTree, t.activeLeafId);
            if (!active) return t;
            const splitId = nextIdRef.current++;
            const leafId = nextIdRef.current++;
            newLeafId = leafId;
            // New pane mirrors the active file but starts non-preview/non-dirty.
            const paneTree = splitEditorLeaf(
              t.paneTree,
              t.activeLeafId,
              splitId,
              leafId,
              dir as EditorSplitDir,
              { path: active.path, dirty: false, preview: false },
            );
            return syncEditorMirror({
              ...t,
              paneTree,
              activeLeafId: leafId,
            });
          }
          return t;
        }),
      );
      return newLeafId;
    },
    [],
  );

  const closePaneByLeaf = useCallback((leafId: number): void => {
    setTabs((curr) => {
      // Try terminal tabs first.
      const tterm = curr.find(
        (t) => t.kind === "terminal" && hasLeaf(t.paneTree, leafId),
      );
      if (tterm && tterm.kind === "terminal") {
        const newTree = removeLeaf(tterm.paneTree, leafId);
        if (newTree === null) {
          if (curr.length <= 1) return curr;
          const idx = curr.findIndex((x) => x.id === tterm.id);
          const next = curr.filter((x) => x.id !== tterm.id);
          setActiveId((active) =>
            active === tterm.id ? next[Math.max(0, idx - 1)].id : active,
          );
          return next;
        }
        const remaining = leafIds(newTree);
        let newActive = tterm.activeLeafId;
        if (tterm.activeLeafId === leafId) {
          const sib = siblingLeafOf(tterm.paneTree, leafId);
          newActive = sib && remaining.includes(sib) ? sib : remaining[0];
        }
        return curr.map((x) => {
          if (x.id !== tterm.id) return x;
          if (x.kind !== "terminal") return x;
          return { ...x, paneTree: newTree, activeLeafId: newActive };
        });
      }
      // Then editor tabs.
      const tedit = curr.find(
        (t) => t.kind === "editor" && hasEditorLeaf(t.paneTree, leafId),
      );
      if (tedit && tedit.kind === "editor") {
        const newTree = removeEditorLeaf(tedit.paneTree, leafId);
        if (newTree === null) {
          if (curr.length <= 1) return curr;
          const idx = curr.findIndex((x) => x.id === tedit.id);
          const next = curr.filter((x) => x.id !== tedit.id);
          setActiveId((active) =>
            active === tedit.id ? next[Math.max(0, idx - 1)].id : active,
          );
          return next;
        }
        const remaining = editorLeafIds(newTree);
        let newActive = tedit.activeLeafId;
        if (tedit.activeLeafId === leafId) {
          const sib = editorSiblingLeafOf(tedit.paneTree, leafId);
          newActive = sib && remaining.includes(sib) ? sib : remaining[0];
        }
        return curr.map((x) => {
          if (x.id !== tedit.id) return x;
          if (x.kind !== "editor") return x;
          return syncEditorMirror({
            ...x,
            paneTree: newTree,
            activeLeafId: newActive,
          });
        });
      }
      return curr;
    });
  }, []);

  const closeActivePane = useCallback((tabId: number): boolean => {
    let closedTab = false;
    setTabs((curr) => {
      const t = curr.find((x) => x.id === tabId);
      if (!t) return curr;
      if (t.kind === "terminal") {
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
          if (x.id !== tabId) return x;
          if (x.kind !== "terminal") return x;
          return { ...x, paneTree: newTree, activeLeafId: newActive };
        });
      }
      if (t.kind === "editor") {
        const target = t.activeLeafId;
        const newTree = removeEditorLeaf(t.paneTree, target);
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
        const remaining = editorLeafIds(newTree);
        const sib = editorSiblingLeafOf(t.paneTree, target);
        const newActive =
          sib && remaining.includes(sib) ? sib : remaining[0];
        return curr.map((x) => {
          if (x.id !== tabId) return x;
          if (x.kind !== "editor") return x;
          return syncEditorMirror({
            ...x,
            paneTree: newTree,
            activeLeafId: newActive,
          });
        });
      }
      return curr;
    });
    return closedTab;
  }, []);

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
  };
}
