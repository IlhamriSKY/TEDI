import { IconTooltip } from "@/components/ui/icon-tooltip";
import { CircleX, Sparkles, X } from "lucide-react";
import { readCommandOutput } from "./lib/commandBlocks";
import {
  ASK_ABOUT_COMMAND_EVENT,
  useFailedCommands,
  type AskAboutCommandDetail,
} from "./lib/failedCommandStore";
import { sessions } from "./lib/sessionState";

/**
 * Bottom-right of a terminal whose last command failed: the exit code, a button
 * that hands the command and its output to the AI, and a dismiss. It goes away
 * on its own when the next command starts. A private pane shows the exit code
 * only, because nothing from it may reach the AI.
 */
export function FailedCommandPill({ leafId, allowAi }: { leafId: number; allowAi: boolean }) {
  const failed = useFailedCommands((s) => s.failed[leafId]);
  if (!failed) return null;
  const dismiss = () => useFailedCommands.getState().clear(leafId);
  const ask = () => {
    const term = sessions.get(leafId)?.term;
    if (!term) return;
    const detail: AskAboutCommandDetail = {
      leafId,
      exitCode: failed.exitCode,
      output: readCommandOutput(term, failed),
    };
    window.dispatchEvent(new CustomEvent(ASK_ABOUT_COMMAND_EVENT, { detail }));
    dismiss();
  };
  return (
    <div
      data-failed-command={failed.exitCode}
      className="bg-popover/95 text-popover-foreground border-border absolute right-5 bottom-2 z-10 flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-1.5 text-[11px] shadow-sm"
      // Keep the terminal's own mouse handling (select-to-copy, right-click
      // paste) from seeing clicks on the pill.
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <CircleX size={12} className="text-destructive shrink-0" />
      <span className="text-muted-foreground tabular-nums">exit {failed.exitCode}</span>
      {allowAi && (
        <button
          type="button"
          onClick={ask}
          className="hover:bg-muted text-foreground ml-0.5 flex items-center gap-1 rounded px-1 py-0.5 transition-colors"
        >
          <Sparkles size={11} />
          Ask AI
        </button>
      )}
      <IconTooltip label="Dismiss" side="top">
        <button
          type="button"
          aria-label="Dismiss"
          onClick={dismiss}
          className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-4 items-center justify-center rounded transition-colors"
        >
          <X size={11} />
        </button>
      </IconTooltip>
    </div>
  );
}
