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
};

function basename(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) || trimmed : trimmed;
}

export function SshFileExplorer({ sessionId, hostLabel }: Props) {
  const showHiddenFiles = usePreferencesStore((s) => s.showHiddenFiles);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);

  // Pull the remote home directory the first time we see a fresh session id.
  // SFTP `canonicalize(".")` lands the user wherever sshd points sftp-server
  // at start (typically $HOME) — that's the natural root and avoids
  // surprising the user with `/`.
  useEffect(() => {
    if (sessionId === null) {
      setRootPath(null);
      setRootError(null);
      return;
    }
    let cancelled = false;
    setRootError(null);
    void sftpHome(sessionId)
      .then((home) => {
        if (cancelled) return;
        setRootPath(home || "/");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        // Fall back to root so the user still sees *something* rather than
        // a stuck empty panel; the read_dir call will surface its own error.
        setRootPath("/");
        setRootError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const tree = useSshFileTree(sessionId, rootPath, { includeHidden: showHiddenFiles });

  if (sessionId === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
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
    );
  }

  if (rootPath === null) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-[11px]">
        Resolving remote home…
      </div>
    );
  }

  const root = tree.nodes[rootPath];
  const pendingAtRoot = tree.pendingCreate?.parentPath === rootPath ? tree.pendingCreate : null;

  // Tree shapes are structurally identical between local and SSH — we cast
  // at this boundary so the existing recursive renderer can be reused
  // without a parameterised refactor.
  const treeForNode = tree as unknown as ReturnType<typeof useFileTree>;

  return (
    <div className="flex h-full flex-col outline-none">
      <div className="border-border/60 flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-foreground/80 flex flex-1 items-center gap-1.5 truncate text-xs font-medium">
              <HugeiconsIcon
                icon={CloudServerIcon}
                size={13}
                strokeWidth={2}
                className="text-muted-foreground shrink-0"
              />
              <span className="truncate">{hostLabel ?? "remote"}</span>
              <span className="text-muted-foreground truncate font-mono text-[10px]">
                {basename(rootPath)}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{rootPath}</TooltipContent>
        </Tooltip>

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
      </div>

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
                    // File-open via SFTP is deferred; clicking a file is a
                    // no-op for now. Users edit through the live SSH shell.
                    onOpenFile={() => {}}
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
          <ContextMenuItem className={COMPACT_ITEM} onSelect={() => void copyToClipboard(rootPath)}>
            Copy Path
          </ContextMenuItem>
          <ContextMenuItem className={COMPACT_ITEM} onSelect={() => tree.refresh(rootPath)}>
            Refresh
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
