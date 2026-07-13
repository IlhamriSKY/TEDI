import { useEffect, useMemo, useRef } from "react";

import { useChatStore } from "@/modules/ai";
import {
  BUILTIN_SECTION_EXT,
  MOVABLE_BUILTIN_SECTIONS,
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

  // The single right-docked candidate to restore: built-in sections (Files /
  // Workspaces) first, then extension sections that opt in via movableToRight.
  // Only one section can occupy the shared slot, so the first docked one wins;
  // the others stay reachable via their status-bar toggle.
  const docked = useMemo<{ key: string; extensionId: string; panelId: string } | null>(() => {
    for (const b of MOVABLE_BUILTIN_SECTIONS) {
      if (placement[b.id] === "right") {
        return { key: b.id, extensionId: BUILTIN_SECTION_EXT, panelId: sectionPanelId(b.id) };
      }
    }
    for (const s of sections) {
      const key = sidebarSectionKey(s.extensionId, s.item.id);
      if (s.item.movableToRight && placement[key] === "right") {
        return { key, extensionId: s.extensionId, panelId: sectionPanelId(s.item.id) };
      }
    }
    return null;
  }, [sections, placement]);

  // One-shot restore on the first mount where a docked section exists.
  useEffect(() => {
    if (decided.current) return;
    if (!docked) return; // none docked yet (extensions may still be loading)
    decided.current = true;
    // Respect the persisted last state: a section the user closed stays closed.
    if (useSidebarPlacementStore.getState().rightOpen[docked.key] === false) return;
    if (
      useRightPanelStore.getState().active ||
      useChatStore.getState().panelOpen ||
      useScmRightPanelStore.getState().open
    ) {
      return; // slot is busy — leave it; the status-bar icon still reopens.
    }
    useRightPanelStore.getState().open(docked.extensionId, docked.panelId);
  }, [docked]);

  // After the restore decision, mirror the docked section's live open/closed
  // state into the persisted intent so the next launch comes back the same way.
  useEffect(() => {
    if (!decided.current) return;
    if (!docked) return;
    const isOpen = active?.extensionId === docked.extensionId && active?.panelId === docked.panelId;
    useSidebarPlacementStore.getState().setRightOpen(docked.key, isOpen);
  }, [active, docked]);
}
