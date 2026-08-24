import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { useSectionDragStore, type SectionColumn } from "@/lib/sectionDrag";
import { expandIfShut } from "@/app/lib/panelSize";

/**
 * The drop target a column puts up while the OTHER one is dragging a section
 * across, for the two cases where the column itself cannot be aimed at:
 *
 *   - it holds nothing, so it renders no panel at all (the right column's
 *     normal empty state);
 *   - it is minimized shut, so it is in the DOM at zero width.
 *
 * `SectionStack` hit-tests the pointer against `[data-section-column="..."]`
 * rectangles, and a zero-sized rect is not a target, so without this a drag
 * toward a closed column silently did nothing and the header's move button was
 * the only way across. That was true in BOTH directions, which is why this is
 * shared rather than living in the right column where it started.
 *
 * `fixed` and portalled to `body` on purpose: laying a real panel out mid-drag
 * would reflow the workspace out from under the pointer, and the component's own
 * slot in the tree is a direct child of the `ResizablePanelGroup`, which expects
 * panels and separators there rather than a loose div.
 */
export function SectionDropRail({ column }: { column: SectionColumn }) {
  const dragging = useSectionDragStore((s) => s.column);
  const active = dragging !== null && dragging !== column;
  // Whether this column already offers something to aim at. Measured when a
  // drag STARTS rather than read during render: it is a layout read, and it
  // cannot change while the pointer is down (the panel group is not resizing).
  const [needed, setNeeded] = useState(false);
  useEffect(() => {
    if (!active) {
      setNeeded(false);
      return;
    }
    const own = document.querySelector<HTMLElement>(`[data-section-column="${column}"]`);
    const r = own?.getBoundingClientRect();
    setNeeded(!r || r.width === 0 || r.height === 0);
  }, [active, column]);

  if (!active || !needed) return null;
  return createPortal(
    <div
      data-section-column={column}
      // Spans the body region: the header is two rows (h-9 toolbar + h-10 tab
      // strip = 76px) and the status bar is h-8. Stated rather than measured
      // because it is `fixed` - the panel group it would otherwise sit in is not
      // a positioned ancestor, and giving it one to serve a rail that lives for
      // the length of a drag is the wrong trade.
      className={cn(
        "border-primary/60 bg-primary/10 text-primary pointer-events-none fixed top-[76px] bottom-8 z-50 flex w-28 items-center justify-center rounded-md border border-dashed p-2 text-center text-[11px] font-medium",
        column === "left" ? "left-1.5" : "right-1.5",
      )}
    >
      {column === "left" ? "Drop to dock left" : "Drop to dock right"}
    </div>,
    document.body,
  );
}

/**
 * Opens this column when a section is dropped into it, so a drop into a column
 * that is minimized shut does not put the section somewhere invisible.
 *
 * Keyed off the drag store's landing counter rather than off the column's own
 * section count: a count can rise for reasons that are not a drop (an SSH host
 * connecting adds Remote, a repo opening adds Source Control), and popping a
 * column back open for those would fight a user who deliberately closed it.
 */
export function useExpandOnSectionArrival(
  column: SectionColumn,
  ref: React.RefObject<PanelImperativeHandle | null>,
): void {
  const seq = useSectionDragStore((s) => s.revealSeq);
  const revealed = useSectionDragStore((s) => s.revealedColumn);
  const seen = useRef(seq);
  useEffect(() => {
    if (seq === seen.current) return;
    seen.current = seq;
    if (revealed !== column) return;
    const panel = ref.current;
    // Also safe on the frame the arriving section mounts the panel, when the
    // group has no layout for it yet.
    expandIfShut(panel);
  }, [seq, revealed, column, ref]);
}
