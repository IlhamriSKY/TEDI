import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { UndoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useState, useSyncExternalStore } from "react";
import {
  getCheckpoint,
  getCheckpointsVersion,
  subscribeCheckpoints,
} from "../lib/checkpoint";
import { restoreToLastCheckpoint, useChatStore } from "../store/chatStore";

/**
 * Small inline action rendered next to the most recent user message.
 *
 * Visible only while a checkpoint exists for the active session. After the
 * user clicks: files mutated this turn are restored, the user message and
 * everything after it are removed from history, and the chat returns to
 * idle — ready to accept the next prompt.
 */
export function RestoreCheckpointButton() {
  const sessionId = useChatStore((s) => s.activeSessionId);
  // Re-render whenever any checkpoint state changes — opens, mutations,
  // restores all bump the version counter.
  useSyncExternalStore(
    subscribeCheckpoints,
    getCheckpointsVersion,
    getCheckpointsVersion,
  );
  const checkpoint = sessionId ? getCheckpoint(sessionId) : null;
  const [busy, setBusy] = useState(false);

  const onClick = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await restoreToLastCheckpoint();
    } finally {
      setBusy(false);
    }
  }, [busy]);

  if (!checkpoint) return null;

  const fileCount = checkpoint.files.size;
  const tooltip =
    fileCount === 0
      ? "Restore: remove this command from history (no files mutated)"
      : `Restore: revert up to ${fileCount} file${fileCount === 1 ? "" : "s"} and remove this command from history. Files you've manually edited since are left alone.`;

  return (
    <IconTooltip label={tooltip} side="top">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-label="Restore to last checkpoint"
        className={cn(
          "inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-border/50 bg-card/60 px-1.5",
          "text-[10.5px] text-muted-foreground transition-colors",
          "hover:border-border hover:bg-accent hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <HugeiconsIcon icon={UndoIcon} size={11} strokeWidth={1.75} />
        <span>Restore</span>
        {fileCount > 0 ? (
          <span className="font-mono text-muted-foreground/70">
            · {fileCount}
          </span>
        ) : null}
      </button>
    </IconTooltip>
  );
}
