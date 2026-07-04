import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** Full-screen image preview. Click the backdrop or press Escape to close.
 *  Rendered into document.body so parent transforms/overflow can't clip it. */
export function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
    >
      <img
        src={url}
        alt=""
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        onClick={onClose}
        className="bg-secondary text-foreground hover:bg-destructive/10 hover:text-destructive absolute top-4 right-4 cursor-pointer rounded-md p-1.5"
        aria-label="Close preview"
      >
        <X size={16} strokeWidth={2} />
      </button>
    </div>,
    document.body,
  );
}
