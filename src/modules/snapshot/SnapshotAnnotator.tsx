import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { drawMarks, markFromDrag, type DragShape, type Fraction, type Mark } from "./annotate";

/**
 * The screenshot as a canvas at its full size, which is also what gets saved, so
 * what is on screen is exactly what is dropped. A click places a number and a drag
 * draws a numbered `shape`.
 */
export function SnapshotAnnotator({
  src,
  marks,
  shape,
  onChange,
  canvasRef,
}: {
  src: string;
  marks: Mark[];
  shape: DragShape;
  onChange: (marks: Mark[]) => void;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [draft, setDraft] = useState<Mark | null>(null);
  const start = useRef<Fraction | null>(null);

  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => {
      if (alive) setImage(img);
    };
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !image) return;
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    ctx.drawImage(image, 0, 0);
    drawMarks(ctx, canvas.width, canvas.height, draft ? [...marks, draft] : marks);
  }, [image, marks, draft, canvasRef]);

  // So Ctrl+Z works at once rather than reaching the terminal that had the focus.
  useEffect(() => {
    if (image) canvasRef.current?.focus();
  }, [image, canvasRef]);

  const locate = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      at: { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height },
      shown: { w: r.width, h: r.height },
    };
  };

  return (
    <canvas
      ref={canvasRef}
      tabIndex={0}
      aria-label={`Screenshot. Click to place a number, drag to draw ${shape === "box" ? "a box" : "an arrow"}.`}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = locate(e).at;
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        const { at, shown } = locate(e);
        setDraft(markFromDrag(start.current, at, shown, shape));
      }}
      onPointerUp={(e) => {
        if (!start.current) return;
        const { at, shown } = locate(e);
        onChange([...marks, markFromDrag(start.current, at, shown, shape)]);
        start.current = null;
        setDraft(null);
      }}
      onPointerCancel={() => {
        start.current = null;
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z") {
          e.preventDefault();
          e.stopPropagation();
          onChange(marks.slice(0, -1));
        }
      }}
      className="max-h-[62vh] max-w-full cursor-crosshair touch-none outline-none"
    />
  );
}
