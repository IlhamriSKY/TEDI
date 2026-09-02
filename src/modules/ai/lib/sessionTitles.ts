import { useMemo } from "react";
import { useChatStore } from "../store/chatStore";

/**
 * Chat titles by session id, for whatever names an `ai` pane leaf: the tab
 * strip, the pane header, the canvas window header.
 *
 * A hook rather than a read inside `leafLabel` for two reasons. The title is
 * DERIVED from a chat's first message, so a pane opened on a fresh chat has to
 * re-render when it lands - a `getState()` read would not. And `tabHelpers` is
 * imported by the node-run verify scripts, which cannot load the AI stack (it
 * reaches xterm); passing a map in keeps that module dependency-free, exactly
 * as `sshHosts` does for SSH leaves.
 */
export function useAiSessionTitles(): ReadonlyMap<string, string> {
  const sessions = useChatStore((s) => s.sessions);
  return useMemo(() => new Map(sessions.map((s) => [s.id, s.title])), [sessions]);
}
