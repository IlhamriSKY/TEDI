import { useEffect, useMemo, useRef } from "react";

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
 * Restore a right-docked sidebar section's open/closed state across launches.
 *
 * When a movable sidebar section is docked to the right (placement === "right")
 * it should come back the way the user left it — open if they had it open,
 * closed if they closed it — not reopen on every launch. The right slot's live
 * state is session-only, so the section's last intent is persisted in
 * `useSidebarPlacementStore.rightOpen` and applied here:
 *
 *   - On the first mount where a docked section exists, open it IFF its
 *     persisted intent isn't `false` (open, or first-ever dock) AND the slot is
 *     free. A section the user closed last session stays closed — its status-bar
 *     icon still reopens it, so it never becomes unreachable.
 *   - Afterwards, mirror the live open/closed state back into the persisted
 *     intent on every change, so the next launch restores the latest state.
 *
 * Without the persisted intent the docked section reopened on every launch even
 * after the user closed it (the reported "DB panel always opens on startup").
 */
export function useDockedSectionAutoOpen(): void {
  const sections = useRegistry(sidebarSectionsRegistry);
  const placement = useSidebarPlacementStore((s) => s.placement);
  const active = useRightPanelStore((s) => s.active);
  const decided = useRef(false);

  const docked = useMemo(
    () =>
      sections.find(
        (s) =>
          s.item.movableToRight &&
          placement[sidebarSectionKey(s.extensionId, s.item.id)] === "right",
      ),
    [sections, placement],
  );
  const dockedKey = docked ? sidebarSectionKey(docked.extensionId, docked.item.id) : null;
  const dockedPanelId = docked ? sectionPanelId(docked.item.id) : null;

  // One-shot restore on the first mount where a docked section exists.
  useEffect(() => {
    if (decided.current) return;
    if (!docked || !dockedKey || !dockedPanelId) return; // none docked yet (still loading)
    decided.current = true;
    // Respect the persisted last state: a section the user closed stays closed.
    if (useSidebarPlacementStore.getState().rightOpen[dockedKey] === false) return;
    if (
      useRightPanelStore.getState().active ||
      useChatStore.getState().panelOpen ||
      useScmRightPanelStore.getState().open
    ) {
      return; // slot is busy — leave it; the status-bar icon still reopens.
    }
    useRightPanelStore.getState().open(docked.extensionId, dockedPanelId);
  }, [docked, dockedKey, dockedPanelId]);

  // After the restore decision, mirror the docked section's live open/closed
  // state into the persisted intent so the next launch comes back the same way.
  useEffect(() => {
    if (!decided.current) return;
    if (!docked || !dockedKey || !dockedPanelId) return;
    const isOpen = active?.extensionId === docked.extensionId && active?.panelId === dockedPanelId;
    useSidebarPlacementStore.getState().setRightOpen(dockedKey, isOpen);
  }, [active, docked, dockedKey, dockedPanelId]);
}
