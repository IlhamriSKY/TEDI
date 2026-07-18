import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { sameEntries } from "@/modules/explorer/lib/useFileTree";
import { sftpCreateDir, sftpCreateFile, sftpDelete, sftpReadDir, sftpRename } from "./sftp";

// SFTP-backed file tree. Same shape as `useFileTree` so `FileTreeNode` can
// render it unchanged. Differences from the local hook:
//
// - All IO goes through the russh SFTP subsystem on a specific session.
//   Permission errors come from the remote kernel and are shown inline.
// - Session change (different leaf or reconnect with new id) wipes tree
//   state so we don't point at a stale handle.
// - Paths are POSIX, regardless of the local OS.

export type SshDirEntry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  /** Unix `"rwxr-xr-x"` mode summary from the SFTP metadata. Empty when the
   *  server did not report a mode. Shown in the tree row. */
  permissions?: string;
};

type ChildrenState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; entries: SshDirEntry[] }
  | { status: "error"; message: string };

type TreeState = Record<string, ChildrenState>;

export type PendingCreate = {
  parentPath: string;
  kind: "file" | "dir";
};

function joinPath(parent: string, name: string): string {
  if (parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}/${name}`;
}

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  if (i <= 0) return "/";
  return path.slice(0, i);
}

type Options = {
  /** Include dot-prefixed entries. */
  includeHidden?: boolean;
};

/** Poll interval (ms) for silent re-reads while the window is visible. Slower
 *  than the local tree's 4s: every pass is an SFTP round trip per open folder. */
const SSH_AUTO_REFRESH_MS = 10000;

export function useSshFileTree(
  sessionId: number | null,
  rootPath: string | null,
  options?: Options,
) {
  const [nodes, setNodes] = useState<TreeState>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const includeHidden = options?.includeHidden ?? false;

  // Per-path fetch generation. Guards against race conditions within a
  // session. Reset on session change.
  const fetchGen = useRef<Map<string, number>>(new Map());

  const fetchChildren = useCallback(
    async (path: string, opts: { silent?: boolean } = {}) => {
      if (sessionId === null) return;
      const gen = (fetchGen.current.get(path) ?? 0) + 1;
      fetchGen.current.set(path, gen);
      // Silent refresh keeps previous entries visible until new ones land, so a
      // background re-read never flashes the tree back to "Loading…".
      if (!opts.silent) {
        setNodes((s) => ({ ...s, [path]: { status: "loading" } }));
      }
      try {
        const entries = (await sftpReadDir(sessionId, path, includeHidden)) as SshDirEntry[];
        if (fetchGen.current.get(path) !== gen) return;
        setNodes((s) => {
          // Skip the state update when the listing is unchanged, so a poll on an
          // idle remote costs no repaint.
          if (opts.silent) {
            const prev = s[path];
            if (prev?.status === "loaded" && sameEntries(prev.entries, entries)) return s;
          }
          return { ...s, [path]: { status: "loaded", entries } };
        });
      } catch (e) {
        if (fetchGen.current.get(path) !== gen) return;
        // Silent failures keep cached entries; a transient network blip on a
        // background poll must not replace the tree with an error.
        if (!opts.silent) {
          setNodes((s) => ({
            ...s,
            [path]: { status: "error", message: String(e) },
          }));
        }
      }
    },
    [sessionId, includeHidden],
  );

  // Ref so the polling effect below doesn't re-subscribe on every fetch identity
  // change (includeHidden / sessionId).
  const fetchChildrenRef = useRef(fetchChildren);
  fetchChildrenRef.current = fetchChildren;

  // Root or session change: reset state. A new sessionId from a reconnect
  // would otherwise replay stale tree state against a different handle.
  useEffect(() => {
    fetchGen.current = new Map();
    if (!rootPath || sessionId === null) {
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
    // includeHidden is handled by the next effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath, sessionId]);

  useEffect(() => {
    if (!rootPath || sessionId === null) return;
    const loaded = Object.keys(nodes);
    for (const p of loaded) void fetchChildren(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeHidden, rootPath, sessionId]);

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

  /** Silently re-reads every currently-visible directory (root plus each
   *  expanded path), not just the root. This is what the Refresh button runs:
   *  refreshing only the root left every open subfolder showing stale remote
   *  data. Collapsed dirs stay cached but aren't re-fetched, so the SFTP round
   *  trips don't grow with every folder opened this session. */
  const refreshAllLoaded = useCallback(() => {
    if (!rootPath || sessionId === null) return;
    for (const p of new Set<string>([rootPath, ...expanded])) {
      void fetchChildrenRef.current(p, { silent: true });
    }
  }, [rootPath, sessionId, expanded]);

  const refreshAllLoadedRef = useRef(refreshAllLoaded);
  refreshAllLoadedRef.current = refreshAllLoaded;

  // Track remote-side changes without an SFTP watcher: poll while the window is
  // visible, and re-read immediately on focus/visibility so alt-tabbing back
  // shows current data. Mirrors the local tree, but at a slower cadence because
  // each pass is a network round trip per open folder.
  // ponytail: fixed interval; switch to an inotify-backed push if a busy remote
  // ever makes the polling cost visible.
  useEffect(() => {
    if (!rootPath || sessionId === null) return;
    let intervalId: number | null = null;
    const start = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        if (document.visibilityState === "visible") refreshAllLoadedRef.current();
      }, SSH_AUTO_REFRESH_MS);
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

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", stop);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", stop);
    };
  }, [rootPath, sessionId]);

  const collapseAll = useCallback(() => {
    setExpanded((curr) => (curr.size === 0 ? curr : new Set()));
  }, []);

  const beginCreate = useCallback(
    (parentPath: string, kind: "file" | "dir") => {
      setRenaming(null);
      setPendingCreate({ parentPath, kind });
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
      if (!pendingCreate || sessionId === null) return;
      const trimmed = name.trim();
      if (!trimmed) {
        setPendingCreate(null);
        return;
      }
      const path = joinPath(pendingCreate.parentPath, trimmed);
      try {
        if (pendingCreate.kind === "dir") {
          await sftpCreateDir(sessionId, path);
        } else {
          await sftpCreateFile(sessionId, path);
        }
        await fetchChildren(pendingCreate.parentPath);
      } catch (e) {
        console.error(`ssh create ${pendingCreate.kind} failed:`, e);
      } finally {
        setPendingCreate(null);
      }
    },
    [pendingCreate, fetchChildren, sessionId],
  );

  const beginRename = useCallback((path: string) => {
    setPendingCreate(null);
    setRenaming(path);
  }, []);

  const cancelRename = useCallback(() => setRenaming(null), []);

  const commitRename = useCallback(
    async (newName: string) => {
      if (!renaming || sessionId === null) return;
      const trimmed = newName.trim();
      const parent = dirname(renaming);
      const oldName = renaming.slice(parent === "/" ? 1 : parent.length + 1);
      if (!trimmed || trimmed === oldName) {
        setRenaming(null);
        return;
      }
      const to = joinPath(parent, trimmed);
      try {
        await sftpRename(sessionId, renaming, to);
        await fetchChildren(parent);
      } catch (e) {
        console.error("ssh rename failed:", e);
      } finally {
        setRenaming(null);
      }
    },
    [renaming, fetchChildren, sessionId],
  );

  const deletePath = useCallback(
    async (path: string) => {
      if (sessionId === null) return;
      try {
        await sftpDelete(sessionId, path);
        await fetchChildren(dirname(path));
      } catch (e) {
        console.error("ssh delete failed:", e);
      }
    },
    [fetchChildren, sessionId],
  );

  return useMemo(
    () => ({
      nodes,
      expanded,
      pendingCreate,
      renaming,
      toggle,
      expand,
      refresh,
      refreshAllLoaded,
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
      refreshAllLoaded,
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
