/**
 * Open/closed state for the SSH (Remote) file explorer hosted in the right slot.
 * Not persisted - session-scoped only. Mutual exclusion with the AI sidebar,
 * SCM right panel, and extension right panels lives in App.tsx. Mirrors
 * `scmRightPanelStore`.
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

export const useSshRightPanelStore = create<State & Actions>((set, get) => ({
  open: false,
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
  toggle: () => set({ open: !get().open }),
}));
