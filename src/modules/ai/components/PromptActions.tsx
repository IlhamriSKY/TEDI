import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import { useCallback, useState, useSyncExternalStore } from "react";
import {
  filesSince,
  getCheckpointsVersion,
  subscribeCheckpoints,
  turnsSince,
} from "../lib/checkpoint";
import { recallUserMessage } from "../lib/messageBody";
import { forkChatBefore, rewindToPrompt, useChatStore } from "../store/chatStore";
import { GitBranch, Undo2 } from "lucide-react";

/** Icon-only: the name and what it does are in the tooltip. */
const ACTION = cn(
  "inline-flex size-6 cursor-pointer items-center justify-center rounded-md",
  "text-muted-foreground transition-colors",
  "hover:bg-accent hover:text-accent-foreground",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

/**
 * Actions under a user prompt.
 *
 * Restore (the latest prompt) / Rewind (an earlier one): undo what the agent
 * did to files from that prompt on, drop the prompt and everything after it,
 * and put the prompt back in the composer to edit and resend. Shown while that
 * turn still has a checkpoint (the last 20 turns of this app session).
 *
 * Fork: open a new chat holding everything before this prompt, with the prompt
 * in the composer, and leave this chat and your files untouched.
 *
 * Earlier prompts show their actions on hover only, so a long chat is not a
 * column of buttons.
 */
export function PromptActions({
  message,
  messageIndex,
  isLast,
}: {
  message: UIMessage;
  messageIndex: number;
  isLast: boolean;
}) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  // Re-render on any checkpoint change. Open/mutate/restore all bump the version.
  useSyncExternalStore(subscribeCheckpoints, getCheckpointsVersion, getCheckpointsVersion);
  const turns = sessionId ? turnsSince(sessionId, messageIndex) : 0;
  const fileCount = sessionId && turns > 0 ? filesSince(sessionId, turns) : 0;
  const [busy, setBusy] = useState(false);

  const putBack = useCallback(() => {
    const body = recallUserMessage(message).body.trim();
    if (body) useChatStore.getState().focusInput(body);
  }, [message]);

  const onRewind = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await rewindToPrompt(messageIndex);
      if (outcome?.baselineMessageCount === messageIndex) putBack();
    } finally {
      setBusy(false);
    }
  }, [busy, messageIndex, putBack]);

  const onFork = useCallback(() => {
    if (forkChatBefore(messageIndex)) putBack();
  }, [messageIndex, putBack]);

  const later = turns > 1 ? ` and the ${turns - 1} after it` : "";
  const files =
    fileCount === 0
      ? "no files were changed"
      : `reverts up to ${fileCount} file${fileCount === 1 ? "" : "s"} (any you edited since are left alone)`;
  const rewindTip = `${isLast ? "Restore" : "Rewind"}: undo this prompt${later}. ${files[0].toUpperCase()}${files.slice(1)}, and the prompt goes back in the input to edit and resend.`;

  return (
    <div
      className={cn(
        "flex items-center gap-1.5",
        !isLast &&
          "opacity-0 transition-opacity group-hover/prompt:opacity-100 focus-within:opacity-100",
      )}
    >
      <IconTooltip
        label="Fork: open a new chat with everything before this prompt, and this prompt in the input. This chat and your files stay as they are."
        side="top"
      >
        <button type="button" onClick={onFork} aria-label="Fork from here" className={ACTION}>
          <GitBranch size={13} strokeWidth={2} />
        </button>
      </IconTooltip>
      {turns > 0 ? (
        <IconTooltip label={rewindTip} side="top">
          <button
            type="button"
            onClick={onRewind}
            disabled={busy}
            aria-label={isLast ? "Restore to last checkpoint" : "Rewind to this prompt"}
            className={ACTION}
          >
            <Undo2 size={13} strokeWidth={2} />
          </button>
        </IconTooltip>
      ) : null}
    </div>
  );
}
