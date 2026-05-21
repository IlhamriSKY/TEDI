import { useChat, type UIMessage } from "@ai-sdk/react";
import { useMemo } from "react";
import { getOrCreateChat, useChatStore } from "../store/chatStore";
import { ContextIndicator } from "./AiMiniWindow";

/** Status-bar mount of the AI context indicator. Renders only when a chat
 *  session is active (panel open + sessionId set) so the bar stays empty for
 *  users who don't use AI. Uses CSS to hide the textual percentage that
 *  `ContextTrigger` renders by default — the visual ring is the indicator,
 *  the hovercard carries the exact numbers. */
export function StatusBarContextIndicator() {
  const panelOpen = useChatStore((s) => s.panelOpen);
  const sessionId = useChatStore((s) => s.activeSessionId);
  if (!panelOpen || !sessionId) return null;
  return <Mounted sessionId={sessionId} />;
}

function Mounted({ sessionId }: { sessionId: string }) {
  // Same Chat instance the side panel subscribes to; multiple `useChat`
  // calls on one Chat stay in sync via the SDK's internal store.
  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const helpers = useChat<UIMessage>({ chat });
  return (
    <div
      // Hide the percent <span> rendered first inside `ContextTrigger`'s
      // Button, keep the SVG ring icon. Hovercard still surfaces the full
      // numeric breakdown on hover.
      className="[&_button>span:first-child]:hidden"
    >
      <ContextIndicator messages={helpers.messages} />
    </div>
  );
}
