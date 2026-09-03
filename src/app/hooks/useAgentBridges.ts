import { toast } from "@/components/ui/toast";
import { useChatStore } from "@/modules/ai";
import { scheduler, setSchedulerBridge } from "@/modules/scheduler";
import { type TerminalPaneHandle } from "@/modules/terminal";
import { useEffect, useRef, type RefObject } from "react";
import { buildLiveContext, type LiveContext } from "../lib/buildLiveContext";
import { resolveTerminalLeaf, snapshotTerminals } from "../lib/terminalSnapshot";

type Params = LiveContext & {
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
};

/**
 * Wires the two agent-facing bridges that read live workspace state through a
 * stable ref: the AI live-context (`setLive`) and the schedule-trigger engine
 * (`setSchedulerBridge` + `scheduler.boot()`).
 *
 * The chat store holds the live object and never resubscribes (consumers read
 * via `getState()` in event handlers), so mirroring the needed values into
 * `liveContextRef` keeps the bridge closures stable - rebuilding them on every
 * `tabs` mutation (including per-keystroke dirty flips) would waste work. Moved
 * verbatim from App; both registration effects run once.
 */
export function useAgentBridges({
  tabs,
  activeId,
  explorerRoot,
  home,
  openPreviewTab,
  newTab,
  newSshTab,
  inheritedCwdForNewTab,
  splitActivePane,
  setActiveId,
  focusPane,
  moveLeafToTab,
  rotateLeafSplit,
  closePaneByLeaf,
  terminalRefs,
}: Params): void {
  // Mirror values needed by `setLive` closures into a ref so the closures
  // stay stable. The chat store holds the live object and never resubscribes
  // (consumers read via getState() in event handlers), so rebuilding the
  // closures on every `tabs` mutation (including per-keystroke dirty flips)
  // wastes work.
  const liveContextRef = useRef<LiveContext>({
    tabs,
    activeId,
    explorerRoot,
    home,
    openPreviewTab,
    newTab,
    newSshTab,
    inheritedCwdForNewTab,
    splitActivePane,
    setActiveId,
    focusPane,
    moveLeafToTab,
    rotateLeafSplit,
    closePaneByLeaf,
  });
  liveContextRef.current = {
    tabs,
    activeId,
    explorerRoot,
    home,
    openPreviewTab,
    newTab,
    newSshTab,
    inheritedCwdForNewTab,
    splitActivePane,
    setActiveId,
    focusPane,
    moveLeafToTab,
    rotateLeafSplit,
    closePaneByLeaf,
  };

  const setLive = useChatStore((s) => s.setLive);
  useEffect(() => {
    setLive(buildLiveContext({ liveContextRef, terminalRefs }));
  }, [setLive]);

  // Boot the schedule-trigger engine once. Bridge closures read live
  // state through `liveContextRef` and stay valid across re-renders.
  useEffect(() => {
    setSchedulerBridge({
      listTerminals: () => snapshotTerminals(liveContextRef.current),
      injectIntoTerminal: (target, text) => {
        const leafId = resolveTerminalLeaf(target, liveContextRef.current);
        if (leafId === null) return false;
        const term = terminalRefs.current.get(leafId);
        if (!term) return false;
        term.write(text);
        return true;
      },
      runInTerminal: (target, command) => {
        const leafId = resolveTerminalLeaf(target, liveContextRef.current);
        if (leafId === null) return false;
        const term = terminalRefs.current.get(leafId);
        if (!term) return false;
        const trimmed = command.replace(/[\r\n]+$/, "");
        term.write(`${trimmed}\r`);
        return true;
      },
      notify: (message, level) => {
        const variant =
          level === "success"
            ? "success"
            : level === "warning"
              ? "warning"
              : level === "error"
                ? "error"
                : "info";
        toast(message, { variant });
      },
    });
    void scheduler.boot();
    // Prune fired/cancelled history every 5min to keep the store small.
    const interval = window.setInterval(() => {
      void scheduler.pruneHistory();
    }, 5 * 60_000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);
}
