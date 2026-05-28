import { useCallback, useRef, useState } from "react";
import {
  findLeaf,
  hasLeaf,
  leafIds,
  leaves,
  nextLeafId,
  normalizePaneTree,
  removeLeaf,
  reorderLeafInTree,
  rotateLeafWithNeighbor,
  setLeafCwd as setLeafCwdInTree,
  setLeafPrivate as setLeafPrivateInTree,
  setLeafPtyId as setLeafPtyIdInTree,
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

// Browsers cap WebGL contexts at ~16. One xterm renderer per terminal leaf.
// 6 panes per tab leaves headroom for multiple tabs.
export const MAX_PANES_PER_TAB = 6;

/**
 * A pane tab holds a tmux-style pane tree of terminal or editor leaves.
 * Splitting (Ctrl+D / Ctrl+Shift+D) adds a new leaf next to the focused one.
 * Trees can mix horizontal and vertical orientations.
 * `title` / `cwd` / `path` / `dirty` / `preview` mirror the active leaf and
 * resync whenever the tree or active leaf changes.
 */
export type PaneTab = {
  id: number;
  kind: "pane";
  title: string;
  paneTree: PaneNode;
  activeLeafId: number;
  // Mirrors of the active leaf, populated by `syncPaneMirror`.
  cwd?: string;
  path?: string;
  dirty?: boolean;
  preview?: boolean;
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
  originalContent: string;
  proposedContent: string;
  approvalId: string;
  status: AiDiffStatus;
  isNewFile: boolean;
};

export type GitChangeStatusTab =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "ignored";

export type GitDiffTab = {
  id: number;
  kind: "git-diff";
  title: string;
  /** Absolute working-tree path. */
  path: string;
  /** Repo-relative forward-slash path. */
  relative: string;
  /** Absolute repo root. */
  repoPath: string;
  changeStatus: GitChangeStatusTab;
  /** Bumps on Refresh so the pane re-reads HEAD and working tree. */
  reloadKey: number;
};

/**
 * Lifecycle hint an extension can attach to its tab so the title text
 * colour reflects connection / job state. Mirrors the SSH tab palette so
 * "remote-ish" extensions read consistently next to terminal tabs:
 * `connecting`/`reconnecting` → pulsing yellow, `connected` → green,
 * `disconnected`/`error` → red, `idle`/undefined → default.
 */
export type ExtensionTabState =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "disconnected"
  | "error";

/**
 * Extension-owned tab. The content is mounted by `ExtensionTabStack`
 * which calls the renderer registered by `ctx.registerPanelRenderer`.
 * Opened via `ctx.tabs.openExtensionTab({ extensionId, panelId, title })`.
 */
export type ExtensionTab = {
  id: number;
  kind: "ext";
  title: string;
  extensionId: string;
  panelId: string;
  /** Optional icon path relative to the extension root (or `data:` URL). */
  icon?: string;
  /** Caller-supplied stable id for dedup (so re-opening focuses the
   *  existing tab instead of pushing a new one). */
  reuseKey?: string;
  /** Optional lifecycle tone for the tab title text. Updated by the
   *  extension via `ctx.tabs.setExtensionTabState(...)`. */
  state?: ExtensionTabState;
};

export type Tab = PaneTab | PreviewTab | AiDiffTab | GitDiffTab | ExtensionTab;

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

/** Helpers for discriminating on the active leaf kind. */
export function activeLeaf(tab: Tab): PaneLeaf | null {
  if (tab.kind !== "pane") return null;
  return findLeaf(tab.paneTree, tab.activeLeafId);
}

export function activeLeafKind(tab: Tab): "terminal" | "editor" | null {
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
      terminalOrdinal: 1,
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
  // Sync ref of `tabs` so callbacks can read the latest array without relying
  // on React's eager state computation (skipped when the fiber already has
  // other pending updates). Used by `openExtensionTab` for reuse detection.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Monotonic FIFO counter for the terminal chip number. New terminals from
  // any path pick the next unused integer. Drag/reorder doesn't bump this;
  // the ordinal belongs to the leaf, not its position.
  const nextOrdinalRef = useRef(2);

  /** Highest `terminalOrdinal` currently in use. */
  const peekMaxOrdinal = useCallback((curr: Tab[]): number => {
    let max = 0;
    for (const t of curr) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind === "terminal" && typeof l.terminalOrdinal === "number") {
          if (l.terminalOrdinal > max) max = l.terminalOrdinal;
        }
      }
    }
    return max;
  }, []);

  /** Returns the next ordinal and advances the counter. */
  const allocOrdinal = useCallback(
    (curr: Tab[]): number => {
      const max = Math.max(nextOrdinalRef.current - 1, peekMaxOrdinal(curr));
      const ord = max + 1;
      nextOrdinalRef.current = ord + 1;
      return ord;
    },
    [peekMaxOrdinal],
  );

  const newTab = useCallback(
    (cwd?: string, opts?: { private?: boolean }) => {
      const tabId = nextIdRef.current++;
      const leafId = nextIdRef.current++;
      setTabs((curr) => {
        const leaf: PaneLeaf = {
          kind: "leaf",
          id: leafId,
          leafKind: "terminal",
          cwd,
          terminalOrdinal: allocOrdinal(curr),
          ...(opts?.private ? { private: true } : {}),
        };
        return [
          ...curr,
          syncPaneMirror({
            id: tabId,
            kind: "pane",
            title: "shell",
            paneTree: leaf,
            activeLeafId: leafId,
          }),
        ];
      });
      setActiveId(tabId);
      return tabId;
    },
    [allocOrdinal],
  );

  /** Open a tab whose initial terminal leaf is bound to a saved SSH connection. Routes through `ssh_open`. */
  const newSshTab = useCallback(
    (sshConnectionId: string, title: string, opts?: { private?: boolean }) => {
      const tabId = nextIdRef.current++;
      const leafId = nextIdRef.current++;
      setTabs((curr) => {
        const leaf: PaneLeaf = {
          kind: "leaf",
          id: leafId,
          leafKind: "terminal",
          sshConnectionId,
          terminalOrdinal: allocOrdinal(curr),
          ...(opts?.private ? { private: true } : {}),
        };
        return [
          ...curr,
          syncPaneMirror({
            id: tabId,
            kind: "pane",
            title,
            paneTree: leaf,
            activeLeafId: leafId,
          }),
        ];
      });
      setActiveId(tabId);
      return tabId;
    },
    [allocOrdinal],
  );

  /**
   * Flip the per-leaf privacy flag. Each entry in the tab strip toggles
   * independently - a split group can mix private and public terminals.
   * The AI subsystem ignores private leaves entirely.
   */
  const togglePrivate = useCallback((leafId: number) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "pane") return t;
        const leaf = findLeaf(t.paneTree, leafId);
        if (!leaf) return t;
        const nextValue = !leaf.private;
        const paneTree = setLeafPrivateInTree(t.paneTree, leafId, nextValue);
        if (paneTree === t.paneTree) return t;
        return syncPaneMirror({ ...t, paneTree });
      }),
    );
  }, []);

  /** Find a pane tab with an editor leaf matching `predicate`. Used by openFileTab for dedup. */
  const findEditorLeafIn = useCallback(
    (
      curr: Tab[],
      path: string,
      predicate: (l: PaneLeaf & EditorLeafState) => boolean = () => true,
      sshSessionId?: number,
    ): { tab: PaneTab; leaf: PaneLeaf & EditorLeafState } | null => {
      for (const t of curr) {
        if (t.kind !== "pane") continue;
        for (const l of leaves(t.paneTree)) {
          if (l.leafKind !== "editor") continue;
          if (l.path !== path) continue;
          // Same path on different sessions (or local vs remote) is a different file. Only dedup when session matches.
          if ((l.sshSessionId ?? null) !== (sshSessionId ?? null)) continue;
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
   * `pin = true`: persistent. Reuses an existing leaf (promoting from preview if needed) or creates a new tab.
   * `pin = false`: VSCode-style preview slot.
   */
  const openFileTab = useCallback(
    (
      path: string,
      pin = true,
      remote?: { sshSessionId: number; sshHostLabel: string },
    ) => {
      let targetTabId: number | null = null;
      setTabs((curr) => {
        if (pin) {
          const hit = findEditorLeafIn(curr, path, undefined, remote?.sshSessionId);
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
            ...(remote && {
              sshSessionId: remote.sshSessionId,
              sshHostLabel: remote.sshHostLabel,
            }),
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
        const persistent = findEditorLeafIn(
          curr,
          path,
          (l) => !l.preview,
          remote?.sshSessionId,
        );
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
        const existingPreview = findEditorLeafIn(
          curr,
          path,
          (l) => l.preview,
          remote?.sshSessionId,
        );
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
          ...(remote && {
            sshSessionId: remote.sshSessionId,
            sshHostLabel: remote.sshHostLabel,
          }),
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
    },
    [findEditorLeafIn],
  );

  /** Promote the active leaf of `id` out of preview. */
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

  const setAiDiffStatus = useCallback((approvalId: string, status: AiDiffStatus) => {
    setTabs((curr) =>
      curr.map((t) => (t.kind === "ai-diff" && t.approvalId === approvalId ? { ...t, status } : t)),
    );
  }, []);

  const openGitDiffTab = useCallback(
    (input: {
      path: string;
      relative: string;
      repoPath: string;
      changeStatus: GitChangeStatusTab;
    }) => {
      let targetId: number | null = null;
      setTabs((curr) => {
        const existing = curr.find(
          (t) =>
            t.kind === "git-diff" && t.relative === input.relative && t.repoPath === input.repoPath,
        );
        if (existing) {
          // Bump reloadKey so the pane re-reads HEAD and working tree.
          targetId = existing.id;
          return curr.map((t) =>
            t.id === existing.id && t.kind === "git-diff"
              ? {
                  ...t,
                  reloadKey: t.reloadKey + 1,
                  changeStatus: input.changeStatus,
                }
              : t,
          );
        }
        const id = nextIdRef.current++;
        targetId = id;
        const title = `${basename(input.path)} (diff)`;
        return [
          ...curr,
          {
            id,
            kind: "git-diff",
            title,
            path: input.path,
            relative: input.relative,
            repoPath: input.repoPath,
            changeStatus: input.changeStatus,
            reloadKey: 0,
          },
        ];
      });
      if (targetId !== null) setActiveId(targetId);
      return targetId as number | null;
    },
    [],
  );

  const newPreviewTab = useCallback((url: string) => {
    const id = nextIdRef.current++;
    setTabs((t) => [...t, { id, kind: "preview", title: titleFromUrl(url), url }]);
    setActiveId(id);
    return id;
  }, []);

  /**
   * Open (or focus) an extension-owned tab. Caller passes a `reuseKey` to
   * dedupe; if a tab with the same `(extensionId, panelId, reuseKey)`
   * already exists, we activate it instead of pushing a new one. The
   * extension's panel renderer (registered via `ctx.registerPanelRenderer`)
   * is mounted by `ExtensionTabStack`.
   *
   * Reuse detection + id allocation runs against `tabsRef.current` (not
   * inside the `setTabs` updater) so `setActiveId(id)` always receives a
   * concrete value. Mutating a closure variable from inside the updater
   * only works when React performs eager state computation; callers that
   * schedule unrelated state updates first (e.g. SQL Explorer hiding both
   * sidebars before opening its tab) force React to defer the updater,
   * and the active-id then stays on the previous tab.
   */
  const openExtensionTab = useCallback(
    (opts: {
      extensionId: string;
      panelId: string;
      title: string;
      icon?: string;
      reuseKey?: string;
    }) => {
      const reuse = opts.reuseKey
        ? tabsRef.current.find(
            (t) =>
              t.kind === "ext" &&
              t.extensionId === opts.extensionId &&
              t.panelId === opts.panelId &&
              t.reuseKey === opts.reuseKey,
          )
        : null;
      if (reuse) {
        setActiveId(reuse.id);
        return reuse.id;
      }
      const id = nextIdRef.current++;
      setTabs((curr) => [
        ...curr,
        {
          id,
          kind: "ext",
          title: opts.title,
          extensionId: opts.extensionId,
          panelId: opts.panelId,
          icon: opts.icon,
          reuseKey: opts.reuseKey,
        } satisfies ExtensionTab,
      ]);
      setActiveId(id);
      return id;
    },
    [],
  );

  /**
   * Update the lifecycle tone on an extension tab. Matches the tab on
   * `(extensionId, panelId, reuseKey)`; `reuseKey` is optional and matches
   * tabs opened without one when omitted. Pass `null` for `state` to clear.
   */
  const setExtensionTabState = useCallback(
    (opts: {
      extensionId: string;
      panelId: string;
      reuseKey?: string;
      state: ExtensionTabState | null;
    }) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.kind !== "ext") return t;
          if (t.extensionId !== opts.extensionId) return t;
          if (t.panelId !== opts.panelId) return t;
          if ((t.reuseKey ?? undefined) !== (opts.reuseKey ?? undefined)) return t;
          const next: ExtensionTab = { ...t };
          if (opts.state === null) {
            delete next.state;
          } else {
            next.state = opts.state;
          }
          return next;
        }),
      );
    },
    [],
  );

  const closeTab = useCallback((id: number) => {
    setTabs((curr) => {
      if (curr.length <= 1) return curr;
      const idx = curr.findIndex((t) => t.id === id);
      const next = curr.filter((t) => t.id !== id);
      setActiveId((active) => (id === active ? next[Math.max(0, idx - 1)].id : active));
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
        if (x.kind === "git-diff") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
            ...(patch.path !== undefined && { path: patch.path }),
          };
        }
        if (x.kind === "ext") {
          return {
            ...x,
            ...(patch.title !== undefined && { title: patch.title }),
          };
        }

        // pane tab: patches apply to the active leaf.
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

  /** Update a terminal leaf's cwd. Mirrors to the tab when the leaf is active. */
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

  /**
   * Stamp the daemon-side PTY UUID returned by `pty_open` / `pty_attach`
   * onto a terminal leaf so the workspace serializer can persist it.
   * Clears any `savedPtyId` set by the restore path - the leaf is now
   * authoritative and a manual respawn must spawn fresh, not re-attach.
   */
  const setLeafPtyId = useCallback((leafId: number, ptyId: string) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "pane") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = setLeafPtyIdInTree(t.paneTree, leafId, ptyId);
        if (paneTree === t.paneTree) return t;
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

  const focusNextPaneInTab = useCallback((tabId: number, delta: 1 | -1) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.id !== tabId || t.kind !== "pane") return t;
        const next = nextLeafId(t.paneTree, t.activeLeafId, delta);
        if (next === t.activeLeafId) return t;
        return syncPaneMirror({ ...t, activeLeafId: next });
      }),
    );
  }, []);

  /**
   * Split the active leaf of `tabId` along `dir`. New leaf defaults to a
   * terminal regardless of the active leaf, so Ctrl+D from an editor still
   * spawns a shell. Pass `newKind = "editor"` for side-by-side code.
   * All combinations (terminal/editor, editor/editor) are allowed.
   */
  const splitActivePane = useCallback(
    (
      tabId: number,
      dir: SplitDir,
      newKind?: "terminal" | "editor",
      cwdOverride?: string,
    ): number | null => {
      let newLeafId: number | null = null;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.id !== tabId || t.kind !== "pane") return t;
          if (leafIds(t.paneTree).length >= MAX_PANES_PER_TAB) return t;
          const active = findLeaf(t.paneTree, t.activeLeafId);
          if (!active) return t;

          // Default to terminal so Ctrl+D from an editor still produces a shell.
          const kind: "terminal" | "editor" = newKind ?? "terminal";

          const splitId = nextIdRef.current++;
          const leafId = nextIdRef.current++;
          newLeafId = leafId;
          let state: LeafState;
          if (kind === "terminal") {
            // Caller-supplied cwd wins; falls back to focused terminal's cwd, then tab mirror.
            const cwd = cwdOverride ?? (active.leafKind === "terminal" ? active.cwd : t.cwd);
            const ts: TerminalLeafState = {
              leafKind: "terminal",
              cwd,
              terminalOrdinal: allocOrdinal(curr),
            };
            state = ts;
          } else {
            // Duplicate the active editor's path; fall back to any editor in the tab.
            // No editor in the tab means no path to clone, so the split is a no-op.
            const sourcePath =
              active.leafKind === "editor"
                ? active.path
                : leaves(t.paneTree).find(
                    (l): l is PaneLeaf & EditorLeafState => l.leafKind === "editor",
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
          const paneTree = splitLeaf(t.paneTree, t.activeLeafId, splitId, leafId, dir, state);
          return syncPaneMirror({ ...t, paneTree, activeLeafId: leafId });
        }),
      );
      return newLeafId;
    },
    [allocOrdinal],
  );

  const closePaneByLeaf = useCallback((leafId: number): void => {
    setTabs((curr) => {
      const tab = curr.find((t) => t.kind === "pane" && hasLeaf(t.paneTree, leafId));
      if (!tab || tab.kind !== "pane") return curr;
      const newTree = removeLeaf(tab.paneTree, leafId);
      if (newTree === null) {
        if (curr.length <= 1) return curr;
        const idx = curr.findIndex((x) => x.id === tab.id);
        const next = curr.filter((x) => x.id !== tab.id);
        setActiveId((active) => (active === tab.id ? next[Math.max(0, idx - 1)].id : active));
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
        setActiveId((active) => (active === tabId ? next[Math.max(0, idx - 1)].id : active));
        closedTab = true;
        return next;
      }
      const remaining = leafIds(newTree);
      const sib = siblingLeafOf(t.paneTree, target);
      const newActive = sib && remaining.includes(sib) ? sib : remaining[0];
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
   * Workspace switch. Replaces the tab list and active id atomically,
   * rebases `nextIdRef`, and backfills `terminalOrdinal` on legacy leaves
   * in tab/tree order so older state numbers like a fresh creation.
   */
  const replaceAllTabs = useCallback((nextTabs: Tab[], nextActiveId: number | null) => {
    let maxId = 0;
    let maxOrdinal = 0;
    for (const t of nextTabs) {
      if (t.id > maxId) maxId = t.id;
      if (t.kind === "pane") {
        for (const l of leaves(t.paneTree)) {
          if (l.id > maxId) maxId = l.id;
          if (l.leafKind === "terminal" && typeof l.terminalOrdinal === "number") {
            if (l.terminalOrdinal > maxOrdinal) maxOrdinal = l.terminalOrdinal;
          }
        }
      }
    }
    let nextOrdinal = maxOrdinal + 1;
    const stamp = (node: PaneNode): PaneNode => {
      if (node.kind === "leaf") {
        if (node.leafKind === "terminal" && node.terminalOrdinal == null) {
          return { ...node, terminalOrdinal: nextOrdinal++ };
        }
        return node;
      }
      return { ...node, children: node.children.map(stamp) };
    };
    const stamped = nextTabs.map((t) =>
      t.kind === "pane" ? syncPaneMirror({ ...t, paneTree: stamp(t.paneTree) }) : t,
    );
    setTabs(stamped);
    if (nextActiveId !== null) setActiveId(nextActiveId);
    nextIdRef.current = Math.max(nextIdRef.current, maxId + 1);
    nextOrdinalRef.current = nextOrdinal;
  }, []);

  /** Allocate a fresh id from the same counter as tabs and leaves. */
  const allocId = useCallback(() => nextIdRef.current++, []);

  /**
   * Move a leaf into `targetTabId` as a horizontal split. Preserves the
   * leaf id so PTY/editor session stays attached. Drops the source tab if
   * it ends up empty.
   * Returns `"ok"`, `"full"` (target at `MAX_PANES_PER_TAB`), or
   * `"invalid"` (not found, source = target, target isn't a pane tab).
   */
  const moveLeafToTab = useCallback(
    (leafId: number, targetTabId: number): "ok" | "full" | "invalid" => {
      type MoveResult = "ok" | "full" | "invalid";
      // Cast so TS doesn't narrow `result` to literal `"invalid"`. The setTabs
      // callback mutates it via closure, which CFA can't see.
      let result = "invalid" as MoveResult;
      setTabs((curr) => {
        const source = curr.find(
          (t): t is PaneTab => t.kind === "pane" && hasLeaf(t.paneTree, leafId),
        );
        if (!source) return curr;
        if (source.id === targetTabId) return curr;
        const target = curr.find((t): t is PaneTab => t.kind === "pane" && t.id === targetTabId);
        if (!target) return curr;
        if (leafIds(target.paneTree).length >= MAX_PANES_PER_TAB) {
          result = "full";
          return curr;
        }
        const leaf = findLeaf(source.paneTree, leafId);
        if (!leaf) return curr;
        // Reuse the leaf's state verbatim so cwd, sshConnectionId, ordinal,
        // dirty, and preview travel with it. Leaf id is preserved so App.tsx's
        // per-leaf refs keep their mapping.
        const state: LeafState =
          leaf.leafKind === "terminal"
            ? {
                leafKind: "terminal",
                cwd: leaf.cwd,
                sshConnectionId: leaf.sshConnectionId,
                terminalOrdinal: leaf.terminalOrdinal,
                ...(leaf.private ? { private: true } : {}),
              }
            : {
                leafKind: "editor",
                path: leaf.path,
                dirty: leaf.dirty,
                preview: leaf.preview,
                sshSessionId: leaf.sshSessionId,
                sshHostLabel: leaf.sshHostLabel,
                ...(leaf.private ? { private: true } : {}),
              };
        const newSourceTree = removeLeaf(source.paneTree, leafId);
        const splitId = nextIdRef.current++;
        const newTargetTree = splitLeaf(
          target.paneTree,
          target.activeLeafId,
          splitId,
          leafId,
          "row",
          state,
        );
        result = "ok";
        const next: Tab[] = [];
        for (const t of curr) {
          if (t.kind !== "pane") {
            next.push(t);
            continue;
          }
          if (t.id === source.id) {
            // Source emptied: drop the tab.
            if (newSourceTree === null) continue;
            const remaining = leafIds(newSourceTree);
            let newActive = t.activeLeafId;
            if (t.activeLeafId === leafId) {
              const sib = siblingLeafOf(t.paneTree, leafId);
              newActive = sib && remaining.includes(sib) ? sib : remaining[0];
            }
            next.push(
              syncPaneMirror({
                ...t,
                paneTree: newSourceTree,
                activeLeafId: newActive,
              }),
            );
            continue;
          }
          if (t.id === targetTabId) {
            next.push(
              syncPaneMirror({
                ...t,
                paneTree: newTargetTree,
                activeLeafId: leafId,
              }),
            );
            continue;
          }
          next.push(t);
        }
        return next;
      });
      // Focus the destination so the moved leaf lands in view.
      if (result === "ok") setActiveId(targetTabId);
      return result;
    },
    [],
  );

  /**
   * Extract a leaf into a new top-level pane tab. Preserves leaf id and
   * state so the underlying session survives. Returns `"invalid"` when
   * `leafId` isn't inside a multi-leaf split, `"ok"` on success.
   */
  const moveLeafToNewTab = useCallback((leafId: number): "ok" | "invalid" => {
    type MoveResult = "ok" | "invalid";
    let result = "invalid" as MoveResult;
    let newTabId: number | null = null;
    setTabs((curr) => {
      const source = curr.find(
        (t): t is PaneTab => t.kind === "pane" && hasLeaf(t.paneTree, leafId),
      );
      if (!source) return curr;
      // Only meaningful for split tabs. Single-leaf extract would just rename and waste an id.
      const sourceLeafIds = leafIds(source.paneTree);
      if (sourceLeafIds.length < 2) return curr;
      const leaf = findLeaf(source.paneTree, leafId);
      if (!leaf) return curr;
      const state: LeafState =
        leaf.leafKind === "terminal"
          ? {
              leafKind: "terminal",
              cwd: leaf.cwd,
              sshConnectionId: leaf.sshConnectionId,
              terminalOrdinal: leaf.terminalOrdinal,
              ...(leaf.private ? { private: true } : {}),
            }
          : {
              leafKind: "editor",
              path: leaf.path,
              dirty: leaf.dirty,
              preview: leaf.preview,
              sshSessionId: leaf.sshSessionId,
              sshHostLabel: leaf.sshHostLabel,
              ...(leaf.private ? { private: true } : {}),
            };
      const newSourceTree = removeLeaf(source.paneTree, leafId);
      // Source has 2+ leaves so removing one leaves something. Guard anyway.
      if (newSourceTree === null) return curr;
      const tabId = nextIdRef.current++;
      const newLeaf: PaneLeaf = {
        kind: "leaf",
        id: leafId,
        ...state,
      };
      const remaining = leafIds(newSourceTree);
      let sourceActive = source.activeLeafId;
      if (source.activeLeafId === leafId) {
        const sib = siblingLeafOf(source.paneTree, leafId);
        sourceActive = sib && remaining.includes(sib) ? sib : remaining[0];
      }
      result = "ok";
      newTabId = tabId;
      const next: Tab[] = [];
      for (const t of curr) {
        next.push(t);
        if (t.id === source.id) {
          next[next.length - 1] = syncPaneMirror({
            ...source,
            paneTree: newSourceTree,
            activeLeafId: sourceActive,
          });
          // Insert the new tab right after the source so the user can track the move.
          next.push(
            syncPaneMirror({
              id: tabId,
              kind: "pane",
              title: source.title,
              paneTree: newLeaf,
              activeLeafId: leafId,
            }),
          );
        }
      }
      return next;
    });
    if (result === "ok" && newTabId !== null) setActiveId(newTabId);
    return result;
  }, []);

  /**
   * Rotate `leafId` by pairing it with its immediate sibling in a sub-split
   * of the opposite direction. Other siblings stay put, so rotating B in
   * `[A, B, C]` affects only B and C. The tree is normalized afterwards
   * so a second click cleanly undoes the change.
   */
  const rotateLeafSplit = useCallback((leafId: number) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "pane") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        const splitId = nextIdRef.current++;
        const rotated = rotateLeafWithNeighbor(t.paneTree, leafId, splitId);
        if (rotated === null) return t;
        return syncPaneMirror({
          ...t,
          paneTree: normalizePaneTree(rotated),
        });
      }),
    );
  }, []);

  /**
   * Reorder a leaf within its own split group. Places `leafId` before
   * `beforeLeafId`, or at the end when null. No-op when the two leaves
   * aren't direct siblings. Use Move to New Tab / Join Group for cross-group.
   */
  const reorderLeafInGroup = useCallback(
    (leafId: number, beforeLeafId: number | null) => {
      setTabs((curr) =>
        curr.map((t) => {
          if (t.kind !== "pane") return t;
          if (!hasLeaf(t.paneTree, leafId)) return t;
          const paneTree = reorderLeafInTree(t.paneTree, leafId, beforeLeafId);
          if (paneTree === t.paneTree) return t;
          return syncPaneMirror({ ...t, paneTree });
        }),
      );
    },
    [],
  );

  /** Reorder tabs: move `fromTabId` before `beforeTabId`, or append when null. */
  const reorderTabs = useCallback((fromTabId: number, beforeTabId: number | null) => {
    setTabs((curr) => {
      const from = curr.find((t) => t.id === fromTabId);
      if (!from) return curr;
      const others = curr.filter((t) => t.id !== fromTabId);
      if (beforeTabId === null) return [...others, from];
      const idx = others.findIndex((t) => t.id === beforeTabId);
      if (idx < 0) return [...others, from];
      const result = [...others];
      result.splice(idx, 0, from);
      return result;
    });
  }, []);

  return {
    tabs,
    activeId,
    setActiveId,
    newTab,
    newSshTab,
    openFileTab,
    pinTab,
    newPreviewTab,
    openExtensionTab,
    setExtensionTabState,
    openAiDiffTab,
    setAiDiffStatus,
    openGitDiffTab,
    closeTab,
    updateTab,
    selectByIndex,
    setLeafCwd,
    setLeafPtyId,
    setEditorLeafDirty,
    setEditorLeafPath,
    focusPane,
    focusNextPaneInTab,
    splitActivePane,
    closeActivePane,
    closePaneByLeaf,
    moveLeafToTab,
    moveLeafToNewTab,
    rotateLeafSplit,
    replaceAllTabs,
    allocId,
    reorderTabs,
    reorderLeafInGroup,
    togglePrivate,
  };
}
