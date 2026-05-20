import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

type ChildrenState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; entries: DirEntry[] }
  | { status: "error"; message: string };

type TreeState = Record<string, ChildrenState>;

/** Polling interval for silently re-reading every loaded directory while the
 *  window is focused & visible. Picks up files created externally (terminal,
 *  another editor, AI shell tools) without a backend FS watcher. */
const AUTO_REFRESH_MS = 4000;

/** Global event other modules can dispatch to ask the explorer to refresh
 *  a specific directory immediately — e.g. after an AI write/create/delete.
 *  Detail `{ path }` refreshes that exact directory; omitting `path`
 *  refreshes every loaded directory. */
export const FS_REFRESH_EVENT = "tedi:refresh-fs";

function sameEntries(a: DirEntry[], b: DirEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.name !== y.name ||
      x.kind !== y.kind ||
      x.mtime !== y.mtime ||
      x.size !== y.size
    )
      return false;
  }
  return true;
}

export type PendingCreate = {
  parentPath: string;
  kind: "file" | "dir";
};

export function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}/${name}`;
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  if (i <= 0) return "/";
  return path.slice(0, i);
}

type Options = {
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
  /** When true, dot-prefixed entries are returned from the backend. */
  includeHidden?: boolean;
};

export function useFileTree(rootPath: string | null, options?: Options) {
  const [nodes, setNodes] = useState<TreeState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const includeHidden = options?.includeHidden ?? false;

  // Per-path fetch generation. When a directory has multiple in-flight
  // fetches (e.g. user rapidly toggles `showHiddenFiles`), only the
  // latest-issued one is allowed to commit its result. Prevents stale
  // listings from overwriting fresh ones.
  const fetchGen = useRef<Map<string, number>>(new Map());

  const fetchChildren = useCallback(
    async (path: string, opts: { silent?: boolean } = {}) => {
      const gen = (fetchGen.current.get(path) ?? 0) + 1;
      fetchGen.current.set(path, gen);
      // Silent refresh keeps the previous entries on screen until the new
      // response lands - avoids a "Loading…" flash during background polling.
      if (!opts.silent) {
        setNodes((s) => ({ ...s, [path]: { status: "loading" } }));
      }
      try {
        const entries = await invoke<DirEntry[]>("fs_read_dir", {
          path,
          includeHidden,
        });
        if (fetchGen.current.get(path) !== gen) return;
        setNodes((s) => {
          // Background poll: if the listing is identical (same names,
          // mtimes, sizes), skip the state update entirely. Avoids
          // re-rendering the whole tree every poll tick.
          if (opts.silent) {
            const prev = s[path];
            if (prev?.status === "loaded" && sameEntries(prev.entries, entries)) {
              return s;
            }
          }
          return { ...s, [path]: { status: "loaded", entries } };
        });
      } catch (e) {
        if (fetchGen.current.get(path) !== gen) return;
        // Silent refresh failures (file deleted under us, permissions
        // changed, etc.) shouldn't blow away the cached entries the user
        // is looking at. Foreground fetches still surface the error.
        if (!opts.silent) {
          setNodes((s) => ({
            ...s,
            [path]: { status: "error", message: String(e) },
          }));
        }
      }
    },
    [includeHidden],
  );

  // Hold the latest fetchChildren in a ref so the polling effect doesn't
  // need to re-subscribe every time `includeHidden` flips (which would
  // tear down + recreate the interval).
  const fetchChildrenRef = useRef(fetchChildren);
  fetchChildrenRef.current = fetchChildren;

  /** Re-read every directory currently loaded in the tree. Silent: keeps
   *  the existing UI on screen and only repaints rows that actually
   *  changed. Used by the focus/visibility/interval auto-refresh. */
  const refreshAllLoaded = useCallback(() => {
    const dirs = Object.keys(nodes);
    for (const p of dirs) {
      void fetchChildrenRef.current(p, { silent: true });
    }
  }, [nodes]);

  const refreshAllLoadedRef = useRef(refreshAllLoaded);
  refreshAllLoadedRef.current = refreshAllLoaded;

  // Latest `nodes` snapshot for use inside event handlers that we don't
  // want to re-subscribe on every tree change.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Root change → reset state.
  useEffect(() => {
    fetchGen.current = new Map();
    if (!rootPath) {
      setNodes({});
      setExpanded(new Set());
      setPendingCreate(null);
      setRenaming(null);
      return;
    }
    setPendingCreate(null);
    setRenaming(null);
    setExpanded(new Set());
    setNodes({});
    void fetchChildren(rootPath);
    // Intentionally exclude `fetchChildren` here: it captures `includeHidden`
    // and toggling that flag is handled by the dedicated effect below so we
    // don't blow away the user's expanded state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

  // includeHidden flip → re-fetch every already-loaded directory in place
  // so the tree stays expanded but updated.
  useEffect(() => {
    if (!rootPath) return;
    const loaded = Object.keys(nodes);
    for (const p of loaded) {
      void fetchChildren(p);
    }
    // We only want this to fire on the flag change, not on every node
    // mutation - including `nodes` would create a refetch loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeHidden, rootPath]);

  // Auto-refresh: keep the tree in sync with external mutations (terminal
  // commands creating files, another editor saving, AI shell tools, etc.)
  // without a backend FS watcher. Three triggers:
  //  - window focus / visibility-visible → immediate silent refresh
  //  - polling interval while focused → silent refresh of every loaded dir
  //  - FS_REFRESH_EVENT broadcast → targeted (or full) silent refresh
  // Stops polling on blur / hidden so a backgrounded window doesn't burn
  // CPU for nothing.
  useEffect(() => {
    if (!rootPath) return;

    let intervalId: number | null = null;
    const start = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        if (document.visibilityState === "visible") {
          refreshAllLoadedRef.current();
        }
      }, AUTO_REFRESH_MS);
    };
    const stop = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshAllLoadedRef.current();
        start();
      } else {
        stop();
      }
    };
    const onFocus = () => {
      refreshAllLoadedRef.current();
      start();
    };
    const onBlur = () => stop();
    const onRefreshEvent = (ev: Event) => {
      const detail = (ev as CustomEvent<{ path?: string } | undefined>).detail;
      if (detail?.path) {
        // Targeted refresh — only the specific dir whose contents changed.
        const p = detail.path;
        if (fetchGen.current.has(p) || nodesRef.current[p]) {
          void fetchChildrenRef.current(p, { silent: true });
        }
      } else {
        refreshAllLoadedRef.current();
      }
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener(FS_REFRESH_EVENT, onRefreshEvent as EventListener);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener(FS_REFRESH_EVENT, onRefreshEvent as EventListener);
    };
    // `nodes` is only read inside `onRefreshEvent` to validate the path,
    // so depending on it would tear down + recreate the listeners on every
    // tree change. We intentionally skip it - the ref-based access pattern
    // sees the latest tree state without re-subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

  const toggle = useCallback(
    (path: string) => {
      setExpanded((curr) => {
        const next = new Set(curr);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      setNodes((curr) => {
        if (!curr[path] || curr[path].status === "error") {
          void fetchChildren(path);
        }
        return curr;
      });
    },
    [fetchChildren],
  );

  const expand = useCallback(
    (path: string) => {
      setExpanded((curr) => {
        if (curr.has(path)) return curr;
        const next = new Set(curr);
        next.add(path);
        return next;
      });
      setNodes((curr) => {
        if (!curr[path]) void fetchChildren(path);
        return curr;
      });
    },
    [fetchChildren],
  );

  const refresh = useCallback(
    (path: string) => {
      void fetchChildren(path);
    },
    [fetchChildren],
  );

  const collapseAll = useCallback(() => {
    setExpanded((curr) => (curr.size === 0 ? curr : new Set()));
  }, []);

  // --- mutations ---

  const beginCreate = useCallback(
    (parentPath: string, kind: "file" | "dir") => {
      setRenaming(null);
      setPendingCreate({ parentPath, kind });
      // Ensure the parent is expanded so the input row is visible.
      if (rootPath && parentPath !== rootPath) {
        setExpanded((curr) => {
          if (curr.has(parentPath)) return curr;
          const next = new Set(curr);
          next.add(parentPath);
          return next;
        });
      }
      setNodes((curr) => {
        if (!curr[parentPath]) void fetchChildren(parentPath);
        return curr;
      });
    },
    [rootPath, fetchChildren],
  );

  const cancelCreate = useCallback(() => setPendingCreate(null), []);

  const commitCreate = useCallback(
    async (name: string) => {
      if (!pendingCreate) return;
      const trimmed = name.trim();
      if (!trimmed) {
        setPendingCreate(null);
        return;
      }
      const path = joinPath(pendingCreate.parentPath, trimmed);
      const cmd = pendingCreate.kind === "dir" ? "fs_create_dir" : "fs_create_file";
      try {
        await invoke(cmd, { path });
        await fetchChildren(pendingCreate.parentPath);
      } catch (e) {
        console.error(`${cmd} failed:`, e);
      } finally {
        setPendingCreate(null);
      }
    },
    [pendingCreate, fetchChildren],
  );

  const beginRename = useCallback((path: string) => {
    setPendingCreate(null);
    setRenaming(path);
  }, []);

  const cancelRename = useCallback(() => setRenaming(null), []);

  const commitRename = useCallback(
    async (newName: string) => {
      if (!renaming) return;
      const trimmed = newName.trim();
      const parent = dirname(renaming);
      const oldName = renaming.slice(parent === "/" ? 1 : parent.length + 1);
      if (!trimmed || trimmed === oldName) {
        setRenaming(null);
        return;
      }
      const to = joinPath(parent, trimmed);
      try {
        await invoke("fs_rename", { from: renaming, to });
        options?.onPathRenamed?.(renaming, to);
        await fetchChildren(parent);
      } catch (e) {
        console.error("fs_rename failed:", e);
      } finally {
        setRenaming(null);
      }
    },
    [renaming, fetchChildren, options],
  );

  const deletePath = useCallback(
    async (path: string) => {
      try {
        await invoke("fs_delete", { path });
        options?.onPathDeleted?.(path);
        await fetchChildren(dirname(path));
      } catch (e) {
        console.error("fs_delete failed:", e);
      }
    },
    [fetchChildren, options],
  );

  // Memoise the return tuple so consumers can pass it as a single `tree` prop
  // to `memo()`'d children (e.g. FileTreeNode) without invalidating the shallow
  // prop compare on every parent render. Only the slices that actually changed
  // bump the object identity.
  return useMemo(
    () => ({
      nodes,
      expanded,
      pendingCreate,
      renaming,
      toggle,
      expand,
      refresh,
      collapseAll,
      beginCreate,
      cancelCreate,
      commitCreate,
      beginRename,
      cancelRename,
      commitRename,
      deletePath,
      joinPath,
    }),
    [
      nodes,
      expanded,
      pendingCreate,
      renaming,
      toggle,
      expand,
      refresh,
      collapseAll,
      beginCreate,
      cancelCreate,
      commitCreate,
      beginRename,
      cancelRename,
      commitRename,
      deletePath,
    ],
  );
}
