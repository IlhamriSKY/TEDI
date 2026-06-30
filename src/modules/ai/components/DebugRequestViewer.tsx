import { Button } from "@/components/ui/button";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { openDebugWindow } from "../store/debugBridge";

/**
 * Toolbar button that opens the Debug-requests viewer in its own native window
 * (a separate webview that mirrors the main window's in-memory capture store
 * over Tauri events; see store/debugBridge.ts and src/debug/DebugApp.tsx).
 * Hidden unless Debug capturing is enabled in Settings -> Agents.
 */
export function DebugRequestViewer() {
  const enabled = usePreferencesStore((s) => s.debugEnabled);
  if (!enabled) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="text-muted-foreground h-7 shrink-0 px-2 text-[11px]"
      onClick={() => void openDebugWindow()}
    >
      Debug
    </Button>
  );
}
