import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FS_REFRESH_EVENT } from "./fsRefresh";

export type DirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
};

export type SortMode = "default" | "name-asc" | "name-desc" | "modified-desc" | "modified-asc";

type ChildrenState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; entries: DirEntry[] }
  | { status: "error"; message: string };

type TreeState = Record<string, ChildrenState>;

function dirRank(k: DirEntry["kind"]): number {
  // Mirrors the Rust default in fs/tree.rs so "default" mode is a no-op here.
  return k === "dir" ? 0 : k === "symlink" ? 1 : 2;
}

function nameCmp(a: DirEntry, b: DirEntry): number {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

function sortEntries(entries: DirEntry[], mode: SortMode): DirEntry[] {
  // Rust already returns dirs-first + name-asc, so skip the work on default.
  if (mode === "default") return entries;
  const out = entries.slice();
  switch (mode) {
    case "name-asc":
      // Folders first, then by name. Same shape as Rust default - kept
      // separate from "default" so the radio reads as an explicit pick.
      out.sort((a, b) => dirRank(a.kind) - dirRank(b.kind) || nameCmp(a, b));
      break;
    case "name-desc":
      out.sort((a, b) => dirRank(a.kind) - dirRank(b.kind) || -nameCmp(a, b));
      break;
    case "modified-desc":
      // Pure mtime - folders and files mixed. Matches Finder's "Date Modified".
      out.sort((a, b) => b.mtime - a.mtime || nameCmp(a, b));
      break;
    case "modified-asc":
      out.sort((a, b) => a.mtime - b.mtime || nameCmp(a, b));
      break;
  }
  return out;
}

/** Polling interval (ms) for silent re-reads while the window is focused.
 *  Picks up external file changes without a backend FS watcher. */
const AUTO_REFRESH_MS = 4000;

/** Re-exported for existing importers (e.g. gitDecorations). Owned by
 *  fsRefresh.ts, which also dispatches it. */
export { FS_REFRESH_EVENT };

function sameEntries(a: DirEntry[], b: DirEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.name !== y.name || x.kind !== y.kind || x.mtime !== y.mtime || x.size !== y.size)
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
  // Accept `/` and `\` so the tree doesn't collapse to root after a
  // rename/delete on Windows (Rust may return backslash paths).
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (i <= 0) return "/";
  return path.slice(0, i);
}

type Options = {
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
  /** When true, dot-prefixed entries are returned. */
  includeHidden?: boolean;
  /** Client-side sort applied on top of the Rust listing. Default: keep the
   *  Rust order (folders first + name-asc). */
  sortMode?: SortMode;
};

export function useFileTree(rootPath: string | null, options?: Options) {
  const sortMode = options?.sortMode ?? "default";
  const [rawNodes, setRawNodes] = useState<TreeState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const includeHidden = options?.includeHidden ?? false;

  // Per-path generation counter so only the latest in-flight fetch commits.
  const fetchGen = useRef<Map<string, number>>(new Map());

  const fetchChildren = useCallback(
    async (path: string, opts: { silent?: boolean } = {}) => {
      const gen = (fetchGen.current.get(path) ?? 0) + 1;
      fetchGen.current.set(path, gen);
      // Silent refresh keeps previous entries visible until new ones land.
      if (!opts.silent) {
        setRawNodes((s) => ({ ...s, [path]: { status: "loading" } }));
      }
      try {
        const entries = await invoke<DirEntry[]>("fs_read_dir", {
          path,
          includeHidden,
        });
        if (fetchGen.current.get(path) !== gen) return;
        setRawNodes((s) => {
          // Skip the state update when the listing is unchanged.
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
        // Silent failures keep cached entries; foreground fetches still error.
        if (!opts.silent) {
          setRawNodes((s) => ({
            ...s,
            [path]: { status: "error", message: String(e) },
          }));
        }
      }
    },
    [includeHidden],
  );

  // Ref so the polling effect doesn't re-subscribe when `includeHidden` flips.
  const fetchChildrenRef = useRef(fetchChildren);
  fetchChildrenRef.current = fetchChildren;

  /** Silently re-reads only the currently-visible directories (root plus every
   *  expanded path). Collapsed dirs stay cached but aren't re-fetched, so the
   *  background IO doesn't grow with every directory ever opened this session.
   *  Only changed rows repaint. */
  const refreshAllLoaded = useCallback(() => {
    if (!rootPath) return;
    const dirs = new Set<string>([rootPath, ...expanded]);
    for (const p of dirs) {
      void fetchChildrenRef.current(p, { silent: true });
    }
  }, [rootPath, expanded]);

  const refreshAllLoadedRef = useRef(refreshAllLoaded);
  refreshAllLoadedRef.current = refreshAllLoaded;

  // Latest `nodes` ref for event handlers that shouldn't re-subscribe.
  const nodesRef = useRef(rawNodes);
  nodesRef.current = rawNodes;

  // Root change: reset state.
  useEffect(() => {
    fetchGen.current = new Map();
    if (!rootPath) {
      setRawNodes({});
      setExpanded(new Set());
      setPendingCreate(null);
      setRenaming(null);
      return;
    }
    setPendingCreate(null);
    setRenaming(null);
    setExpanded(new Set());
    setRawNodes({});
    void fetchChildren(rootPath);
    // Exclude `fetchChildren` from deps: `includeHidden` toggles are handled
    // by the dedicated effect below so the user's expanded state survives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath]);

  // Tracks the last `rootPath` this effect saw, so an includeHidden flip can be
  // told apart from a root change.
  const prevRootForHiddenRef = useRef(rootPath);

  // `includeHidden` flip: re-fetch every loaded directory in place; expansion
  // state stays.
  useEffect(() => {
    const rootChanged = prevRootForHiddenRef.current !== rootPath;
    prevRootForHiddenRef.current = rootPath;
    if (!rootPath) return;
    // Skip on a root change: the root-change effect already reset and fetched
    // the new root, and the stale `rawNodes` closure here still holds the
    // previous root's directories. Only refetch when includeHidden flipped.
    if (rootChanged) return;
    const loaded = Object.keys(rawNodes);
    for (const p of loaded) {
      void fetchChildren(p);
    }
    // Only run on flag change; depending on `rawNodes` would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeHidden, rootPath]);

  // Auto-refresh to track external mutations without a backend FS watcher.
  // Triggers: window focus/visibility (immediate), interval while focused,
  // FS_REFRESH_EVENT (targeted or full). Polling pauses on blur/hidden.
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
        // Refresh only the named directory.
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
    // Skip `nodes` from deps: `onRefreshEvent` reads it via ref, so
    // depending on it would re-subscribe listeners on every tree change.
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
      setRawNodes((curr) => {
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
      setRawNodes((curr) => {
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
      // Expand the parent so the input row is visible.
      if (rootPath && parentPath !== rootPath) {
        setExpanded((curr) => {
          if (curr.has(parentPath)) return curr;
          const next = new Set(curr);
          next.add(parentPath);
          return next;
        });
      }
      setRawNodes((curr) => {
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

  // Apply the user's sort preference on top of the raw listing. Re-sorts
  // every loaded directory whenever the mode flips, without refetching.
  const nodes = useMemo<TreeState>(() => {
    if (sortMode === "default") return rawNodes;
    const out: TreeState = {};
    for (const [path, state] of Object.entries(rawNodes)) {
      out[path] =
        state.status === "loaded"
          ? { status: "loaded", entries: sortEntries(state.entries, sortMode) }
          : state;
    }
    return out;
  }, [rawNodes, sortMode]);

  // Memoize the return so memo()'d children don't invalidate on every parent
  // render. Only changed slices bump identity.
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
