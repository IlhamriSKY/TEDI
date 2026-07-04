import { create } from "zustand";

/**
 * Which leaves currently have an open float window. Set by floatHost on the
 * float's HELLO and cleared on its BYE, so the main pane can show a "floating"
 * indicator and stop rendering its now-redundant terminal until the float closes.
 */
type FloatStore = {
  floating: ReadonlySet<number>;
  setFloating: (leafId: number, on: boolean) => void;
};

export const useFloatStore = create<FloatStore>((set) => ({
  floating: new Set<number>(),
  setFloating: (leafId, on) =>
    set((s) => {
      if (s.floating.has(leafId) === on) return s;
      const next = new Set(s.floating);
      if (on) next.add(leafId);
      else next.delete(leafId);
      return { floating: next };
    }),
}));
