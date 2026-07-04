import { Button } from "@/components/ui/button";
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
  RefreshCw,
  Search,
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
  onNewFile: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
  onCollapseAll: () => void;
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
  onNewFile,
  onNewFolder,
  onRefresh,
  onCollapseAll,
}: Props) {
  const accordion = !!onToggleCollapsed;
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
    <div className="border-border/60 flex h-8 shrink-0 items-center gap-1 border-b px-2">
      {dragHandle}
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
          <span className="bg-border mx-1 h-5 w-px shrink-0" aria-hidden />
          <IconTooltip label="Search files" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-6"
              onClick={onToggleSearch}
              aria-label="Search files"
            >
              <Search size={13} strokeWidth={2} />
            </Button>
          </IconTooltip>

          {hideGrep ? null : (
            <IconTooltip label="Search in files" side="bottom">
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground size-6"
                onClick={onToggleGrep}
                aria-label="Search in files"
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
                  className="text-muted-foreground hover:text-foreground size-6"
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
                  className="text-muted-foreground hover:text-foreground size-6"
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
              <RefreshCw size={12} strokeWidth={2} />
            </Button>
          </IconTooltip>
          <IconTooltip label="Collapse folders" side="bottom">
            <Button
              variant="ghost"
              size="icon"
              disabled={expandedSize === 0}
              className="text-muted-foreground hover:text-foreground size-6 disabled:opacity-40"
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
                    className={
                      sortMode === "default"
                        ? "text-muted-foreground hover:text-foreground size-6"
                        : "text-foreground hover:text-foreground size-6"
                    }
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
          {headerExtras}
        </>
      )}
    </div>
  );
}
