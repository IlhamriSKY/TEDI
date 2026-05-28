import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  FileAddIcon,
  FileSearchIcon,
  Folder01Icon,
  FolderAddIcon,
  Refresh01Icon,
  Search01Icon,
  Sorting02Icon,
  UnfoldLessIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExplorerGrep, type ExplorerGrepHandle } from "./ExplorerGrep";
import { ExplorerSearch, type ExplorerSearchHandle } from "./ExplorerSearch";
import { FileTreeNode } from "./FileTreeNode";
import { InlineInput } from "./InlineInput";
import { copyToClipboard, revealInFinder } from "./lib/contextActions";
import { fileIconUrl, folderIconUrl, useExplorerIconsReady } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import { useFileTree, type SortMode } from "./lib/useFileTree";
import { useGlobalShortcuts } from "@/modules/shortcuts";
import { usePreferencesStore } from "@/modules/settings/preferences";

const SORT_STORAGE_KEY = "tedi:explorer:sortMode";
const SORT_MODES: ReadonlyArray<SortMode> = [
  "default",
  "name-asc",
  "name-desc",
  "modified-desc",
  "modified-asc",
];
const SORT_LABELS: Record<SortMode, string> = {
  default: "Default (folders first)",
  "name-asc": "Name (A → Z)",
  "name-desc": "Name (Z → A)",
  "modified-desc": "Modified (newest first)",
  "modified-asc": "Modified (oldest first)",
};

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
};

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, "/");
}

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
  collapsed = false,
  onToggleCollapsed,
  hideCreateActions = false,
  hideGrep = false,
  hideSort = false,
  headerExtras,
  activeFilePath,
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

  const root = tree.nodes[rootPath];
  const pendingAtRoot = tree.pendingCreate?.parentPath === rootPath ? tree.pendingCreate : null;

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

  const accordion = !!onToggleCollapsed;
  const titleNode = (
    <span className="text-foreground/80 flex min-w-0 flex-1 items-center truncate text-xs font-medium">
      {accordion ? (
        <HugeiconsIcon
          icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
          size={10}
          strokeWidth={2.25}
          className="text-muted-foreground mr-1 shrink-0"
        />
      ) : null}
      <img
        src={folderIconUrl(basename(rootPath), false)}
        alt=""
        height={15}
        width={15}
        className="mx-1.5 shrink-0"
      />
      <span className="truncate">{basename(rootPath)}</span>
    </span>
  );

  return (
    <div className="flex h-full flex-col outline-none" tabIndex={0} onKeyDown={handleKeyDown}>
      <div className="border-border/60 flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            {accordion ? (
              <button
                type="button"
                onClick={onToggleCollapsed}
                className="hover:text-foreground flex min-w-0 flex-1 cursor-pointer items-center truncate outline-none"
                aria-expanded={!collapsed}
                aria-label={collapsed ? "Expand local files" : "Collapse local files"}
              >
                {titleNode}
              </button>
            ) : (
              titleNode
            )}
          </TooltipTrigger>
          <TooltipContent side="bottom">{rootPath}</TooltipContent>
        </Tooltip>

        {collapsed ? null : (
          <>
            <IconTooltip label="Search files" side="bottom">
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground size-6"
                onClick={() => {
                  setIsGrepOpen(false);
                  setIsSearchOpen((v) => !v);
                }}
                aria-label="Search files"
              >
                <HugeiconsIcon icon={Search01Icon} size={13} strokeWidth={2} />
              </Button>
            </IconTooltip>

            {hideGrep ? null : (
              <IconTooltip label="Search in files" side="bottom">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-foreground size-6"
                  onClick={() => {
                    setIsSearchOpen(false);
                    setIsGrepOpen((v) => !v);
                  }}
                  aria-label="Search in files"
                >
                  <HugeiconsIcon icon={FileSearchIcon} size={13} strokeWidth={2} />
                </Button>
              </IconTooltip>
            )}

            {hideCreateActions ? null : (
              <>
                <IconTooltip label="New file" side="bottom">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground size-6"
                    onClick={() => tree.beginCreate(rootPath, "file")}
                    aria-label="New file"
                  >
                    <HugeiconsIcon icon={FileAddIcon} size={13} strokeWidth={2} />
                  </Button>
                </IconTooltip>
                <IconTooltip label="New folder" side="bottom">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground size-6"
                    onClick={() => tree.beginCreate(rootPath, "dir")}
                    aria-label="New folder"
                  >
                    <HugeiconsIcon icon={FolderAddIcon} size={13} strokeWidth={2} />
                  </Button>
                </IconTooltip>
              </>
            )}
            <IconTooltip label="Refresh" side="bottom">
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground size-6"
                onClick={() => tree.refresh(rootPath)}
                aria-label="Refresh"
              >
                <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
              </Button>
            </IconTooltip>
            <IconTooltip label="Collapse folders" side="bottom">
              <Button
                variant="ghost"
                size="icon"
                disabled={tree.expanded.size === 0}
                className="text-muted-foreground hover:text-foreground size-6 disabled:opacity-40"
                onClick={() => tree.collapseAll()}
                aria-label="Collapse folders"
              >
                <HugeiconsIcon icon={UnfoldLessIcon} size={13} strokeWidth={2} />
              </Button>
            </IconTooltip>
            {!hideSort && (
              <DropdownMenu>
                <IconTooltip label={`Sort: ${SORT_LABELS[sortMode]}`} side="bottom">
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Sort entries"
                      className={
                        sortMode === "default"
                          ? "text-muted-foreground hover:text-foreground size-6"
                          : "text-foreground hover:text-foreground size-6"
                      }
                    >
                      <HugeiconsIcon icon={Sorting02Icon} size={13} strokeWidth={2} />
                    </Button>
                  </DropdownMenuTrigger>
                </IconTooltip>
                <DropdownMenuContent align="end" className="min-w-56">
                  <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuRadioGroup
                    value={sortMode}
                    onValueChange={(v) => setSortMode(v as SortMode)}
                  >
                    {SORT_MODES.map((mode) => (
                      <DropdownMenuRadioItem key={mode} value={mode}>
                        {SORT_LABELS[mode]}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {headerExtras}
          </>
        )}
      </div>

      {collapsed ? null : (
        <>
          <ExplorerSearch
            ref={searchRef}
            rootPath={rootPath}
            onOpenFile={onOpenFile}
            open={isSearchOpen}
            onRequestClose={() => setIsSearchOpen(false)}
            onActiveChange={setIsSearchActive}
          />

          <ExplorerGrep
            ref={grepRef}
            rootPath={rootPath}
            onOpenFile={onOpenFile}
            open={isGrepOpen}
            onRequestClose={() => setIsGrepOpen(false)}
            onActiveChange={setIsGrepActive}
          />

          {!isSearchActive && !isGrepActive ? (
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <ScrollArea className="min-h-0 flex-1">
                  <div className="py-1" ref={listRef}>
                    {pendingAtRoot && (
                      <div
                        className="flex w-full items-center gap-2 px-1.5 py-0.5 text-[13px]"
                        style={{ paddingLeft: 6 }}
                      >
                        <span className="size-3.5 shrink-0" />
                        <img
                          src={
                            pendingAtRoot.kind === "dir"
                              ? folderIconUrl("", false)
                              : fileIconUrl("untitled")
                          }
                          alt=""
                          className="size-4 shrink-0 opacity-70"
                        />
                        <InlineInput
                          initial=""
                          placeholder={pendingAtRoot.kind === "dir" ? "New folder" : "New file"}
                          onCommit={tree.commitCreate}
                          onCancel={tree.cancelCreate}
                        />
                      </div>
                    )}
                    {root?.status === "loading" && (
                      <div className="text-muted-foreground px-3 py-2 text-[11px]">Loading…</div>
                    )}
                    {root?.status === "error" && (
                      <div className="text-destructive px-3 py-2 text-[11px]">{root.message}</div>
                    )}
                    {root?.status === "loaded" &&
                      root.entries.map((entry) => (
                        <FileTreeNode
                          key={entry.name}
                          entry={entry}
                          parentPath={rootPath}
                          rootPath={rootPath}
                          depth={0}
                          tree={tree}
                          onOpenFile={onOpenFile}
                          onRevealInTerminal={onRevealInTerminal}
                          onAttachToAgent={onAttachToAgent}
                          selectedPath={selectedPath}
                          onSelectPath={setSelectedPath}
                        />
                      ))}
                  </div>
                </ScrollArea>
              </ContextMenuTrigger>
              <ContextMenuContent
                className={COMPACT_CONTENT}
                onCloseAutoFocus={(e) => {
                  if (tree.renaming || tree.pendingCreate) e.preventDefault();
                }}
              >
                {onRevealInTerminal && (
                  <ContextMenuItem
                    className={COMPACT_ITEM}
                    onSelect={() => onRevealInTerminal(rootPath)}
                  >
                    Open in Terminal
                  </ContextMenuItem>
                )}
                <ContextMenuItem
                  className={COMPACT_ITEM}
                  onSelect={() => void revealInFinder(rootPath)}
                >
                  Reveal in Finder
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className={COMPACT_ITEM}
                  onSelect={() => tree.beginCreate(rootPath, "file")}
                >
                  New File
                </ContextMenuItem>
                <ContextMenuItem
                  className={COMPACT_ITEM}
                  onSelect={() => tree.beginCreate(rootPath, "dir")}
                >
                  New Folder
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  className={COMPACT_ITEM}
                  onSelect={() => void copyToClipboard(rootPath)}
                >
                  Copy Path
                </ContextMenuItem>
                <ContextMenuItem className={COMPACT_ITEM} onSelect={() => tree.refresh(rootPath)}>
                  Refresh
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ) : null}
        </>
      )}
    </div>
  );
}
