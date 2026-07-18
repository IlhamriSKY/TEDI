import { useCallback, useRef, useState } from "react";
import { basename } from "@/lib/path";
import {
  cloneLeafState,
  findLeaf,
  hasLeaf,
  leafIds,
  leaves,
  movePaneLeafToEdge as movePaneLeafToEdgeInTree,
  nextLeafId,
  normalizePaneTree,
  removeLeaf,
  reorderLeafInTree,
  rotateLeafWithNeighbor,
  setLeafCwd as setLeafCwdInTree,
  setLeafPrivate as setLeafPrivateInTree,
  setLeafPtyId as setLeafPtyIdInTree,
  setLeafTerminalTheme as setLeafTerminalThemeInTree,
  siblingLeafOf,
  splitLeaf,
  updateEditorLeaf,
  type EditorLeafState,
  type LeafState,
  type PaneEdge,
  type PaneLeaf,
  type PaneNode,
  type BrowserLeafState,
  type ExtensionPanelLeafState,
  type SplitDir,
  type TerminalLeafState,
} from "@/modules/terminal/lib/panes";
import { type ExtensionTab, type PaneTab, type Tab } from "./tabTypes";
import { syncPaneMirror } from "./tabHelpers";
import { useAuxTabs } from "./useAuxTabs";

// Re-export the tab types from their new home so existing imports of
// `@/modules/tabs/lib/useTabs` (and the `@/modules/tabs` barrel) keep working.
export type {
  PaneTab,
  AiDiffStatus,
  AiDiffTab,
  GitChangeStatusTab,
  GitDiffTab,
  ScmTab,
  ExtensionTabState,
  ExtensionTab,
  Tab,
} from "./tabTypes";

// Re-export the active-leaf discriminators from their new home so callers that
// import them from this module (or the barrel) are unaffected by the move.
export { activeLeaf, activeLeafKind, isTerminalLikeTab, isEditorLikeTab } from "./tabHelpers";

// Browsers cap WebGL contexts at ~16. One xterm renderer per terminal leaf.
// 6 panes per tab leaves headroom for multiple tabs.
export const MAX_PANES_PER_TAB = 6;

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
  // Monotonic FIFO counter for the browser chip number ("Browser 3"). Its own
  // sequence so browsers number independently of terminals.
  const nextBrowserOrdinalRef = useRef(1);

  // Non-pane tab openers + browser-leaf URL/title updaters. Extracted into a
  // sub-hook for size; the callbacks close over the same setters/refs and are
  // spread into this hook's return object below with identical keys.
  const {
    openAiDiffTab,
    setAiDiffStatus,
    openGitDiffTab,
    openScmTab,
    newBrowserTab,
    openExtensionTab,
    openExtensionPane,
    setExtensionTabState,
    setBrowserLeafUrl,
    setBrowserLeafTitle,
  } = useAuxTabs({ setTabs, setActiveId, nextIdRef, tabsRef, nextBrowserOrdinalRef });

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

  /** Highest `browserOrdinal` currently in use. */
  const peekMaxBrowserOrdinal = useCallback((curr: Tab[]): number => {
    let max = 0;
    for (const t of curr) {
      if (t.kind !== "pane") continue;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind === "browser" && typeof l.browserOrdinal === "number") {
          if (l.browserOrdinal > max) max = l.browserOrdinal;
        }
      }
    }
    return max;
  }, []);

  /** Returns the next browser ordinal and advances the counter. */
  const allocBrowserOrdinal = useCallback(
    (curr: Tab[]): number => {
      const max = Math.max(nextBrowserOrdinalRef.current - 1, peekMaxBrowserOrdinal(curr));
      const ord = max + 1;
      nextBrowserOrdinalRef.current = ord + 1;
      return ord;
    },
    [peekMaxBrowserOrdinal],
  );

  const newTab = useCallback(
    (cwd?: string, opts?: { private?: boolean; savedPtyId?: string }) => {
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
          // Adopt an existing daemon session: the restore path in
          // openPtyForSession sees `savedPtyId` and calls reattachPty instead
          // of spawning a fresh shell. Used by useAdoptDaemonSessions.
          ...(opts?.savedPtyId ? { savedPtyId: opts.savedPtyId } : {}),
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
    (path: string, pin = true, remote?: { sshSessionId: number; sshHostLabel: string }) => {
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
        const persistent = findEditorLeafIn(curr, path, (l) => !l.preview, remote?.sshSessionId);
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

  const closeTab = useCallback((id: number) => {
    setTabs((curr) => {
      if (curr.length <= 1) return curr;
      const idx = curr.findIndex((t) => t.id === id);
      const next = curr.filter((t) => t.id !== id);
      setActiveId((active) => (id === active ? next[Math.max(0, idx - 1)].id : active));
      return next;
    });
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
    setTabs((curr) => {
      // OSC 7 repeats on every prompt (and the SSH bootstrap makes that every
      // remote Enter), so bail when the cwd is unchanged. Without this, `curr.map`
      // allocates a fresh tabs array per prompt, which re-runs every tabs-keyed
      // memo and re-serializes the workspace to disk.
      const owner = curr.find((t) => t.kind === "pane" && hasLeaf(t.paneTree, leafId));
      if (owner?.kind === "pane") {
        const leaf = findLeaf(owner.paneTree, leafId);
        if (leaf?.leafKind === "terminal" && leaf.cwd === cwd) return curr;
      }
      return curr.map((t) => {
        if (t.kind !== "pane") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = setLeafCwdInTree(t.paneTree, leafId, cwd);
        return syncPaneMirror({ ...t, paneTree });
      });
    });
  }, []);

  /**
   * Set (or clear, with `null`) a terminal leaf's per-pane theme override.
   * `themeId` is a `TERMINAL_PRESETS` id. The leaf's `TerminalPane` repaints
   * in that palette; the serializer persists the choice. No-op for non-terminal
   * leaves or when the value is unchanged.
   */
  const setLeafTerminalTheme = useCallback((leafId: number, themeId: string | null) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "pane") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = setLeafTerminalThemeInTree(t.paneTree, leafId, themeId);
        if (paneTree === t.paneTree) return t;
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
      newKind?: "terminal" | "editor" | "browser",
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
          const kind: "terminal" | "editor" | "browser" = newKind ?? "terminal";

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
          } else if (kind === "editor") {
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
          } else {
            // Browser leaf. Starts blank so the address bar shows; a URL can be
            // passed via the override (e.g. "split with this localhost URL").
            const ps: BrowserLeafState = {
              leafKind: "browser",
              url: cwdOverride ?? "",
              browserOrdinal: allocBrowserOrdinal(curr),
            };
            state = ps;
          }
          const paneTree = splitLeaf(t.paneTree, t.activeLeafId, splitId, leafId, dir, state);
          return syncPaneMirror({ ...t, paneTree, activeLeafId: leafId });
        }),
      );
      return newLeafId;
    },
    [allocOrdinal, allocBrowserOrdinal],
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

  /**
   * Workspace switch. Replaces the tab list and active id atomically,
   * rebases `nextIdRef`, and backfills `terminalOrdinal` on legacy leaves
   * in tab/tree order so older state numbers like a fresh creation.
   */
  const replaceAllTabs = useCallback((nextTabs: Tab[], nextActiveId: number | null) => {
    let maxId = 0;
    let maxOrdinal = 0;
    let maxBrowserOrdinal = 0;
    for (const t of nextTabs) {
      if (t.id > maxId) maxId = t.id;
      if (t.kind === "pane") {
        for (const l of leaves(t.paneTree)) {
          if (l.id > maxId) maxId = l.id;
          if (l.leafKind === "terminal" && typeof l.terminalOrdinal === "number") {
            if (l.terminalOrdinal > maxOrdinal) maxOrdinal = l.terminalOrdinal;
          }
          if (l.leafKind === "browser" && typeof l.browserOrdinal === "number") {
            if (l.browserOrdinal > maxBrowserOrdinal) maxBrowserOrdinal = l.browserOrdinal;
          }
        }
      }
    }
    let nextOrdinal = maxOrdinal + 1;
    let nextBrowserOrdinal = maxBrowserOrdinal + 1;
    const stamp = (node: PaneNode): PaneNode => {
      if (node.kind === "leaf") {
        if (node.leafKind === "terminal" && node.terminalOrdinal == null) {
          return { ...node, terminalOrdinal: nextOrdinal++ };
        }
        if (node.leafKind === "browser" && node.browserOrdinal == null) {
          return { ...node, browserOrdinal: nextBrowserOrdinal++ };
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
    nextBrowserOrdinalRef.current = nextBrowserOrdinal;
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
        const state: LeafState = cloneLeafState(leaf);
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
      const state: LeafState = cloneLeafState(leaf);
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
  const reorderLeafInGroup = useCallback((leafId: number, beforeLeafId: number | null) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "pane") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = reorderLeafInTree(t.paneTree, leafId, beforeLeafId);
        if (paneTree === t.paneTree) return t;
        return syncPaneMirror({ ...t, paneTree });
      }),
    );
  }, []);

  /**
   * Drag-and-drop a leaf onto one edge of another leaf in the same tab.
   * Repositions the source as a left/right/top/bottom sibling of the target,
   * preserving its id (and thus its PTY / editor session). No-op across tabs
   * or when the move can't apply.
   */
  const movePaneLeafToEdge = useCallback(
    (sourceLeafId: number, targetLeafId: number, edge: PaneEdge) => {
      if (sourceLeafId === targetLeafId) return;
      setTabs((curr) =>
        curr.map((t) => {
          if (t.kind !== "pane") return t;
          if (!hasLeaf(t.paneTree, sourceLeafId) || !hasLeaf(t.paneTree, targetLeafId)) return t;
          const splitId = nextIdRef.current++;
          const moved = movePaneLeafToEdgeInTree(
            t.paneTree,
            sourceLeafId,
            targetLeafId,
            edge,
            splitId,
          );
          if (moved === null || moved === t.paneTree) return t;
          return syncPaneMirror({ ...t, paneTree: moved, activeLeafId: sourceLeafId });
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

  // Move an open extension TAB into a split pane leaf next to `targetLeafId`
  // in `targetTabId`. The source ext tab is closed (it's relocating, not
  // duplicating) so the panel is never mounted twice — important because
  // extensions like the SQL Explorer keep module singletons. No-op if the
  // same panel is already a live pane leaf.
  const moveExtTabToPane = useCallback(
    (extTabId: number, targetTabId: number, targetLeafId: number, dir: SplitDir): void => {
      setTabs((curr) => {
        const extTab = curr.find((t): t is ExtensionTab => t.id === extTabId && t.kind === "ext");
        if (!extTab) return curr;
        const target = curr.find((t) => t.id === targetTabId);
        if (!target || target.kind !== "pane") return curr;
        if (leafIds(target.paneTree).length >= MAX_PANES_PER_TAB) return curr;
        const alreadyLeaf = curr.some(
          (t) =>
            t.kind === "pane" &&
            leaves(t.paneTree).some(
              (l) =>
                l.leafKind === "extension-panel" &&
                l.extensionId === extTab.extensionId &&
                l.panelId === extTab.panelId,
            ),
        );
        if (alreadyLeaf) return curr;
        const splitId = nextIdRef.current++;
        const leafId = nextIdRef.current++;
        const state: ExtensionPanelLeafState = {
          leafKind: "extension-panel",
          extensionId: extTab.extensionId,
          panelId: extTab.panelId,
          ...(extTab.reuseKey ? { reuseKey: extTab.reuseKey } : {}),
          ...(extTab.title ? { title: extTab.title } : {}),
          ...(extTab.icon ? { icon: extTab.icon } : {}),
        };
        const paneTree = splitLeaf(target.paneTree, targetLeafId, splitId, leafId, dir, state);
        // Switch focus to the pane tab so the user sees the new split (the ext
        // tab they came from is about to disappear).
        setActiveId(targetTabId);
        return curr
          .filter((t) => t.id !== extTabId)
          .map((t) =>
            t.id === targetTabId && t.kind === "pane"
              ? syncPaneMirror({ ...t, paneTree, activeLeafId: leafId })
              : t,
          );
      });
    },
    [],
  );

  return {
    tabs,
    activeId,
    setActiveId,
    newTab,
    newSshTab,
    openFileTab,
    pinTab,
    newBrowserTab,
    openExtensionTab,
    openExtensionPane,
    setExtensionTabState,
    openAiDiffTab,
    setAiDiffStatus,
    openGitDiffTab,
    openScmTab,
    closeTab,
    selectByIndex,
    setLeafCwd,
    setLeafTerminalTheme,
    setBrowserLeafUrl,
    setBrowserLeafTitle,
    setLeafPtyId,
    setEditorLeafDirty,
    setEditorLeafPath,
    focusPane,
    focusNextPaneInTab,
    splitActivePane,
    moveExtTabToPane,
    closePaneByLeaf,
    moveLeafToTab,
    moveLeafToNewTab,
    rotateLeafSplit,
    replaceAllTabs,
    allocId,
    reorderTabs,
    reorderLeafInGroup,
    movePaneLeafToEdge,
    togglePrivate,
  };
}
