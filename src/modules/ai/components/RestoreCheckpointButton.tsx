import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { useCallback, useState, useSyncExternalStore } from "react";
import { getCheckpoint, getCheckpointsVersion, subscribeCheckpoints } from "../lib/checkpoint";
import { restoreToLastCheckpoint, useChatStore } from "../store/chatStore";
import { Undo2 } from "lucide-react";

/**
 * Inline action next to the most recent user message. Visible only while a
 * checkpoint exists. Clicking restores files mutated this turn, drops the
 * user message and everything after it, and returns the chat to idle.
 */
export function RestoreCheckpointButton() {
  const sessionId = useChatStore((s) => s.activeSessionId);
  // Re-render on any checkpoint change. Open/mutate/restore all bump the version.
  useSyncExternalStore(subscribeCheckpoints, getCheckpointsVersion, getCheckpointsVersion);
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
          "border-border/50 bg-card/60 inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border px-1.5",
          "text-muted-foreground text-[10.5px] transition-colors",
          "hover:border-border hover:bg-accent hover:text-accent-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <Undo2 size={11} strokeWidth={1.75} />
        <span>Restore</span>
        {fileCount > 0 ? (
          <span className="text-muted-foreground/70 font-mono">· {fileCount}</span>
        ) : null}
      </button>
    </IconTooltip>
  );
}
