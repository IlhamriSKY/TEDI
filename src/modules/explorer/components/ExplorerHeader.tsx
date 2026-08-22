import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  DESTRUCTIVE_ACTION,
  HEADER_TOGGLE_ACTIVE,
  HEADER_TOGGLE_IDLE,
} from "@/lib/toolbarButton";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { folderIconUrl } from "../lib/iconResolver";
import { type SortMode } from "../lib/useFileTree";
import { basename } from "@/lib/path";
import { SORT_LABELS, SORT_MODES } from "../lib/sortModes";
import {
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FilePlus,
  FileSearch,
  FolderPlus,
  PanelLeft,
  PanelRight,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

type Props = {
  rootPath: string;
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  /** Sidebar-section reorder controls (grip), injected by the sidebar. */
  dragHandle?: React.ReactNode;
  hideCreateActions: boolean;
  hideGrep: boolean;
  hideSort: boolean;
  headerExtras?: React.ReactNode;
  sortMode: SortMode;
  setSortMode: (value: SortMode) => void;
  expandedSize: number;
  onToggleSearch: () => void;
  onToggleGrep: () => void;
  /** Whether each search surface is currently open, so its button can read as
   *  pressed. Without it the row gives no sign which one you are looking at. */
  searchActive?: boolean;
  grepActive?: boolean;
  /** Turns the folder icon left of the name into the "open a folder to browse"
   *  control. The secondary folder tree passes it and drops its separate
   *  FolderOpen button, which is one fewer thing in an already crowded row. */
  onPickFolder?: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
  onCollapseAll: () => void;
  /** Left-sidebar instance: move the Files section to the shared right panel. */
  onMoveToRight?: () => void;
  /** Right-panel instance: dock the Files section back into the left sidebar. */
  onMoveToLeft?: () => void;
  /** Right-panel instance: close the panel (keeps the dock; the status-bar icon reopens). */
  onClose?: () => void;
};

export function ExplorerHeader({
  rootPath,
  collapsed,
  onToggleCollapsed,
  dragHandle,
  hideCreateActions,
  hideGrep,
  hideSort,
  headerExtras,
  sortMode,
  setSortMode,
  expandedSize,
  onToggleSearch,
  onToggleGrep,
  searchActive = false,
  grepActive = false,
  onPickFolder,
  onNewFile,
  onNewFolder,
  onRefresh,
  onCollapseAll,
  onMoveToRight,
  onMoveToLeft,
  onClose,
}: Props) {
  const accordion = !!onToggleCollapsed;
  // The folder glyph is a SIBLING of the title, not nested inside it, for two
  // reasons: every other panel header in either column is grip / icon / title /
  // divider / actions, and `onPickFolder` turns this one into a button - which
  // inside the accordion variant's own <button> would be invalid HTML.
  const folderIcon = (
    <img
      src={folderIconUrl(basename(rootPath), false)}
      alt=""
      height={15}
      width={15}
      className="shrink-0"
    />
  );
  const titleNode = (
    <span className="text-foreground/80 flex min-w-0 flex-1 items-center truncate text-xs font-medium">
      {accordion ? (
        collapsed ? (
          <ChevronRight
            size={10}
            strokeWidth={2.25}
            className="text-muted-foreground mr-1 shrink-0"
          />
        ) : (
          <ChevronDown
            size={10}
            strokeWidth={2.25}
            className="text-muted-foreground mr-1 shrink-0"
          />
        )
      ) : null}
      <span className="truncate">{basename(rootPath)}</span>
    </span>
  );

  return (
    <div className="tedi-panel-header">
      {dragHandle}
      {onPickFolder ? (
        <IconTooltip label="Open a folder to browse" side="bottom">
          <button
            type="button"
            onClick={onPickFolder}
            aria-label="Open Folder"
            className="hover:bg-accent flex size-5 shrink-0 items-center justify-center rounded"
          >
            {folderIcon}
          </button>
        </IconTooltip>
      ) : (
        folderIcon
      )}
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

      {/* Actions. Hiding them while the section is minimized is the shared
          `.tedi-header-divider` rule's job now, not a ternary here - the other
          six headers get the same treatment from it, which they did not from
          this. */}
      <span className="tedi-header-divider" aria-hidden />
      <IconTooltip label="Search files" side="bottom">
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-6", searchActive ? HEADER_TOGGLE_ACTIVE : HEADER_TOGGLE_IDLE)}
          onClick={onToggleSearch}
          aria-label="Search files"
          aria-pressed={searchActive}
        >
          <Search size={13} strokeWidth={2} />
        </Button>
      </IconTooltip>

      {hideGrep ? null : (
        <IconTooltip label="Search in files" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className={cn("tedi-header-optional size-6", grepActive ? HEADER_TOGGLE_ACTIVE : HEADER_TOGGLE_IDLE)}
            onClick={onToggleGrep}
            aria-label="Search in files"
            aria-pressed={grepActive}
          >
            <FileSearch size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
      )}

      {hideCreateActions ? null : (
        <>
          <IconTooltip label="New file" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              className="tedi-header-optional text-muted-foreground hover:text-foreground size-6"
              onClick={onNewFile}
              aria-label="New file"
            >
              <FilePlus size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
          <IconTooltip label="New folder" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              className="tedi-header-optional text-muted-foreground hover:text-foreground size-6"
              onClick={onNewFolder}
              aria-label="New folder"
            >
              <FolderPlus size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>
        </>
      )}
      <IconTooltip label="Refresh" side="bottom">
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-6"
          onClick={onRefresh}
          aria-label="Refresh"
        >
          <RefreshCw size={13} strokeWidth={2} />
        </Button>
      </IconTooltip>
      <IconTooltip label="Collapse folders" side="bottom">
        <Button
          variant="ghost"
          size="icon"
          disabled={expandedSize === 0}
          className="tedi-header-optional text-muted-foreground hover:text-foreground size-6 disabled:opacity-40"
          onClick={onCollapseAll}
          aria-label="Collapse folders"
        >
          <ChevronsDownUp size={13} strokeWidth={2} />
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
                // A non-default sort is an active state like the two search
                // toggles, so it speaks the same colour. It used to say it in
                // plain `text-foreground`, which left one header row with two
                // different meanings of "on".
                className={cn(
                  "tedi-header-optional size-6",
                  sortMode === "default" ? HEADER_TOGGLE_IDLE : HEADER_TOGGLE_ACTIVE,
                )}
              >
                <ArrowUpDown size={13} strokeWidth={2} />
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
      {onMoveToRight ? (
        <IconTooltip label="Move to right panel" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={onMoveToRight}
            aria-label="Move Files to the right panel"
          >
            <PanelRight size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
      ) : null}
      {onMoveToLeft ? (
        <IconTooltip label="Move to left sidebar" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={onMoveToLeft}
            aria-label="Move Files to the left sidebar"
          >
            <PanelLeft size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
      ) : null}
      {headerExtras}
      {onClose ? (
        <IconTooltip label="Close panel" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className={cn(DESTRUCTIVE_ACTION, "size-6")}
            onClick={onClose}
            aria-label="Close Files panel"
          >
            <X size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
      ) : null}
    </div>
  );
}
