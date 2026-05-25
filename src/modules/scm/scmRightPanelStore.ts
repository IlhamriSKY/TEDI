/**
 * Open/closed state for Source Control hosted in the right slot.
 * Not persisted - session-scoped only. Mutual exclusion with the AI sidebar
 * and extension right panels lives in App.tsx.
 */
import { create } from "zustand";

type State = {
  open: boolean;
};

type Actions = {
  openPanel: () => void;
  closePanel: () => void;
  toggle: () => void;
};

export const useScmRightPanelStore = create<State & Actions>((set, get) => ({
  open: false,
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
  toggle: () => set({ open: !get().open }),
}));
