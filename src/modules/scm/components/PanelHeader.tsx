import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ArrowDown01Icon,
  ArrowTurnBackwardIcon,
  ArrowUp01Icon,
  Cancel01Icon,
  GitBranchIcon,
  LinkSquare02Icon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { GitStatus } from "../types";

type PanelHeaderProps = {
  status: GitStatus | null;
  changeCount: number;
  historyOnly: boolean;
  loading: boolean;
  refresh: () => Promise<void> | void;
  onDiscardAll: () => void;
  onOpenInTab?: () => void;
  onClose?: () => void;
};

export function PanelHeader({
  status,
  changeCount,
  historyOnly,
  loading,
  refresh,
  onDiscardAll,
  onOpenInTab,
  onClose,
}: PanelHeaderProps) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 px-2">
      <HugeiconsIcon
        icon={GitBranchIcon}
        size={13}
        strokeWidth={2}
        className="text-muted-foreground shrink-0"
      />
      {status?.branch ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-foreground/80 flex-1 truncate text-xs font-medium">
              {status.isRepo ? (status.branch ?? "HEAD") : "Source Control"}
              {status.isRepo && changeCount > 0 ? (
                <span className="text-muted-foreground ml-1.5 text-[10.5px] tabular-nums">
                  ({changeCount})
                </span>
              ) : null}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">{status.branch}</TooltipContent>
        </Tooltip>
      ) : (
        <span className="text-foreground/80 flex-1 truncate text-xs font-medium">
          {status?.isRepo ? (status.branch ?? "HEAD") : "Source Control"}
          {status?.isRepo && changeCount > 0 ? (
            <span className="text-muted-foreground ml-1.5 text-[10.5px] tabular-nums">
              ({changeCount})
            </span>
          ) : null}
        </span>
      )}
      {status?.isRepo && status.ahead > 0 ? (
        <span className="text-muted-foreground inline-flex items-center gap-0.5 text-[10.5px] tabular-nums">
          <HugeiconsIcon icon={ArrowUp01Icon} size={10} strokeWidth={2.25} />
          {status.ahead}
        </span>
      ) : null}
      {status?.isRepo && status.behind > 0 ? (
        <span className="text-muted-foreground inline-flex items-center gap-0.5 text-[10.5px] tabular-nums">
          <HugeiconsIcon icon={ArrowDown01Icon} size={10} strokeWidth={2.25} />
          {status.behind}
        </span>
      ) : null}
      <span className="bg-border mx-1 h-5 w-px shrink-0" aria-hidden />
      {!historyOnly && status?.isRepo && changeCount > 0 ? (
        <IconTooltip label="Discard all changes" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive size-6"
            onClick={onDiscardAll}
            aria-label="Discard all changes"
          >
            <HugeiconsIcon icon={ArrowTurnBackwardIcon} size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
      ) : null}
      <IconTooltip label="Refresh" side="bottom">
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-foreground size-6"
          onClick={() => void refresh()}
          aria-label="Refresh"
          disabled={loading}
        >
          <HugeiconsIcon icon={Refresh01Icon} size={12} strokeWidth={2} />
        </Button>
      </IconTooltip>
      {onOpenInTab ? (
        <IconTooltip label="Open in a tab" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={onOpenInTab}
            aria-label="Open Source Control in a tab"
          >
            <HugeiconsIcon icon={LinkSquare02Icon} size={12} strokeWidth={2} />
          </Button>
        </IconTooltip>
      ) : null}
      {onClose ? (
        <IconTooltip label="Close panel" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="hover:bg-destructive/10 hover:text-destructive text-muted-foreground size-6"
            onClick={onClose}
            aria-label="Close Source Control panel"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          </Button>
        </IconTooltip>
      ) : null}
    </div>
  );
}
