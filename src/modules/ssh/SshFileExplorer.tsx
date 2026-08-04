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
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { humanizeFsError } from "@/lib/fsError";
import { segmentsFromCwd } from "@/modules/statusbar/lib/pathUtils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setSshInRightPanel } from "@/modules/settings/store";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { sftpHome } from "./sftp";
import { useSshFileTree } from "./useSshFileTree";
import { useSshFileDrop } from "./useSshFileDrop";
import { useSshNav } from "./useSshNav";
import { useSshRightPanelStore } from "./sshRightPanelStore";
import { useSshBrowseStore } from "./sshBrowseStore";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  FolderPlus,
  Lock,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Server,
  X,
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
  /** Present only on the right-slot instance: closes the right-slot panel.
   *  Its presence also swaps the "move to right" header button for the
   *  "move back to left sidebar" + "close" pair. Mirrors SCM's PanelHeader. */
  onClose?: () => void;
};

export function SshFileExplorer({
  sessionId,
  hostLabel,
  currentCwd,
  onOpenFile,
  collapsed = false,
  onToggleCollapsed,
  dragHandle,
  onClose,
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

  // Base root follows the terminal cwd (OSC 7), else the SFTP home. Empty cwd
  // means "unknown", not "null", to avoid blanking the tree mid-session.
  const followRoot = currentCwd && currentCwd.length > 0 ? currentCwd : homePath;
  // Root navigation (Back / Forward / Up / breadcrumb). Tracks `followRoot`
  // until the user navigates, then pins to the chosen folder; resets when the
  // session changes so a reconnect never replays a stale path.
  const nav = useSshNav(followRoot, sessionId);
  const rootPath = nav.root;
  const tree = useSshFileTree(sessionId, rootPath, { includeHidden: showHiddenFiles });

  // Publish the browsed folder so Source Control can anchor remote git status on
  // it. The shell's $PWD is $HOME until the user cd's, which is almost never a
  // repository - the folder they navigated to here is what they mean.
  const publishBrowseRoot = useSshBrowseStore((s) => s.set);
  useEffect(() => {
    publishBrowseRoot(sessionId, rootPath);
  }, [publishBrowseRoot, sessionId, rootPath]);

  // Drag-and-drop upload: drop OS files onto this panel to SFTP them to the
  // remote folder under the cursor. Refresh (and reveal) the target dir after.
  const containerRef = useRef<HTMLDivElement>(null);
  const onUploaded = useCallback(
    (dir: string) => {
      tree.refresh(dir);
      if (dir !== rootPath) tree.expand(dir);
    },
    [tree, rootPath],
  );
  const upload = useSshFileDrop({ sessionId, rootPath, containerRef, onUploaded });
  // total 0 = size not known yet (first event) -> show indeterminate-ish 0%.
  const uploadPct =
    upload && upload.total > 0 ? Math.round((upload.written / upload.total) * 100) : 0;

  const accordion = !!onToggleCollapsed;
  const headerLabel = rootPath ? basename(rootPath) : (hostLabel ?? "SSH");

  const root = rootPath ? tree.nodes[rootPath] : undefined;
  const pendingAtRoot =
    rootPath && tree.pendingCreate?.parentPath === rootPath ? tree.pendingCreate : null;
  // Local and SSH tree shapes match, so cast here to reuse the recursive
  // renderer without parameterising it.
  //
  // `toggle` is wrapped to pin the root: expanding a folder is the user taking
  // the tree over, and the remote shell emits OSC 7 on every prompt, so without
  // this a plain `cd` in the SSH terminal moves `followRoot` and wipes the whole
  // expansion state they just built up. Pinning only on expand (not on a file
  // click) keeps auto-follow working while there is nothing open to lose.
  // `navTo` is a no-op once pinned, and Back returns to follow-mode.
  const treeForNode = useMemo(
    () =>
      ({
        ...tree,
        toggle: (path: string) => {
          if (rootPath) nav.navTo(rootPath);
          tree.toggle(path);
        },
      }) as unknown as ReturnType<typeof useFileTree>,
    [tree, nav, rootPath],
  );

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
    <div ref={containerRef} className="flex h-full flex-col outline-none">
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
                onClick={() => tree.refreshAllLoaded()}
                aria-label="Refresh"
              >
                <RefreshCw size={13} strokeWidth={2} />
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

        {/* Left-sidebar instance: move the Remote explorer to the right panel.
            Shown whenever it's the sidebar instance (has a reorder grip) and
            expanded, independent of session state - like SCM's move button. */}
        {dragHandle && !collapsed ? (
          <IconTooltip label="Move to right panel" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-6"
              onClick={() => {
                void setSshInRightPanel(true);
                useSshRightPanelStore.getState().openPanel();
              }}
              aria-label="Move Remote to the right panel"
            >
              <PanelRight size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        ) : null}
        {/* Right-panel instance: dock the Remote explorer back into the left sidebar. */}
        {onClose ? (
          <IconTooltip label="Move to left sidebar" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-6"
              onClick={() => {
                void setSshInRightPanel(false);
                useSshRightPanelStore.getState().closePanel();
              }}
              aria-label="Move Remote to the left sidebar"
            >
              <PanelLeft size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        ) : null}
        {onClose ? (
          <IconTooltip label="Close panel" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              className={cn(DESTRUCTIVE_ACTION, "size-6")}
              onClick={onClose}
              aria-label="Close Remote panel"
            >
              <X size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        ) : null}
      </div>

      {/* Navigation row: Back / Forward / Up plus a clickable breadcrumb of the
          current root. Lets the user climb out of the cwd (which the tree is
          otherwise pinned to) and jump to any ancestor, instead of only being
          able to expand downward. Reuses the status-bar path segmentation. */}
      {!collapsed && sessionId !== null && rootPath ? (
        <div className="border-border/60 flex h-7 shrink-0 items-center gap-0.5 border-b px-1.5">
          <IconTooltip label="Back" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              disabled={!nav.canBack}
              className="text-muted-foreground hover:text-foreground size-6 disabled:opacity-30"
              onClick={nav.back}
              aria-label="Back to previous folder"
            >
              <ArrowLeft size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
          <IconTooltip label="Forward" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              disabled={!nav.canForward}
              className="text-muted-foreground hover:text-foreground size-6 disabled:opacity-30"
              onClick={nav.forward}
              aria-label="Forward"
            >
              <ArrowRight size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
          <IconTooltip label="Up one folder" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              disabled={!nav.canUp}
              className="text-muted-foreground hover:text-foreground size-6 disabled:opacity-30"
              onClick={nav.up}
              aria-label="Up one folder"
            >
              <ArrowUp size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
          <div className="min-w-0 flex-1 overflow-x-auto">
            <div className="flex items-center gap-0.5 pr-1 whitespace-nowrap">
              {segmentsFromCwd(rootPath, homePath).map((s, i, arr) => {
                const isCurrent = i === arr.length - 1;
                return (
                  <span key={s.fullPath} className="flex items-center gap-0.5">
                    {i > 0 ? <span className="text-muted-foreground/40 text-[10px]">/</span> : null}
                    <button
                      type="button"
                      disabled={isCurrent}
                      onClick={() => nav.navTo(s.fullPath)}
                      title={s.fullPath}
                      className={cn(
                        "rounded px-1 py-0.5 text-[11px] transition-colors",
                        isCurrent
                          ? "text-foreground/80 font-medium"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer",
                      )}
                    >
                      {s.isHome ? "~" : s.label}
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {upload && !collapsed ? (
        <div className="border-border/60 shrink-0 border-b px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
            <span className="text-foreground/80 min-w-0 truncate">
              Uploading {upload.name}
              {upload.count > 1 ? ` (${upload.index}/${upload.count})` : ""}
            </span>
            <span className="text-muted-foreground shrink-0 tabular-nums">{uploadPct}%</span>
          </div>
          <div className="bg-muted h-1 w-full overflow-hidden rounded-full">
            <div
              className="bg-primary h-full rounded-full transition-[width] duration-150"
              style={{ width: `${uploadPct}%` }}
            />
          </div>
        </div>
      ) : null}

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
              {humanizeFsError(rootError).message}
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
                  {root?.status === "error" &&
                    (() => {
                      // A folder the remote user can't read (or that vanished)
                      // is an expected condition, not an app fault: show a clear
                      // message with a way back instead of a raw error string.
                      const err = humanizeFsError(root.message);
                      return (
                        <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                          {err.kind === "denied" ? (
                            <Lock
                              size={20}
                              strokeWidth={1.5}
                              className="text-muted-foreground/80"
                            />
                          ) : null}
                          <div className="text-muted-foreground text-[11px]" title={err.raw}>
                            {err.message}
                          </div>
                          {nav.canBack ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 gap-1 text-[11px]"
                              onClick={nav.back}
                            >
                              <ArrowLeft size={12} strokeWidth={2} />
                              Go back
                            </Button>
                          ) : nav.canUp ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 gap-1 text-[11px]"
                              onClick={nav.up}
                            >
                              <ArrowUp size={12} strokeWidth={2} />
                              Go up
                            </Button>
                          ) : null}
                        </div>
                      );
                    })()}
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
                        remote
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
              <ContextMenuItem className={COMPACT_ITEM} onSelect={() => tree.refreshAllLoaded()}>
                Refresh
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </>
      )}
    </div>
  );
}
