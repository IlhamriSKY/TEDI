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
import { fileIconUrl, folderIconUrl } from "@/modules/explorer/lib/iconResolver";
import { COMPACT_CONTENT, COMPACT_ITEM } from "@/modules/explorer/lib/menuItemClass";
import type { useFileTree } from "@/modules/explorer/lib/useFileTree";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  CloudServerIcon,
  FileAddIcon,
  FolderAddIcon,
  Refresh01Icon,
  UnfoldLessIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";
import { sftpHome } from "./sftp";
import { useSshFileTree } from "./useSshFileTree";

/// Sibling-panel SSH explorer. Visible only when there is at least one
/// connected SSH leaf; tracks whichever SSH session was last connected so
/// switching between SSH tabs swaps the tree to the right host without
/// remounting the panel (and without dropping the local explorer next to
/// it).
///
/// Security stance: every command is invoked against the remote SSH user's
/// channel. There's no path filtering / sandboxing on the TEDI side — the
/// kernel enforces permissions and surfaces `permission denied` to the
/// branch the user tried to expand, leaving sibling subtrees untouched.

type Props = {
  /** Russh session id; null = no live SSH session, render empty state. */
  sessionId: number | null;
  /** `user@host:port` style label for the panel header. */
  hostLabel: string | null;
  /** Last-known cwd of the active SSH terminal leaf (OSC 7). When set,
   *  the tree roots at this path instead of the SFTP-canonicalised
   *  home directory, mirroring how the local file tree follows
   *  whichever terminal pane is focused. */
  currentCwd?: string | null;
  /** Open a remote file in an editor leaf. Called with the full remote
   *  path; the caller is expected to thread `sessionId` + `hostLabel`
   *  into the new leaf so reads/writes go through SFTP. */
  onOpenFile?: (path: string, sessionId: number, hostLabel: string | null) => void;
  /** Accordion mode: when set, the header becomes a chevron toggle and the
   *  body is hidden while `collapsed` is true. */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
};

function basename(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}

export function SshFileExplorer({
  sessionId,
  hostLabel,
  currentCwd,
  onOpenFile,
  collapsed = false,
  onToggleCollapsed,
}: Props) {
  const showHiddenFiles = usePreferencesStore((s) => s.showHiddenFiles);
  const [homePath, setHomePath] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);

  // Resolve the remote home directory once per session as a fallback.
  // SFTP `canonicalize(".")` lands the user wherever sshd points
  // sftp-server at start (typically `$HOME`) — used when the active
  // terminal leaf hasn't reported a cwd yet (e.g. the shell hasn't
  // emitted OSC 7).
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
        // Fall back to root so the user still sees *something* rather than
        // a stuck empty panel; the read_dir call will surface its own error.
        setHomePath("/");
        setRootError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // Prefer the active terminal's cwd, fall back to the SFTP home.
  // Empty string from cwd is treated as "not yet known" so we don't
  // null-out the tree mid-session.
  const rootPath = currentCwd && currentCwd.length > 0 ? currentCwd : homePath;
  const tree = useSshFileTree(sessionId, rootPath, { includeHidden: showHiddenFiles });

  const accordion = !!onToggleCollapsed;
  const headerLabel = rootPath ? basename(rootPath) : (hostLabel ?? "SSH");

  const root = rootPath ? tree.nodes[rootPath] : undefined;
  const pendingAtRoot =
    rootPath && tree.pendingCreate?.parentPath === rootPath ? tree.pendingCreate : null;
  // Tree shapes are structurally identical between local and SSH — we cast
  // at this boundary so the existing recursive renderer can be reused
  // without a parameterised refactor.
  const treeForNode = tree as unknown as ReturnType<typeof useFileTree>;

  const titleNode = (
    <span className="text-foreground/80 flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-medium">
      {accordion ? (
        <HugeiconsIcon
          icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
          size={10}
          strokeWidth={2.25}
          className="text-muted-foreground shrink-0"
        />
      ) : null}
      {/* Mirror the local FileExplorer header layout: a single
          remote-server icon, then just the current directory's
          basename. The full path + host live in the tooltip,
          so the header stays a compact h-8 strip that doesn't
          cut off whichever piece (host or cwd basename) the
          user actually wants to read. */}
      <HugeiconsIcon
        icon={CloudServerIcon}
        size={13}
        strokeWidth={2}
        className="text-muted-foreground shrink-0"
      />
      <span className="truncate">{headerLabel}</span>
    </span>
  );

  const headerActionsVisible = !collapsed && sessionId !== null && rootPath !== null;

  return (
    <div className="flex h-full flex-col outline-none">
      <div className="border-border/60 flex h-8 shrink-0 items-center gap-1 border-b px-2">
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
            <div className="text-muted-foreground">{rootPath ?? "—"}</div>
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
          </>
        ) : null}
      </div>

      {collapsed ? null : sessionId === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <HugeiconsIcon
            icon={CloudServerIcon}
            size={24}
            strokeWidth={1.5}
            className="text-muted-foreground"
          />
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
                        selectedPath={null}
                        onSelectPath={() => {}}
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
