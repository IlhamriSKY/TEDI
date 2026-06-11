import { Folder01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ExplorerGrepHandle } from "./ExplorerGrep";
import { type ExplorerSearchHandle } from "./ExplorerSearch";
import { ExplorerHeader } from "./components/ExplorerHeader";
import { ExplorerTreeList } from "./components/ExplorerTreeList";
import { SORT_MODES } from "./lib/sortModes";
import { useExplorerIconsReady } from "./lib/iconResolver";
import { useFileTree, type SortMode } from "./lib/useFileTree";
import { toForwardSlash } from "@/lib/path";
import { useGlobalShortcuts } from "@/modules/shortcuts";
import { usePreferencesStore } from "@/modules/settings/preferences";

const SORT_STORAGE_KEY = "tedi:explorer:sortMode";

function readStoredSortMode(): SortMode {
  if (typeof window === "undefined") return "default";
  try {
    const v = window.localStorage.getItem(SORT_STORAGE_KEY);
    if (v && (SORT_MODES as ReadonlyArray<string>).includes(v)) return v as SortMode;
  } catch {
    // localStorage may be unavailable (e.g. file:// without storage); fall through.
  }
  return "default";
}

type Props = {
  rootPath: string | null;
  onOpenFile: (path: string, pin?: boolean) => void;
  onPathRenamed?: (from: string, to: string) => void;
  onPathDeleted?: (path: string) => void;
  onRevealInTerminal?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  /** Open an HTML file in the in-app browser preview (context-menu action). */
  onPreviewInBrowser?: (path: string) => void;
  /** Accordion mode. Header becomes a chevron toggle; body hides while
   *  `collapsed` is true. Pair with a collapsible ResizablePanel. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Hide the New file / New folder buttons. For read-only panels. */
  hideCreateActions?: boolean;
  /** Hide the grep button when only filename search is needed. */
  hideGrep?: boolean;
  /** Hide the Sort dropdown button. When hidden, `sortMode` is forced to
   *  "default" (folders-first) so a value persisted by another surface
   *  sharing the storage key can't strand this tree on a mode the user
   *  can't see or change. */
  hideSort?: boolean;
  /** Extra buttons appended after Refresh + Collapse. */
  headerExtras?: React.ReactNode;
  /** Absolute path of the file the user is currently viewing (editor, ai-diff,
   *  or git-diff tab). When set and under `rootPath`, the explorer expands
   *  ancestor folders, selects the row, and scrolls it into view. The reveal
   *  fires once per distinct `activeFilePath` value so user-initiated
   *  collapses are not undone on the next tab repaint. */
  activeFilePath?: string | null;
  /** Sidebar-section reorder controls (grip), forwarded to the header. */
  dragHandle?: React.ReactNode;
};

/**
 * Folders to expand so `filePath` becomes visible under `rootPath`. Returns
 * forward-slash paths matching what `useFileTree.joinPath` produces.
 * Returns `[]` when the file is not under the root (different drive, escape
 * via `..`, etc.) - caller treats that as "nothing to reveal".
 */
function ancestorFolders(rootPath: string, filePath: string): string[] {
  const root = toForwardSlash(rootPath).replace(/\/+$/, "");
  const file = toForwardSlash(filePath);
  if (file !== root && !file.startsWith(root + "/")) return [];
  const rel = file.slice(root.length).replace(/^\/+/, "");
  const parts = rel.split("/").filter(Boolean);
  // Last segment is the file itself; expand only intermediate folders.
  const out: string[] = [];
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = `${cur}/${parts[i]}`;
    out.push(cur);
  }
  return out;
}

export function FileExplorer({
  rootPath,
  onOpenFile,
  onPathRenamed,
  onPathDeleted,
  onRevealInTerminal,
  onAttachToAgent,
  onPreviewInBrowser,
  collapsed = false,
  onToggleCollapsed,
  hideCreateActions = false,
  hideGrep = false,
  hideSort = false,
  headerExtras,
  activeFilePath,
  dragHandle,
}: Props) {
  const showHiddenFiles = usePreferencesStore((s) => s.showHiddenFiles);
  // Re-render once the lazy-loaded catppuccin icon set arrives so file +
  // folder rows swap from empty src to the real glyph. Children inherit the
  // re-render because the icon URLs are computed inside the render body.
  useExplorerIconsReady();
  // When the Sort dropdown is hidden the user has no way to change the mode
  // from this surface, so honoring a persisted value (set by another surface
  // sharing the same key, e.g. the Secondary Folder Tree extension) would
  // leave the sidebar stuck on a mode the user can't see or unset. Force
  // "default" (folders first, VSCode-style) in that case.
  const [sortMode, setSortModeState] = useState<SortMode>(() =>
    hideSort ? "default" : readStoredSortMode(),
  );
  const setSortMode = useCallback((value: SortMode) => {
    setSortModeState(value);
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, value);
    } catch {
      // Best-effort persistence; ignore failures.
    }
  }, []);
  const tree = useFileTree(rootPath, {
    onPathRenamed,
    onPathDeleted,
    includeHidden: showHiddenFiles,
    sortMode,
  });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isSearchActive, setIsSearchActive] = useState(false);
  const [isGrepOpen, setIsGrepOpen] = useState(false);
  const [isGrepActive, setIsGrepActive] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<ExplorerSearchHandle>(null);
  const grepRef = useRef<ExplorerGrepHandle>(null);

  type FlatItem = { path: string; isDir: boolean };
  const flat = useMemo<FlatItem[]>(() => {
    if (!rootPath) return [];
    const out: FlatItem[] = [];
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

  useEffect(() => {
    if (selectedPath && !flat.some((f) => f.path === selectedPath)) {
      setSelectedPath(null);
    }
  }, [flat, selectedPath]);

  // --- Reveal active file ---------------------------------------------------
  // Effect 1 only re-fires when `activeFilePath` (or rootPath) changes, so a
  // user-initiated collapse of the file's parent folder stays collapsed even
  // though the file is still the active tab. Effect 2 waits for the lazy
  // fetches to land and selects + scrolls. Selection is deferred until the
  // row is in `flat`, otherwise the "drop stale selectedPath" effect above
  // would clear it before the file is visible.
  const revealTargetRef = useRef<string | null>(null);
  const normalizedActiveFile = useMemo(
    () => (activeFilePath ? toForwardSlash(activeFilePath) : null),
    [activeFilePath],
  );
  useEffect(() => {
    if (!normalizedActiveFile || !rootPath) {
      revealTargetRef.current = null;
      return;
    }
    const rootNorm = toForwardSlash(rootPath).replace(/\/+$/, "");
    const isUnderRoot =
      normalizedActiveFile === rootNorm || normalizedActiveFile.startsWith(rootNorm + "/");
    if (!isUnderRoot) {
      // File lives outside the workspace root (different drive, etc.) -
      // nothing to reveal.
      revealTargetRef.current = null;
      return;
    }
    if (normalizedActiveFile === rootNorm) {
      // The "file" is the workspace root itself; no tree row exists for it.
      revealTargetRef.current = null;
      return;
    }
    // Expand every intermediate folder so the row will eventually land in
    // `flat`. `ancestorFolders` returns `[]` for files sitting directly
    // under `rootNorm` - that's correct, no expansion needed there.
    const ancestors = ancestorFolders(rootPath, normalizedActiveFile);
    for (const a of ancestors) tree.expand(a);
    revealTargetRef.current = normalizedActiveFile;
  }, [normalizedActiveFile, rootPath, tree.expand]);

  // Select + scroll once the row appears in `flat` (after the fetches
  // triggered above commit). Cleared on success so a later collapse +
  // flat-shrink doesn't trigger an unwanted re-scroll. Also re-fires on
  // uncollapse - the list DOM is unmounted while `collapsed`, so the very
  // first scroll attempt can find no element and we'd never retry without
  // this dep.
  useEffect(() => {
    if (collapsed) return;
    const target = revealTargetRef.current;
    if (!target) return;
    if (!flat.some((f) => f.path === target)) return;
    setSelectedPath(target);
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-fs-path="${CSS.escape(target)}"]`,
    );
    if (el) {
      el.scrollIntoView({ block: "nearest" });
      revealTargetRef.current = null;
    }
  }, [flat, collapsed]);

  useGlobalShortcuts({
    "explorer.search": () => {
      if (collapsed) onToggleCollapsed?.();
      if (searchRef.current?.isFocused()) {
        setIsSearchOpen(false);
        return;
      }
      setIsGrepOpen(false);
      setIsSearchOpen(true);
      searchRef.current?.focus();
    },
    "explorer.grep": () => {
      if (collapsed) onToggleCollapsed?.();
      if (grepRef.current?.isFocused()) {
        setIsGrepOpen(false);
        return;
      }
      setIsSearchOpen(false);
      setIsGrepOpen(true);
      grepRef.current?.focus();
    },
    "explorer.replaceAll": () => {
      // VSCode-style: Ctrl+Shift+H opens the folder-wide grep panel with the
      // replace input already expanded so the user can type and apply
      // without an extra click.
      if (collapsed) onToggleCollapsed?.();
      setIsSearchOpen(false);
      setIsGrepOpen(true);
      grepRef.current?.focusWithReplace();
    },
  });

  useEffect(() => {
    if (collapsed) {
      setIsSearchOpen(false);
      setIsGrepOpen(false);
    }
  }, [collapsed]);

  if (!rootPath) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <HugeiconsIcon
          icon={Folder01Icon}
          size={24}
          strokeWidth={1.5}
          className="text-muted-foreground"
        />
        <div className="text-muted-foreground text-xs">No current directory</div>
      </div>
    );
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (collapsed) return;
    if (tree.renaming || tree.pendingCreate || isSearchOpen || isGrepOpen) return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      return;
    if (flat.length === 0) return;

    const currentIdx = selectedPath ? flat.findIndex((f) => f.path === selectedPath) : -1;

    const move = (next: number) => {
      const clamped = Math.max(0, Math.min(flat.length - 1, next));
      const path = flat[clamped].path;
      setSelectedPath(path);
      requestAnimationFrame(() => {
        const el = listRef.current?.querySelector<HTMLElement>(
          `[data-fs-path="${CSS.escape(path)}"]`,
        );
        el?.scrollIntoView({ block: "nearest" });
      });
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
      case "Enter":
        if (currentIdx < 0) return;
        e.preventDefault();
        {
          const item = flat[currentIdx];
          if (item.isDir) tree.toggle(item.path);
          else onOpenFile(item.path);
        }
        break;
    }
  };

  return (
    <div
      className="flex h-full flex-col outline-none"
      role="tree"
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <ExplorerHeader
        rootPath={rootPath}
        collapsed={collapsed}
        onToggleCollapsed={onToggleCollapsed}
        dragHandle={dragHandle}
        hideCreateActions={hideCreateActions}
        hideGrep={hideGrep}
        hideSort={hideSort}
        headerExtras={headerExtras}
        sortMode={sortMode}
        setSortMode={setSortMode}
        expandedSize={tree.expanded.size}
        onToggleSearch={() => {
          setIsGrepOpen(false);
          setIsSearchOpen((v) => !v);
        }}
        onToggleGrep={() => {
          setIsSearchOpen(false);
          setIsGrepOpen((v) => !v);
        }}
        onNewFile={() => tree.beginCreate(rootPath, "file")}
        onNewFolder={() => tree.beginCreate(rootPath, "dir")}
        onRefresh={() => tree.refresh(rootPath)}
        onCollapseAll={() => tree.collapseAll()}
      />

      {collapsed ? null : (
        <ExplorerTreeList
          rootPath={rootPath}
          tree={tree}
          onOpenFile={onOpenFile}
          onRevealInTerminal={onRevealInTerminal}
          onAttachToAgent={onAttachToAgent}
          onPreviewInBrowser={onPreviewInBrowser}
          selectedPath={selectedPath}
          onSelectPath={setSelectedPath}
          searchRef={searchRef}
          grepRef={grepRef}
          listRef={listRef}
          isSearchOpen={isSearchOpen}
          isGrepOpen={isGrepOpen}
          isSearchActive={isSearchActive}
          isGrepActive={isGrepActive}
          onSearchRequestClose={() => setIsSearchOpen(false)}
          onGrepRequestClose={() => setIsGrepOpen(false)}
          onSearchActiveChange={setIsSearchActive}
          onGrepActiveChange={setIsGrepActive}
        />
      )}
    </div>
  );
}
