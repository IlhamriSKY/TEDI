import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { openDebugWindow } from "../store/debugBridge";
import { Bug } from "lucide-react";

/**
 * Header button that opens the Debug-requests viewer in its own native window
 * (a separate webview that mirrors the main window's in-memory capture store
 * over Tauri events; see store/debugBridge.ts and src/debug/DebugApp.tsx).
 * Hidden unless Debug capturing is enabled in Settings -> Agents.
 */
export function DebugRequestViewer() {
  const enabled = usePreferencesStore((s) => s.debugEnabled);
  if (!enabled) return null;
  return (
    <IconTooltip label="Debug requests" side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="Debug requests"
        className="text-muted-foreground hover:text-foreground size-7 shrink-0 rounded-md"
        onClick={() => void openDebugWindow()}
      >
        <Bug size={12} strokeWidth={2} />
      </Button>
    </IconTooltip>
  );
}
