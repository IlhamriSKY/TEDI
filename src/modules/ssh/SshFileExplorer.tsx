import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FileTreeNode } from "@/modules/explorer/FileTreeNode";
import { InlineInput } from "@/modules/explorer/InlineInput";
import { copyToClipboard } from "@/modules/explorer/lib/contextActions";
import {
  fileIconUrl,
  folderIconUrl,
  useExplorerIconsReady,
} from "@/modules/explorer/lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "@/modules/explorer/lib/menuItemClass";
import type { useFileTree } from "@/modules/explorer/lib/useFileTree";
import { basename } from "@/lib/path";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useEffect, useState, type ReactNode } from "react";
import { sftpHome } from "./sftp";
import { useSshFileTree } from "./useSshFileTree";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  FolderPlus,
  RefreshCw,
  Server,
} from "lucide-react";

// SSH explorer panel. Shown only when at least one SSH leaf is connected.
// Swaps to whichever SSH session was last connected, so switching tabs
// updates the tree without remounting.
//
// All operations run as the remote SSH user. The remote kernel enforces
// permissions and returns `permission denied` per-branch.

type Props = {
  /** Russh session id. Null renders the empty state. */
  sessionId: number | null;
  /** `user@host:port` label for the header. */
  hostLabel: string | null;
  /** Last-known cwd of the active SSH terminal leaf (from OSC 7). If set, roots the tree here instead of the SFTP home. */
  currentCwd?: string | null;
  /** Opens a remote file in an editor leaf. Caller must thread `sessionId` + `hostLabel` so reads/writes use SFTP. */
  onOpenFile?: (path: string, sessionId: number, hostLabel: string | null) => void;
  /** Accordion mode: header becomes a toggle and the body hides when `collapsed`. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /** Sidebar-section reorder grip, injected by the sidebar. Mirrors the local file tree. */
  dragHandle?: ReactNode;
};

export function SshFileExplorer({
  sessionId,
  hostLabel,
  currentCwd,
  onOpenFile,
  collapsed = false,
  onToggleCollapsed,
  dragHandle,
}: Props) {
  const showHiddenFiles = usePreferencesStore((s) => s.showHiddenFiles);
  // Re-render once the lazy-loaded catppuccin icon set arrives.
  useExplorerIconsReady();
  const [homePath, setHomePath] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  // Highlights the clicked row, matching the local file tree.
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Resolve the remote home once per session. Used as fallback when the
  // active terminal leaf has not yet reported a cwd via OSC 7.
  useEffect(() => {
    if (sessionId === null) {
      setHomePath(null);
      setRootError(null);
      return;
    }
    let cancelled = false;
    setRootError(null);
    void sftpHome(sessionId)
      .then((home) => {
        if (cancelled) return;
        setHomePath(home || "/");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Fall back to "/" so the user sees something. read_dir surfaces
        // its own error if that also fails.
        setHomePath("/");
        setRootError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Prefer the terminal cwd, else the SFTP home. Empty cwd means "unknown",
  // not "null", to avoid blanking the tree mid-session.
  const rootPath = currentCwd && currentCwd.length > 0 ? currentCwd : homePath;
  const tree = useSshFileTree(sessionId, rootPath, { includeHidden: showHiddenFiles });

  const accordion = !!onToggleCollapsed;
  const headerLabel = rootPath ? basename(rootPath) : (hostLabel ?? "SSH");

  const root = rootPath ? tree.nodes[rootPath] : undefined;
  const pendingAtRoot =
    rootPath && tree.pendingCreate?.parentPath === rootPath ? tree.pendingCreate : null;
  // Local and SSH tree shapes match, so cast here to reuse the recursive
  // renderer without parameterising it.
  const treeForNode = tree as unknown as ReturnType<typeof useFileTree>;

  const titleNode = (
    <span className="text-foreground/80 flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-medium">
      {accordion ? (
        collapsed ? (
          <ChevronRight size={10} strokeWidth={2.25} className="text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown size={10} strokeWidth={2.25} className="text-muted-foreground shrink-0" />
        )
      ) : null}
      {/* Mirrors the local FileExplorer header: one server icon plus the
          cwd basename. Full path and host go in the tooltip so the header
          stays a compact h-8 strip. */}
      <Server size={13} strokeWidth={2} className="text-muted-foreground shrink-0" />
      <span className="truncate">{headerLabel}</span>
    </span>
  );

  const headerActionsVisible = !collapsed && sessionId !== null && rootPath !== null;

  return (
    <div className="flex h-full flex-col outline-none">
      <div className="border-border/60 flex h-8 shrink-0 items-center gap-1 border-b px-2">
        {dragHandle}
        <Tooltip>
          <TooltipTrigger asChild>
            {accordion ? (
              <button
                type="button"
                onClick={onToggleCollapsed}
                className="hover:text-foreground flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 truncate outline-none"
                aria-expanded={!collapsed}
                aria-label={collapsed ? "Expand SSH files" : "Collapse SSH files"}
              >
                {titleNode}
              </button>
            ) : (
              titleNode
            )}
          </TooltipTrigger>
          <TooltipContent side="bottom" className="font-mono text-[11px]">
            <div>{hostLabel ?? "remote"}</div>
            <div className="text-muted-foreground">{rootPath ?? "-"}</div>
          </TooltipContent>
        </Tooltip>

        {headerActionsVisible && rootPath ? (
          <>
            <IconTooltip label="New file" side="bottom">
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground size-6"
                onClick={() => tree.beginCreate(rootPath, "file")}
                aria-label="New file"
              >
                <FilePlus size={13} strokeWidth={2} />
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
                <FolderPlus size={13} strokeWidth={2} />
              </Button>
            </IconTooltip>
            <IconTooltip label="Refresh" side="bottom">
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground size-6"
                onClick={() => tree.refresh(rootPath)}
                aria-label="Refresh"
              >
                <RefreshCw size={12} strokeWidth={2} />
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
                <ChevronsDownUp size={13} strokeWidth={2} />
              </Button>
            </IconTooltip>
          </>
        ) : null}
      </div>

      {collapsed ? null : sessionId === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <Server size={24} strokeWidth={1.5} className="text-muted-foreground" />
          <div className="text-muted-foreground text-xs">
            No active SSH session.
            <br />
            Connect from the SSH menu to browse the remote tree.
          </div>
        </div>
      ) : rootPath === null ? (
        <div className="text-muted-foreground flex flex-1 items-center justify-center text-[11px]">
          Resolving remote home…
        </div>
      ) : (
        <>
          {rootError !== null ? (
            <div className="text-destructive border-border/60 border-b px-3 py-1.5 text-[11px]">
              {rootError}
            </div>
          ) : null}

          <ContextMenu>
            <ContextMenuTrigger asChild>
              <ScrollArea className="min-h-0 flex-1">
                <div className="py-1">
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
                        tree={treeForNode}
                        onOpenFile={(path) => {
                          if (sessionId !== null) {
                            onOpenFile?.(path, sessionId, hostLabel);
                          }
                        }}
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
        </>
      )}
    </div>
  );
}
