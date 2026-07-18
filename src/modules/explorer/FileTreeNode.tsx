import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { humanizeFsError } from "@/lib/fsError";
import { memo, useCallback, useState } from "react";
import { InlineInput } from "./InlineInput";
import { copyToClipboard, relativePath, revealInFinder } from "./lib/contextActions";
import { useGitDecoration } from "./lib/gitDecorations";
import { fileIconUrl, folderIconUrl } from "./lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "./lib/menuItemClass";
import type { DirEntry, useFileTree } from "./lib/useFileTree";
import { ChevronRight, Lock } from "lucide-react";

type Tree = ReturnType<typeof useFileTree>;

type Props = {
  entry: DirEntry;
  parentPath: string;
  rootPath: string;
  depth: number;
  tree: Tree;
  /** Open a file. `pin: true` is a persistent open (e.g. context menu Open);
   *  omit to let the caller pick the default (preview). */
  onOpenFile: (path: string, pin?: boolean) => void;
  onRevealInTerminal?: (path: string) => void;
  onAttachToAgent?: (path: string) => void;
  /** Open an HTML file in the in-app browser preview. */
  onPreviewInBrowser?: (path: string) => void;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
  /** Set by the SFTP tree. Hides actions that only make sense for a path on
   *  this machine, so a remote row never offers something guaranteed to fail. */
  remote?: boolean;
};

function FileTreeNodeImpl({
  entry,
  parentPath,
  rootPath,
  depth,
  tree,
  onOpenFile,
  onRevealInTerminal,
  onAttachToAgent,
  onPreviewInBrowser,
  selectedPath,
  onSelectPath,
  remote = false,
}: Props) {
  const path = tree.joinPath(parentPath, entry.name);
  const isDir = entry.kind === "dir";
  // HTML files get a "Preview in Browser" action (opens via file:// URL).
  const isHtml = !isDir && /\.(html?|xhtml)$/i.test(entry.name);
  const isExpanded = isDir && tree.expanded.has(path);
  const children = isExpanded ? tree.nodes[path] : undefined;
  const isRenaming = tree.renaming === path;

  const [confirmDelete, setConfirmDelete] = useState(false);

  const iconUrl = isDir ? folderIconUrl(entry.name, isExpanded) : fileIconUrl(entry.name);

  // VSCode-style git status: colored name + M/A/U badge on files, rolled-up
  // color on folders with changed descendants, plus an ignored flag.
  const { deco, ignored } = useGitDecoration(path, isDir);
  // Dot-prefixed (hidden) or gitignored entries are de-emphasized like VSCode
  // so they don't compete with regular files for attention.
  const dim = entry.name.startsWith(".") || ignored;

  const handleNodeSelect = useCallback(() => {
    if (tree.renaming) return;
    onSelectPath(path);
    if (isDir) tree.toggle(path);
    else onOpenFile(path);
  }, [isDir, path, tree, onOpenFile, onSelectPath]);

  const isSelected = selectedPath === path;

  const pendingInThisDir =
    isDir && isExpanded && tree.pendingCreate?.parentPath === path ? tree.pendingCreate : null;

  // New file/folder target: directories target themselves, files target parent.
  const createTarget = isDir ? path : parentPath;

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {isRenaming ? (
            <div
              className="flex w-full items-center gap-2 px-1.5 py-1 text-[13px]"
              style={{ paddingLeft: 6 + depth * 12 }}
            >
              <span className="size-3.5 shrink-0" />
              {iconUrl ? (
                <img src={iconUrl} alt="" className="size-4 shrink-0" />
              ) : (
                <span className="size-4 shrink-0" />
              )}
              <InlineInput
                initial={entry.name}
                onCommit={tree.commitRename}
                onCancel={tree.cancelRename}
              />
            </div>
          ) : (
            <button
              type="button"
              data-fs-path={path}
              // No native `draggable` attribute on purpose. Tauri 2's default
              // `dragDropEnabled: true` installs an OS-level drag-drop target
              // that consumes HTML5 drag events before the WebView sees them,
              // so a native drag here would just produce a "not allowed"
              // cursor over every drop zone. Instead, drag handling is
              // synthesized from `mousedown`/`mousemove`/`mouseup` by
              // `useTerminalFileDrop.ts::ensureFsDragListener`, which hit-
              // tests the source against `[data-fs-path]` and the target
              // against `[data-terminal-leaf-id]`. See that file for the
              // full rationale.
              data-fs-kind={entry.kind}
              onClick={handleNodeSelect}
              onDoubleClick={() => !isDir && tree.beginRename(path)}
              className={cn(
                "group text-sidebar-foreground/85 hover:bg-sidebar-accent/40 relative flex w-full cursor-pointer items-center gap-2 px-1.5 py-0.5 text-left text-[13px] transition-colors",
                isSelected &&
                  "bg-sidebar-accent text-sidebar-accent-foreground shadow-[inset_2px_0_0_0_var(--ring)]",
              )}
              style={{ paddingLeft: 6 + depth * 12 }}
            >
              <span className="text-muted-foreground flex size-3.5 shrink-0 items-center justify-center">
                {isDir ? (
                  <ChevronRight
                    size={12}
                    strokeWidth={2.25}
                    className={cn("transition-transform", isExpanded && "rotate-90")}
                  />
                ) : null}
              </span>
              {iconUrl ? (
                <img src={iconUrl} alt="" className={cn("size-4 shrink-0", dim && "opacity-50")} />
              ) : (
                <span className="size-4 shrink-0" />
              )}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  dim && "opacity-50",
                  deco?.tone,
                  deco?.status === "deleted" && "line-through",
                )}
              >
                {entry.name}
              </span>
              {/* Remote (SFTP) rows carry a Unix mode summary; local rows leave
                  it undefined. Muted mono so it reads as metadata, not content.
                  mr-2 clears the ScrollArea overlay thumb like the git letter. */}
              {entry.permissions && (
                <span className="text-muted-foreground/60 mr-2 shrink-0 font-mono text-[10px] tracking-tight tabular-nums">
                  {entry.permissions}
                </span>
              )}
              {deco && !isDir && (
                <span
                  className={cn(
                    // mr-2 keeps the M/A/U git letter clear of the 10px Radix
                    // ScrollArea overlay thumb without insetting the full-bleed row.
                    "mr-2 w-3 shrink-0 text-center font-mono text-[10px] font-semibold tabular-nums",
                    deco.tone,
                  )}
                >
                  {deco.letter}
                </span>
              )}
            </button>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent
          className={COMPACT_CONTENT}
          onCloseAutoFocus={(e) => {
            if (tree.renaming || tree.pendingCreate) e.preventDefault();
          }}
        >
          {!isDir && (
            <ContextMenuItem className={COMPACT_ITEM} onSelect={() => onOpenFile(path, true)}>
              Open
            </ContextMenuItem>
          )}
          {isHtml && onPreviewInBrowser && (
            <ContextMenuItem className={COMPACT_ITEM} onSelect={() => onPreviewInBrowser(path)}>
              Open in Browser
            </ContextMenuItem>
          )}
          {isDir && onRevealInTerminal && (
            <ContextMenuItem className={COMPACT_ITEM} onSelect={() => onRevealInTerminal(path)}>
              Open in Terminal
            </ContextMenuItem>
          )}
          {/* Local-only: revealInFinder hands the path to the host OS file
              manager, which cannot resolve a remote POSIX path. */}
          {!remote && (
            <ContextMenuItem className={COMPACT_ITEM} onSelect={() => void revealInFinder(path)}>
              Reveal in Finder
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => tree.beginCreate(createTarget, "file")}
          >
            New File
          </ContextMenuItem>
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => tree.beginCreate(createTarget, "dir")}
          >
            New Folder
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem className={COMPACT_ITEM} onSelect={() => void copyToClipboard(path)}>
            Copy Path
          </ContextMenuItem>
          <ContextMenuItem
            className={COMPACT_ITEM}
            onSelect={() => void copyToClipboard(relativePath(rootPath, path))}
          >
            Copy Relative Path
          </ContextMenuItem>
          <ContextMenuSeparator />
          {onAttachToAgent && (
            <>
              <ContextMenuItem className={COMPACT_ITEM} onSelect={() => onAttachToAgent(path)}>
                Attach to Agent
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem className={COMPACT_ITEM} onSelect={() => tree.beginRename(path)}>
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            className={COMPACT_ITEM}
            variant="destructive"
            onSelect={() => setConfirmDelete(true)}
          >
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {isDir ? "folder" : "file"} &quot;{entry.name}&quot;?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isDir
                ? `"${entry.name}" and everything inside it will be deleted. This cannot be undone.`
                : `"${entry.name}" will be deleted. This cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void tree.deletePath(path)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {pendingInThisDir && (
        <div
          className="flex w-full items-center gap-2 px-1.5 py-0.5 text-[13px]"
          style={{ paddingLeft: 6 + (depth + 1) * 12 }}
        >
          <span className="size-3.5 shrink-0" />
          <img
            src={
              pendingInThisDir.kind === "dir" ? folderIconUrl("", false) : fileIconUrl("untitled")
            }
            alt=""
            className="size-4 shrink-0 opacity-70"
          />
          <InlineInput
            initial=""
            placeholder={pendingInThisDir.kind === "dir" ? "New folder" : "New file"}
            onCommit={tree.commitCreate}
            onCancel={tree.cancelCreate}
          />
        </div>
      )}

      {isDir && isExpanded && children?.status === "loading" && (
        <div
          className="text-muted-foreground px-2 py-0.5 text-[11px]"
          style={{ paddingLeft: 6 + (depth + 1) * 12 + 18 }}
        >
          Loading…
        </div>
      )}
      {isDir &&
        isExpanded &&
        children?.status === "error" &&
        (() => {
          // Permission-denied / missing folders are expected, not app faults:
          // show a clear message (lock glyph for denied) in a muted tone, and
          // keep the loud destructive tone only for genuinely unexpected errors.
          const err = humanizeFsError(children.message);
          return (
            <div
              className={cn(
                "flex items-center gap-1 px-2 py-0.5 text-[11px]",
                err.kind === "other" ? "text-destructive" : "text-muted-foreground",
              )}
              style={{ paddingLeft: 6 + (depth + 1) * 12 + 18 }}
              title={err.raw}
            >
              {err.kind === "denied" ? (
                <Lock size={11} strokeWidth={2} className="shrink-0" />
              ) : null}
              <span className="truncate">{err.message}</span>
            </div>
          );
        })()}
      {isDir &&
        isExpanded &&
        children?.status === "loaded" &&
        children.entries.map((child) => (
          <FileTreeNode
            key={child.name}
            entry={child}
            parentPath={path}
            rootPath={rootPath}
            depth={depth + 1}
            tree={tree}
            onOpenFile={onOpenFile}
            onRevealInTerminal={onRevealInTerminal}
            onAttachToAgent={onAttachToAgent}
            onPreviewInBrowser={onPreviewInBrowser}
            selectedPath={selectedPath}
            onSelectPath={onSelectPath}
            remote={remote}
          />
        ))}
    </>
  );
}

export const FileTreeNode = memo(FileTreeNodeImpl);
