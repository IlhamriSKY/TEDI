import { useEffect, useMemo, useRef } from "react";

import {
  BUILTIN_SECTION_EXT,
  isRightPanelOpen,
  MOVABLE_BUILTIN_SECTIONS,
  sectionPanelId,
  sidebarSectionKey,
  sidebarSectionsRegistry,
  useRegistry,
  useRightPanelStore,
  useSidebarPlacementStore,
} from "@/modules/extensions";

/**
 * Restore right-docked sidebar sections' open/closed state across launches.
 *
 * A movable section docked to the right (placement === "right") should come
 * back the way the user left it - open if they had it open, closed if they
 * closed it - not reopen on every launch. The right column's live state is
 * session-only, so each section's last intent is persisted in
 * `useSidebarPlacementStore.rightOpen` and applied here:
 *
 *   - On the first mount where a docked section exists, open every one whose
 *     persisted intent isn't `false`. The column stacks them, so they no longer
 *     compete for a single slot; a section the user closed stays closed and its
 *     status-bar icon still reopens it.
 *   - Afterwards, mirror each section's live open/closed state back into the
 *     persisted intent, so the next launch restores the latest state.
 *
 * Without the persisted intent a docked section reopened on every launch even
 * after the user closed it (the reported "DB panel always opens on startup").
 */
export function useDockedSectionAutoOpen(): void {
  const sections = useRegistry(sidebarSectionsRegistry);
  const placement = useSidebarPlacementStore((s) => s.placement);
  const panels = useRightPanelStore((s) => s.panels);
  const decided = useRef(false);

  // Every right-docked section: built-ins (Workspaces) first, then extension
  // sections that opt in via movableToRight.
  const docked = useMemo<Array<{ key: string; extensionId: string; panelId: string }>>(() => {
    const out: Array<{ key: string; extensionId: string; panelId: string }> = [];
    for (const b of MOVABLE_BUILTIN_SECTIONS) {
      if (placement[b.id] === "right") {
        out.push({ key: b.id, extensionId: BUILTIN_SECTION_EXT, panelId: sectionPanelId(b.id) });
      }
    }
    for (const s of sections) {
      const key = sidebarSectionKey(s.extensionId, s.item.id);
      if (s.item.movableToRight && placement[key] === "right") {
        out.push({ key, extensionId: s.extensionId, panelId: sectionPanelId(s.item.id) });
      }
    }
    return out;
  }, [sections, placement]);

  // One-shot restore on the first mount where a docked section exists.
  useEffect(() => {
    if (decided.current) return;
    if (docked.length === 0) return; // none docked yet (extensions may still be loading)
    decided.current = true;
    const { rightOpen } = useSidebarPlacementStore.getState();
    for (const d of docked) {
      // Respect the persisted last state: a section the user closed stays closed.
      if (rightOpen[d.key] === false) continue;
      useRightPanelStore.getState().open(d.extensionId, d.panelId);
    }
  }, [docked]);

  // After the restore decision, mirror each docked section's live open/closed
  // state into the persisted intent so the next launch comes back the same way.
  useEffect(() => {
    if (!decided.current) return;
    const store = useSidebarPlacementStore.getState();
    for (const d of docked) {
      store.setRightOpen(d.key, isRightPanelOpen(panels, d.extensionId, d.panelId));
    }
  }, [panels, docked]);
}
