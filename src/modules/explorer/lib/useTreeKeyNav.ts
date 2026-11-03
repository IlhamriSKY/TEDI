import { useMemo, type KeyboardEvent } from "react";
import type { useFileTree } from "./useFileTree";

type Tree = Pick<
  ReturnType<typeof useFileTree>,
  "nodes" | "expanded" | "joinPath" | "toggle" | "beginRename"
>;

export type FlatTreeItem = { path: string; isDir: boolean };

/**
 * Arrow-key navigation for a file tree, local or remote. Selection is state rather
 * than DOM focus, so focus stays on the `role="tree"` root this handler goes on.
 */
export function useTreeKeyNav({
  rootPath,
  tree,
  selectedPath,
  setSelectedPath,
  onOpenFile,
  disabled,
}: {
  rootPath: string | null;
  tree: Tree;
  selectedPath: string | null;
  setSelectedPath: (path: string | null) => void;
  onOpenFile: (path: string) => void;
  /** Collapsed, or a field in the tree is taking the keys. */
  disabled: boolean;
}) {
  const flat = useMemo<FlatTreeItem[]>(() => {
    if (!rootPath) return [];
    const out: FlatTreeItem[] = [];
    const walk = (parent: string) => {
      const node = tree.nodes[parent];
      if (!node || node.status !== "loaded") return;
      for (const e of node.entries) {
        const p = tree.joinPath(parent, e.name);
        const isDir = e.kind === "dir";
        out.push({ path: p, isDir });
        if (isDir && tree.expanded.has(p)) walk(p);
      }
    };
    walk(rootPath);
    return out;
  }, [rootPath, tree.nodes, tree.expanded, tree.joinPath]);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      return;
    // A header button keeps its own Enter; this handler only sees it by bubbling.
    if (target !== e.currentTarget && !target.closest("[data-fs-path]")) return;
    if (flat.length === 0) return;

    const root = e.currentTarget;
    const rowOf = (path: string) =>
      root.querySelector<HTMLElement>(`[data-fs-path="${CSS.escape(path)}"]`);
    const currentIdx = selectedPath ? flat.findIndex((f) => f.path === selectedPath) : -1;

    const move = (next: number) => {
      const path = flat[Math.max(0, Math.min(flat.length - 1, next))].path;
      setSelectedPath(path);
      requestAnimationFrame(() => rowOf(path)?.scrollIntoView({ block: "nearest" }));
    };

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(currentIdx < 0 ? 0 : currentIdx + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(currentIdx < 0 ? flat.length - 1 : currentIdx - 1);
        break;
      case "ArrowRight": {
        if (currentIdx < 0) return;
        e.preventDefault();
        const item = flat[currentIdx];
        if (item.isDir) {
          if (!tree.expanded.has(item.path)) tree.toggle(item.path);
          else move(currentIdx + 1);
        }
        break;
      }
      case "ArrowLeft": {
        if (currentIdx < 0) return;
        e.preventDefault();
        const item = flat[currentIdx];
        if (item.isDir && tree.expanded.has(item.path)) {
          tree.toggle(item.path);
        } else {
          const cut = Math.max(item.path.lastIndexOf("/"), item.path.lastIndexOf("\\"));
          const parent = cut > 0 ? item.path.slice(0, cut) : "";
          if (parent && parent !== rootPath) setSelectedPath(parent);
        }
        break;
      }
      case "Enter": {
        if (currentIdx < 0) return;
        e.preventDefault();
        const item = flat[currentIdx];
        if (item.isDir) tree.toggle(item.path);
        else onOpenFile(item.path);
        break;
      }
      case "F2":
        if (currentIdx < 0) return;
        e.preventDefault();
        tree.beginRename(flat[currentIdx].path);
        break;
      case "F10":
      case "ContextMenu": {
        if (e.key === "F10" && !e.shiftKey) return;
        if (currentIdx < 0) return;
        // DOM focus stays on the tree root, so the browser's own keyboard context
        // menu would open on the root, which has no menu. Everything a row offers
        // (delete, copy path, reveal) lives in that menu.
        e.preventDefault();
        const row = rowOf(flat[currentIdx].path);
        const rect = row?.getBoundingClientRect();
        if (row && rect) {
          row.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              clientX: rect.left + 24,
              clientY: rect.bottom,
            }),
          );
        }
        break;
      }
    }
  };

  return { flat, onKeyDown };
}
