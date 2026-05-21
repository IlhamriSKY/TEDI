import { create } from "zustand";

/** A single row inside an info-modal section. `kbd` renders monospaced
 *  (handy for command invocations like `/help`); `desc` is the explanation. */
export type InfoRow = {
  kbd?: string;
  label: string;
  desc?: string;
  /** Optional accent color: "ok" = green, "warn" = amber, "err" = red.
   *  Defaults to neutral. */
  tone?: "ok" | "warn" | "err";
};

export type InfoSection = {
  title?: string;
  rows: InfoRow[];
};

export type InfoModalPayload = {
  /** Unique-ish id so consumers can replace an existing modal (e.g. /help
   *  invoked twice should swap content, not stack). */
  id: string;
  title: string;
  subtitle?: string;
  sections: InfoSection[];
  /** Optional footer hint (rendered small, muted). */
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
