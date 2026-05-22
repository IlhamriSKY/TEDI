/**
 * Right-panel store. Tracks which extension panel is shown in the right slot
 * (shared with the AI sidebar). One nullable target; not persisted.
 * Mutual exclusion with the AI sidebar lives in App.tsx; this store knows
 * nothing about AI state.
 * Also tracks which panels have had `defaultOpen` applied this session so
 * re-renders or `loader.reload()` don't reopen a panel the user closed.
 */
import { create } from "zustand";

type ActivePanel = { extensionId: string; panelId: string };

type State = {
  active: ActivePanel | null;
  /** Panels whose manifest `defaultOpen=true` has been honored this session.
   *  Keyed by `${extId}:${panelId}`. */
  defaultOpenHandled: Set<string>;
};

type Actions = {
  open: (extensionId: string, panelId: string) => void;
  close: () => void;
  toggle: (extensionId: string, panelId: string) => void;
  /** Returns true on the first call for an (extId, panelId) pair. Call from
   *  App boot to honor `defaultOpen` once per session. */
  markDefaultOpenHandled: (extensionId: string, panelId: string) => boolean;
};

export const useRightPanelStore = create<State & Actions>((set, get) => ({
  active: null,
  defaultOpenHandled: new Set<string>(),
  open: (extensionId, panelId) => set({ active: { extensionId, panelId } }),
  close: () => set({ active: null }),
  toggle: (extensionId, panelId) => {
    const cur = get().active;
    if (cur && cur.extensionId === extensionId && cur.panelId === panelId) {
      set({ active: null });
    } else {
      set({ active: { extensionId, panelId } });
    }
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
