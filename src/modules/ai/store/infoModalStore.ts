import { create } from "zustand";

/** Row inside an info-modal section. `kbd` renders monospaced; `desc` is the explanation. */
export type InfoRow = {
  kbd?: string;
  label: string;
  desc?: string;
  /** Accent color: ok=green, warn=amber, err=red. Defaults to neutral. */
  tone?: "ok" | "warn" | "err";
};

export type InfoSection = {
  title?: string;
  rows: InfoRow[];
};

export type InfoModalPayload = {
  /** Id so consumers can swap an existing modal instead of stacking. */
  id: string;
  title: string;
  subtitle?: string;
  sections: InfoSection[];
  /** Footer hint (rendered small and muted). */
  footer?: string;
};

type State = {
  current: InfoModalPayload | null;
  show: (payload: InfoModalPayload) => void;
  dismiss: () => void;
};

export const useInfoModalStore = create<State>((set) => ({
  current: null,
  show: (payload) => set({ current: payload }),
  dismiss: () => set({ current: null }),
}));

export function showInfoModal(payload: InfoModalPayload): void {
  useInfoModalStore.getState().show(payload);
}
