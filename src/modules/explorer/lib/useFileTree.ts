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
    async (path: string) => {
      const gen = (fetchGen.current.get(path) ?? 0) + 1;
      fetchGen.current.set(path, gen);
      setNodes((s) => ({ ...s, [path]: { status: "loading" } }));
      try {
        const entries = await invoke<DirEntry[]>("fs_read_dir", {
          path,
          includeHidden,
        });
        if (fetchGen.current.get(path) !== gen) return;
        setNodes((s) => ({ ...s, [path]: { status: "loaded", entries } }));
      } catch (e) {
        if (fetchGen.current.get(path) !== gen) return;
        setNodes((s) => ({
          ...s,
          [path]: { status: "error", message: String(e) },
        }));
      }
    },
    [includeHidden],
  );

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
