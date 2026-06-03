import { ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { AiInputBarConnect } from "@/modules/ai/components/AiInputBar";
import { RightPanelHost } from "@/modules/extensions";
import type { useRightPanelStore } from "@/modules/extensions";
import { Suspense } from "react";
import { type TabsApi } from "../hooks/tabsApi";
import { AiSidebarPanel, SourceControlPanel } from "./lazyPanels";

type RightPanelActive = ReturnType<typeof useRightPanelStore.getState>["active"];

type Props = {
  rightPanelActive: RightPanelActive;
  scmRightOpen: boolean;
  keysLoaded: boolean;
  panelOpen: boolean;
  hasComposer: boolean;
  explorerRoot: string | null;
  onPathDeleted: (path: string) => void;
  closeScmRight: () => void;
  onAddProviderKey: () => void;
} & Pick<TabsApi, "openGitDiffTab" | "openScmTab">;

/**
 * The right column shared by the AI sidebar, the extension right panels, and
 * the SCM right panel. Mutual exclusion among the three is enforced by the
 * coordinator effects in App; the precedence here (`rightPanelActive` first)
 * covers the one-tick gap before the loser closes - a fresh `rightPanelActive`
 * reflects the user's latest click, so render that and let the AI panel close
 * in the background. Renders nothing when no surface wants the slot. Lifted out
 * of App verbatim; returns the handle + panel as a fragment, which the
 * context-registered ResizablePanelGroup handles correctly.
 */
export function AppRightSlot({
  rightPanelActive,
  scmRightOpen,
  keysLoaded,
  panelOpen,
  hasComposer,
  explorerRoot,
  onPathDeleted,
  closeScmRight,
  onAddProviderKey,
  openGitDiffTab,
  openScmTab,
}: Props) {
  if (!(rightPanelActive || scmRightOpen || (keysLoaded && panelOpen))) return null;
  return (
    <>
      <ResizableHandle withHandle />
      <ResizablePanel id="right-slot" defaultSize="22%" minSize="18%" maxSize="50%">
        {rightPanelActive ? (
          <RightPanelHost />
        ) : scmRightOpen ? (
          <div className="border-border/60 bg-card/60 tedi-glass-panel flex h-full min-h-0 flex-col border-l">
            <Suspense fallback={null}>
              <SourceControlPanel
                rootPath={explorerRoot}
                onPathDeleted={onPathDeleted}
                onOpenDiff={openGitDiffTab}
                onClose={closeScmRight}
                onOpenInTab={openScmTab}
              />
            </Suspense>
          </div>
        ) : hasComposer ? (
          <Suspense fallback={null}>
            <AiSidebarPanel />
          </Suspense>
        ) : (
          <div className="border-border/60 bg-card/60 tedi-glass-panel flex h-full flex-col border-l">
            <AiInputBarConnect onAdd={onAddProviderKey} />
          </div>
        )}
      </ResizablePanel>
    </>
  );
}
