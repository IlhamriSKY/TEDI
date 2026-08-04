import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setSourceControlInRightPanel } from "@/modules/settings/store";
import { useScmRightPanelStore } from "../scmRightPanelStore";
import type { GitBranch as GitBranchRef, GitStatus } from "../types";
import { BranchMenu } from "./BranchMenu";
import {
  ChevronDown,
  ChevronUp,
  CornerUpLeft,
  ExternalLink,
  GitBranch,
  PanelLeft,
  PanelRight,
  RefreshCw,
  X,
} from "lucide-react";

type PanelHeaderProps = {
  status: GitStatus | null;
  changeCount: number;
  historyOnly: boolean;
  loading: boolean;
  refresh: () => Promise<void> | void;
  /** Omitted only while the panel has no writable repository. */
  onDiscardAll?: () => void;
  onOpenInTab?: () => void;
  onClose?: () => void;
  /** Sidebar-section reorder + collapse controls, injected by the sidebar. */
  dragHandle?: React.ReactNode;
  /** Branch switching. Omitted turns the branch name back into a plain label. */
  loadBranches?: () => Promise<GitBranchRef[]>;
  onCheckout?: (name: string, create?: boolean) => Promise<void>;
  onDeleteBranch?: (name: string, force?: boolean) => Promise<void>;
  /** True while a git operation is in flight; blocks a branch switch on top. */
  busy?: boolean;
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
  dragHandle,
  loadBranches,
  onCheckout,
  onDeleteBranch,
  busy,
}: PanelHeaderProps) {
  // No change count here: each section header already carries its own, and the
  // one that mattered sat right of the branch name where it read as part of it.
  const switchable = status?.isRepo && loadBranches && onCheckout && onDeleteBranch;
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 px-2">
      {dragHandle}
      {switchable ? (
        <BranchMenu
          status={status}
          loadBranches={loadBranches}
          onCheckout={onCheckout}
          onDeleteBranch={onDeleteBranch}
          disabled={busy}
        />
      ) : (
        <>
          <GitBranch size={13} strokeWidth={2} className="text-icon-branch shrink-0" />
          <span className="text-foreground/80 min-w-0 flex-1 truncate text-xs font-medium">
            {status?.isRepo ? (status.branch ?? "HEAD") : "Source Control"}
          </span>
        </>
      )}
      {status?.isRepo && status.ahead > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5 text-[10.5px] tabular-nums">
              <ChevronUp size={10} strokeWidth={2.25} />
              {status.ahead}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {status.ahead} local commit{status.ahead === 1 ? "" : "s"} to push
          </TooltipContent>
        </Tooltip>
      ) : null}
      {status?.isRepo && status.behind > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-muted-foreground inline-flex shrink-0 items-center gap-0.5 text-[10.5px] tabular-nums">
              <ChevronDown size={10} strokeWidth={2.25} />
              {status.behind}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {status.behind} remote commit{status.behind === 1 ? "" : "s"} to pull
          </TooltipContent>
        </Tooltip>
      ) : null}
      <span className="bg-border mx-1 h-5 w-px shrink-0" aria-hidden />
      {onDiscardAll && !historyOnly && status?.isRepo && changeCount > 0 ? (
        <IconTooltip label="Discard all changes" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive size-6"
            onClick={onDiscardAll}
            aria-label="Discard all changes"
          >
            <CornerUpLeft size={13} strokeWidth={2} />
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
          <RefreshCw size={12} strokeWidth={2} />
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
            <ExternalLink size={12} strokeWidth={2} />
          </Button>
        </IconTooltip>
      ) : null}
      {/* Left-sidebar instance: move Source Control to the right panel. */}
      {dragHandle && !historyOnly ? (
        <IconTooltip label="Move to right panel" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={() => {
              void setSourceControlInRightPanel(true);
              useScmRightPanelStore.getState().openPanel();
            }}
            aria-label="Move Source Control to the right panel"
          >
            <PanelRight size={13} strokeWidth={2} />
          </Button>
        </IconTooltip>
      ) : null}
      {/* Right-panel instance: dock Source Control back into the left sidebar. */}
      {onClose ? (
        <IconTooltip label="Move to left sidebar" side="bottom">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground size-6"
            onClick={() => {
              void setSourceControlInRightPanel(false);
              useScmRightPanelStore.getState().closePanel();
            }}
            aria-label="Move Source Control to the left sidebar"
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
            className="hover:bg-destructive/10 hover:text-destructive text-muted-foreground size-6"
            onClick={onClose}
            aria-label="Close Source Control panel"
          >
            <X size={12} strokeWidth={2} />
          </Button>
        </IconTooltip>
      ) : null}
    </div>
  );
}
