import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { IPC_EVENTS, type FsReadResult } from "@/lib/ipc";
import { IS_WINDOWS } from "@/lib/platform";
import { copyToClipboard } from "@/modules/explorer/lib/contextActions";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, Copy, GripVertical, ImageIcon, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** How long the card stays once the window is focused and the pointer is off it. */
const DISMISS_MS = 8000;
/** Pointer travel before a press becomes a drag, so a click stays a click. */
const DRAG_START_PX = 4;
/** Width of the drag ghost handed to macOS / GTK. */
const DRAG_ICON_PX = 160;

type Shot = { path: string; src: string | null };

/** A small PNG of the loaded thumbnail for the drag ghost. macOS and GTK draw
 *  the drag image at its natural size, so the screenshot itself would be a
 *  screen-sized ghost. Windows draws its own and needs none. */
function dragIcon(img: HTMLImageElement | null): string | null {
  if (IS_WINDOWS || !img?.naturalWidth) return null;
  const canvas = document.createElement("canvas");
  canvas.width = DRAG_ICON_PX;
  canvas.height = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * DRAG_ICON_PX));
  canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/**
 * Bottom-right preview of the screenshot the OS just saved (Rust
 * `modules/snapshot.rs` watches the screenshot folders and emits
 * `IPC_EVENTS.SNAPSHOT`).
 *
 * Clicking it opens the image in a pane beside the active one (`onOpen`).
 * Dragging it starts a NATIVE file drag (`snapshot_drag`), so it drops anywhere
 * a file does: onto a terminal it types the shell-quoted path through the
 * ordinary drop handler (`useTerminalFileDrop`), onto the AI composer it
 * attaches, and outside TEDI it is the file itself.
 *
 * The dismiss countdown only runs while TEDI is focused: a screenshot is
 * usually taken of ANOTHER app, and the card has to still be there when the
 * user switches back.
 */
export function SnapshotPreview({ onOpen }: { onOpen: (path: string) => void }) {
  const enabled = usePreferencesStore((s) => s.snapshotPreview);
  const hydrated = usePreferencesStore((s) => s.hydrated);
  const [shot, setShot] = useState<Shot | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [copied, setCopied] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  // Set once a press became a drag, so the click some platforms still deliver
  // after the drop does not also open the image.
  const draggedRef = useRef(false);

  useEffect(() => {
    // Wait for the real preference, so a user who turned it off never starts
    // the watcher for the moment before hydration.
    if (!hydrated) return;
    void invoke("snapshot_watch", { enabled }).catch((e) =>
      console.error("snapshot_watch failed:", e),
    );
    if (!enabled) setShot(null);
  }, [enabled, hydrated]);

  useEffect(() => {
    let alive = true;
    const unlistenP = listen<string>(IPC_EVENTS.SNAPSHOT, (e) => {
      const path = e.payload;
      // An event already in flight when the user turned the preview off.
      if (!path || !usePreferencesStore.getState().snapshotPreview) return;
      setShot({ path, src: null });
      setCopied(false);
      invoke<FsReadResult>("fs_read_file", { path })
        .then((r) => {
          if (!alive || r.kind !== "image") return;
          // Only fill in the thumbnail if this is still the shot on screen.
          setShot((curr) => (curr?.path === path ? { path, src: r.dataUrl } : curr));
        })
        .catch(() => {
          // No thumbnail (unreadable, too large, a format the webview cannot
          // draw); the path is still worth offering.
        });
    });
    return () => {
      alive = false;
      void unlistenP.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (!shot || hovered || !focused) return;
    const t = window.setTimeout(() => setShot(null), DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [shot, hovered, focused]);

  if (!shot) return null;
  const { path } = shot;
  const name = path.split(/[\\/]/).pop() ?? path;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    draggedRef.current = false;
    const sx = e.clientX;
    const sy = e.clientY;
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_START_PX) return;
      stop();
      draggedRef.current = true;
      // The OS drag loop owns the pointer from here, so the webview may never
      // see the pointer leave the card: without this the countdown would wait
      // for a mouseleave that does not come.
      setHovered(false);
      void invoke("snapshot_drag", { path, image: dragIcon(imgRef.current) }).catch((err) =>
        console.error("snapshot_drag failed:", err),
      );
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <div
      role="status"
      aria-label={`Screenshot ${name}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="bg-popover text-popover-foreground animate-in fade-in slide-in-from-right-3 fixed right-3 bottom-10 z-[60] w-64 border shadow-lg duration-200 ease-out"
    >
      <div onPointerDown={onPointerDown} className="cursor-pointer select-none">
        <IconTooltip
          label={
            <span className="flex flex-col gap-0.5">
              <span>Click to open in a pane, drag to drop anywhere</span>
              <span className="text-muted-foreground break-all">{path}</span>
            </span>
          }
          side="left"
        >
          <div
            role="button"
            tabIndex={0}
            aria-label={`Open ${name} in a pane`}
            onClick={() => {
              if (draggedRef.current) return;
              onOpen(path);
              setShot(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onOpen(path);
              setShot(null);
            }}
            className="bg-muted relative flex h-36 items-center justify-center overflow-hidden"
          >
            {shot.src ? (
              // Not natively draggable: the drag is the native one started above.
              <img
                ref={imgRef}
                src={shot.src}
                alt=""
                draggable={false}
                className="size-full object-contain"
              />
            ) : (
              <ImageIcon className="text-muted-foreground size-8" strokeWidth={1.5} />
            )}
          </div>
        </IconTooltip>
        <div className="text-muted-foreground flex items-center gap-1 py-1 pr-1 pl-2 text-[11px]">
          <GripVertical className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Click or drag</span>
          <IconTooltip label="Copy the file path" side="top">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                void copyToClipboard(path).then(() => setCopied(true));
              }}
            >
              {copied ? <Check /> : <Copy />}
              {copied ? "Copied" : "Copy path"}
            </Button>
          </IconTooltip>
        </div>
      </div>
      <IconTooltip label="Dismiss" side="left">
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Dismiss screenshot preview"
          onClick={() => setShot(null)}
          className="bg-popover/80 hover:bg-popover absolute top-1 right-1"
        >
          <X />
        </Button>
      </IconTooltip>
    </div>
  );
}
