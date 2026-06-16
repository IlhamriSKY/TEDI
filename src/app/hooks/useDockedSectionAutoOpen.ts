import { useEffect, useRef } from "react";

import { useChatStore } from "@/modules/ai";
import {
  sectionPanelId,
  sidebarSectionKey,
  sidebarSectionsRegistry,
  useRegistry,
  useRightPanelStore,
  useSidebarPlacementStore,
} from "@/modules/extensions";
import { useScmRightPanelStore } from "@/modules/scm/scmRightPanelStore";

/**
 * When a movable sidebar section is docked to the right (placement === "right"),
 * open it in the shared right slot once on mount — IF the slot is free (no
 * extension panel, AI sidebar, or SCM already claiming it). Without this a
 * docked section would silently vanish after a reload (it's gone from the left
 * sidebar and the right-slot open-state is session-only), forcing the user to
 * hunt for its status-bar icon. The one-shot guard means closing it (or the
 * user opening something else) is respected for the rest of the session.
 */
export function useDockedSectionAutoOpen(): void {
  const sections = useRegistry(sidebarSectionsRegistry);
  const placement = useSidebarPlacementStore((s) => s.placement);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    const docked = sections.find(
      (s) =>
        s.item.movableToRight &&
        placement[sidebarSectionKey(s.extensionId, s.item.id)] === "right",
    );
    if (!docked) return; // none docked yet (sections may still be loading)
    done.current = true;
    if (
      useRightPanelStore.getState().active ||
      useChatStore.getState().panelOpen ||
      useScmRightPanelStore.getState().open
    ) {
      return; // slot is busy — leave it; the status-bar icon still reopens.
    }
    useRightPanelStore.getState().open(docked.extensionId, sectionPanelId(docked.item.id));
  }, [sections, placement]);
}
