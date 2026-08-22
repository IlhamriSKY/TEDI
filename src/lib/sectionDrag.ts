import { create } from "zustand";

/** Which of the two side columns. */
export type SectionColumn = "left" | "right";

/**
 * Cross-column state for the two side columns, in `src/lib` rather than beside
 * the components because BOTH layers write to it: the app layer's section stack
 * and drop rails, and the module-level headers whose own "move to the other
 * column" buttons live inside `modules/scm`, `modules/ssh`, `modules/ai` and the
 * extension section host.
 *
 * Two independent things, deliberately in one tiny store:
 *
 * `column` - which column currently has a section in hand. Only the OTHER column
 * reads it, and only to decide whether to put up a drop target: a column that is
 * empty renders no panel, and one that is minimized shut is in the DOM at zero
 * width, so in both cases a drag toward it lands on nothing.
 *
 * `revealSeq` / `revealedColumn` - a section has just been sent to that column,
 * by ANY route. The column watches it so that receiving one OPENS it if it is
 * shut. A counter rather than a boolean so two moves in a row to the same side
 * each fire, and keyed off the move itself rather than off the column's section
 * count: a count also rises when an SSH host connects or a repo opens, and
 * popping a column open for those would fight a user who deliberately closed it.
 */
export const useSectionDragStore = create<{
  column: SectionColumn | null;
  setColumn: (column: SectionColumn | null) => void;
  revealedColumn: SectionColumn | null;
  revealSeq: number;
  reveal: (column: SectionColumn) => void;
}>((set, get) => ({
  column: null,
  setColumn: (column) => set({ column }),
  revealedColumn: null,
  revealSeq: 0,
  reveal: (column) => set({ revealedColumn: column, revealSeq: get().revealSeq + 1 }),
}));

/** Ask `column` to show itself, because a section was just moved into it. Safe
 *  to call from anywhere; the column decides whether it is actually shut. */
export function revealColumn(column: SectionColumn): void {
  useSectionDragStore.getState().reveal(column);
}
