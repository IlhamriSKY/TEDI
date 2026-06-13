import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { basename } from "@/lib/path";
import {
  hasLeaf,
  leaves,
  updateBrowserLeaf as updateBrowserLeafInTree,
  updateBrowserLeafTitle as updateBrowserLeafTitleInTree,
  type PaneLeaf,
} from "@/modules/terminal/lib/panes";
import {
  type AiDiffStatus,
  type ExtensionTab,
  type ExtensionTabState,
  type GitChangeStatusTab,
  type ScmTab,
  type Tab,
} from "./tabTypes";
import { syncPaneMirror, titleFromUrl } from "./tabHelpers";

/**
 * Shared mutable handles `useTabs` threads into the aux-tab sub-hook. These
 * are the exact `setTabs` / `setActiveId` setters, id counter, and live-tabs
 * ref owned by `useTabs`; the callbacks below close over them verbatim.
 */
type AuxTabsDeps = {
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  setActiveId: Dispatch<SetStateAction<number>>;
  nextIdRef: RefObject<number>;
  tabsRef: RefObject<Tab[]>;
  /** Monotonic FIFO counter for the browser chip number, owned by `useTabs`. */
  nextBrowserOrdinalRef: RefObject<number>;
};

/**
 * The non-pane tab openers + browser-leaf URL/title updaters, extracted from
 * `useTabs` unchanged. Bodies and dependency arrays are identical to the
 * originals; `useTabs` spreads the returned callbacks into its return object.
 */
export function useAuxTabs({
  setTabs,
  setActiveId,
  nextIdRef,
  tabsRef,
  nextBrowserOrdinalRef,
}: AuxTabsDeps) {
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
      commitSha?: string;
      baseRev?: string | null;
      oldRelative?: string | null;
      commitLabel?: string;
    }) => {
      const commitSha = input.commitSha ?? undefined;
      let targetId: number | null = null;
      setTabs((curr) => {
        // Working-tree diffs dedupe on (relative, repo); per-commit diffs also
        // key on the commit so the same file at different commits coexist.
        const existing = curr.find(
          (t) =>
            t.kind === "git-diff" &&
            t.relative === input.relative &&
            t.repoPath === input.repoPath &&
            (t.commitSha ?? undefined) === commitSha,
        );
        if (existing) {
          // Bump reloadKey so the pane re-reads its two sides.
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
        const title = commitSha
          ? `${basename(input.path)} @ ${input.commitLabel ?? commitSha.slice(0, 7)}`
          : `${basename(input.path)} (diff)`;
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
            ...(commitSha
              ? {
                  commitSha,
                  baseRev: input.baseRev ?? null,
                  oldRelative: input.oldRelative ?? null,
                  commitLabel: input.commitLabel,
                }
              : {}),
          },
        ];
      });
      if (targetId !== null) setActiveId(targetId);
      return targetId as number | null;
    },
    [],
  );

  /**
   * Open (or focus) the single Source Control tab. Dedupes against
   * `tabsRef.current` so `setActiveId` always lands even when the caller
   * schedules other state updates first (see `openExtensionTab`).
   */
  const openScmTab = useCallback(() => {
    const existing = tabsRef.current.find((t) => t.kind === "scm");
    if (existing) {
      setActiveId(existing.id);
      return existing.id;
    }
    const id = nextIdRef.current++;
    setTabs((curr) => [...curr, { id, kind: "scm", title: "Source Control" } satisfies ScmTab]);
    setActiveId(id);
    return id;
  }, []);

  const newBrowserTab = useCallback((url: string, activate = true) => {
    // A browser is a pane leaf like terminal/editor, so a "browser tab" is just
    // a pane tab whose tree is a single browser leaf - splittable and joinable.
    const tabId = nextIdRef.current++;
    const leafId = nextIdRef.current++;
    setTabs((t) => {
      // FIFO browser ordinal ("Browser 3"), monotonic via the ref so a closed
      // browser's number is never reused mid-session. Mirrors terminal ordinals.
      let max = nextBrowserOrdinalRef.current - 1;
      for (const tab of t) {
        if (tab.kind !== "pane") continue;
        for (const l of leaves(tab.paneTree)) {
          if (
            l.leafKind === "browser" &&
            typeof l.browserOrdinal === "number" &&
            l.browserOrdinal > max
          ) {
            max = l.browserOrdinal;
          }
        }
      }
      const browserOrdinal = max + 1;
      nextBrowserOrdinalRef.current = browserOrdinal + 1;
      const leaf: PaneLeaf = { kind: "leaf", id: leafId, leafKind: "browser", url, browserOrdinal };
      return [
        ...t,
        syncPaneMirror({
          id: tabId,
          kind: "pane",
          title: titleFromUrl(url),
          paneTree: leaf,
          activeLeafId: leafId,
        }),
      ];
    });
    // Background opens (e.g. the AI opening a browser to read) pass activate:false
    // so the user's current tab keeps focus. The pane still mounts and its native
    // webview is created OFF-SCREEN (see preview_embed_update's background-create
    // branch), so the page loads and reads work headless without focusing the tab.
    if (activate) setActiveId(tabId);
    return tabId;
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

  /** Update a preview (browser) leaf's URL by id. Mirrors the title when the
   *  leaf is active. Driven by the browser pane reporting in-page navigation. */
  const setBrowserLeafUrl = useCallback((leafId: number, url: string) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "pane") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = updateBrowserLeafInTree(t.paneTree, leafId, url);
        if (paneTree === t.paneTree) return t;
        return syncPaneMirror({ ...t, paneTree });
      }),
    );
  }, []);

  /** Update a preview leaf's page title by id (from the webview's
   *  document.title). Re-syncs the tab/pane label. */
  const setBrowserLeafTitle = useCallback((leafId: number, title: string) => {
    setTabs((curr) =>
      curr.map((t) => {
        if (t.kind !== "pane") return t;
        if (!hasLeaf(t.paneTree, leafId)) return t;
        const paneTree = updateBrowserLeafTitleInTree(t.paneTree, leafId, title);
        if (paneTree === t.paneTree) return t;
        return syncPaneMirror({ ...t, paneTree });
      }),
    );
  }, []);

  return {
    openAiDiffTab,
    setAiDiffStatus,
    openGitDiffTab,
    openScmTab,
    newBrowserTab,
    openExtensionTab,
    setExtensionTabState,
    setBrowserLeafUrl,
    setBrowserLeafTitle,
  };
}
