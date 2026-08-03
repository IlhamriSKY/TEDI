/**
 * Right-column store. Tracks which extension panels (and right-docked sidebar
 * sections) are showing in the right column.
 *
 * `panels` is a LIST, not a single target: the right column stacks its surfaces
 * the same way the left sidebar does, so more than one can be open at once.
 * Test membership with `isRightPanelOpen` rather than looking at one entry.
 *
 * Not persisted (the column's live state is session-only); what a docked
 * section restores across launches lives in `sidebarPlacementStore.rightOpen`.
 * Also tracks which panels have had `defaultOpen` applied this session so
 * re-renders or `loader.reload()` don't reopen a panel the user closed.
 */
import { create } from "zustand";

export type ActivePanel = { extensionId: string; panelId: string };

type State = {
  /** Open panels, in the order they were opened. The visual order is the
   *  section stack's business (it persists its own drag order). */
  panels: ActivePanel[];
  /** Panels whose manifest `defaultOpen=true` has been honored this session.
   *  Keyed by `${extId}:${panelId}`. */
  defaultOpenHandled: Set<string>;
};

type Actions = {
  open: (extensionId: string, panelId: string) => void;
  /** Close one panel, or every panel when called with no arguments. */
  close: (extensionId?: string, panelId?: string) => void;
  toggle: (extensionId: string, panelId: string) => void;
  /** Returns true on the first call for an (extId, panelId) pair. Call from
   *  App boot to honor `defaultOpen` once per session. */
  markDefaultOpenHandled: (extensionId: string, panelId: string) => boolean;
};

function isSame(p: ActivePanel, extensionId: string, panelId: string): boolean {
  return p.extensionId === extensionId && p.panelId === panelId;
}

/** Whether a panel is currently in the right column. Takes the list so a
 *  component can select `panels` once and test several ids against it. */
export function isRightPanelOpen(
  panels: readonly ActivePanel[],
  extensionId: string,
  panelId: string,
): boolean {
  return panels.some((p) => isSame(p, extensionId, panelId));
}

export const useRightPanelStore = create<State & Actions>((set, get) => ({
  panels: [],
  defaultOpenHandled: new Set<string>(),
  open: (extensionId, panelId) => {
    const { panels } = get();
    if (isRightPanelOpen(panels, extensionId, panelId)) return;
    set({ panels: [...panels, { extensionId, panelId }] });
  },
  close: (extensionId, panelId) => {
    const { panels } = get();
    if (extensionId === undefined || panelId === undefined) {
      if (panels.length === 0) return;
      set({ panels: [] });
      return;
    }
    if (!isRightPanelOpen(panels, extensionId, panelId)) return;
    set({ panels: panels.filter((p) => !isSame(p, extensionId, panelId)) });
  },
  toggle: (extensionId, panelId) => {
    const { panels } = get();
    if (isRightPanelOpen(panels, extensionId, panelId)) get().close(extensionId, panelId);
    else get().open(extensionId, panelId);
  },
  markDefaultOpenHandled: (extensionId, panelId) => {
    const key = `${extensionId}:${panelId}`;
    const seen = get().defaultOpenHandled;
    if (seen.has(key)) return false;
    const next = new Set(seen);
    next.add(key);
    set({ defaultOpenHandled: next });
    return true;
  },
}));
