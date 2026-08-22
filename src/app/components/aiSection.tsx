import { AiInputBarConnect } from "@/modules/ai/components/AiInputBarConnect";
import { Suspense, type ReactNode } from "react";
import { AiSidebarPanel } from "./lazyPanels";
import type { StackSection } from "./SectionStack";

/** The AI panel is the tall one - a conversation plus its composer - so it
 *  starts with the biggest share of whichever column it is docked in. The group
 *  normalizes against whatever else is open. */
const AI_DEFAULT_SIZE = "45%";

/**
 * The AI panel as a stack section. Both columns build it from HERE: it docks to
 * either side now, and a second copy of this is a second place for the two to
 * drift apart.
 *
 * `chrome: false` in both: `AiSidebarPanel` (and the connect card below) draw
 * their own bento card, so the left sidebar's stack must not wrap a second
 * border round it the way it does for the bare Files / Workspaces trees.
 *
 * The move-to-other-column button is not here but on the panel's own header
 * (`AiDockButton`), which reads its side off the placement store.
 */
export function aiStackSection(hasComposer: boolean, onAddProviderKey: () => void): StackSection {
  return {
    key: "ai",
    title: "AI",
    defaultSize: AI_DEFAULT_SIZE,
    chrome: false,
    render: (controls: ReactNode) =>
      hasComposer ? (
        <Suspense fallback={null}>
          <AiSidebarPanel dragHandle={controls} />
        </Suspense>
      ) : (
        // No API key yet: the connect card stands in for the panel. It draws no
        // header of its own, so without this row the grip has nowhere to live
        // and this is the one section in the column that cannot be reordered.
        <div className="border-border/60 bg-background tedi-glass-panel flex h-full flex-col overflow-hidden rounded-md border">
          <div className="tedi-panel-header">
            {controls}
            <span className="text-foreground/80 min-w-0 flex-1 truncate text-xs font-medium">
              AI
            </span>
          </div>
          <AiInputBarConnect onAdd={onAddProviderKey} />
        </div>
      ),
  };
}
