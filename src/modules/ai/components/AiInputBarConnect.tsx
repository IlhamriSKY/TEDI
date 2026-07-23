import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { KeyRound, X } from "lucide-react";
import { useChatStore } from "../store/chatStore";

/**
 * The "connect an AI provider" empty-state card shown in the right slot when no
 * key is configured. Kept in its OWN file, separate from the heavy `AiInputBar`
 * composer: `AppRightSlot` (on the boot render tree) imports only this card, so
 * co-locating it with the composer dragged the whole composer graph - and its
 * transitive streamdown/ai-elements markdown renderer - onto first paint even
 * though the card renders nothing but a button. The composer stays reachable
 * only through the lazy `AiMiniWindow`.
 */
export function AiInputBarConnect({ onAdd }: { onAdd: () => void }) {
  const closePanel = useChatStore((s) => s.closePanel);
  return (
    <div className="border-border/60 bg-card/40 shrink-0 border-t px-3 py-2">
      <div className="flex h-10 items-center justify-between gap-3 rounded-lg px-3 text-xs">
        <span className="text-muted-foreground">
          Connect any AI provider (or use local models) - your key stays in your OS keychain.
        </span>
        <div className="flex items-center gap-1">
          <Button size="xs" onClick={onAdd}>
            <KeyRound />
            Add API key
          </Button>
          <IconTooltip label="Dismiss" side="top">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={closePanel}
              aria-label="Dismiss"
              className="hover:bg-destructive/10 hover:text-destructive"
            >
              <X size={12} strokeWidth={2} />
            </Button>
          </IconTooltip>
        </div>
      </div>
    </div>
  );
}
