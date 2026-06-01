import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ExplorerGrep, type ExplorerGrepHandle } from "../ExplorerGrep";
import { ExplorerSearch, type ExplorerSearchHandle } from "../ExplorerSearch";
import { FileTreeNode } from "../FileTreeNode";
import { InlineInput } from "../InlineInput";
import { copyToClipboard, revealInFinder } from "../lib/contextActions";
import { fileIconUrl, folderIconUrl } from "../lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "../lib/menuItemClass";
import { useFileTree } from "../lib/useFileTree";

type Tree = ReturnType<typeof useFileTree>;

type Props = {
  rootPath: string;
  tree: Tree;
  onOpenFile: (path: string, pin?: boolean) => void;
  onRevealInTerminal?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  searchRef: React.Ref<ExplorerSearchHandle>;
  grepRef: React.Ref<ExplorerGrepHandle>;
  listRef: React.RefObject<HTMLDivElement | null>;
  isSearchOpen: boolean;
  isGrepOpen: boolean;
  isSearchActive: boolean;
  isGrepActive: boolean;
  onSearchRequestClose: () => void;
  onGrepRequestClose: () => void;
  onSearchActiveChange: (active: boolean) => void;
  onGrepActiveChange: (active: boolean) => void;
};

export function ExplorerTreeList({
  rootPath,
  tree,
  onOpenFile,
  onRevealInTerminal,
  onAttachToAgent,
  selectedPath,
  onSelectPath,
  searchRef,
  grepRef,
  listRef,
  isSearchOpen,
  isGrepOpen,
  isSearchActive,
  isGrepActive,
  onSearchRequestClose,
  onGrepRequestClose,
  onSearchActiveChange,
  onGrepActiveChange,
}: Props) {
  const root = tree.nodes[rootPath];
  const pendingAtRoot = tree.pendingCreate?.parentPath === rootPath ? tree.pendingCreate : null;

  return (
    <>
      <ExplorerSearch
        ref={searchRef}
        rootPath={rootPath}
        onOpenFile={onOpenFile}
        open={isSearchOpen}
        onRequestClose={onSearchRequestClose}
        onActiveChange={onSearchActiveChange}
      />

      <ExplorerGrep
        ref={grepRef}
        rootPath={rootPath}
        onOpenFile={onOpenFile}
        open={isGrepOpen}
        onRequestClose={onGrepRequestClose}
        onActiveChange={onGrepActiveChange}
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
                      onSelectPath={onSelectPath}
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
  );
}
