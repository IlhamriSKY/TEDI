import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { IPC_EVENTS, type FsReadResult } from "@/lib/ipc";
import { basename } from "@/lib/path";
import { IS_WINDOWS } from "@/lib/platform";
import { copyToClipboard } from "@/modules/explorer/lib/contextActions";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "@/components/ui/toast";
import {
  Check,
  Copy,
  GripVertical,
  ImageIcon,
  MoveUpRight,
  Pencil,
  Square,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { SnapshotAnnotator } from "./SnapshotAnnotator";
import type { DragShape, Mark } from "./annotate";

/** How long the card stays once the window is focused and the pointer is off it. */
const DISMISS_MS = 8000;
/** Pointer travel before a press becomes a drag, so a click stays a click. */
const DRAG_START_PX = 4;
/** Width of the drag ghost handed to macOS / GTK. */
const DRAG_ICON_PX = 160;

type Shot = { path: string; src: string | null };
/** The saved copy with the marks on it, and which marks those were. */
type Annotated = Shot & { marks: Mark[] };

/** A small PNG of what is on screen for the drag ghost. macOS and GTK draw the
 *  drag image at its natural size, so the screenshot itself would be a
 *  screen-sized ghost. Windows draws its own and needs none. */
function dragIcon(from: HTMLImageElement | HTMLCanvasElement | null): string | null {
  if (IS_WINDOWS || !from) return null;
  const isImg = from instanceof HTMLImageElement;
  const w = isImg ? from.naturalWidth : from.width;
  const h = isImg ? from.naturalHeight : from.height;
  if (!w) return null;
  const canvas = document.createElement("canvas");
  canvas.width = DRAG_ICON_PX;
  canvas.height = Math.max(1, Math.round((h / w) * DRAG_ICON_PX));
  canvas.getContext("2d")?.drawImage(from, 0, 0, canvas.width, canvas.height);
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
 * Edit grows the card in place, with no backdrop, so the terminal or composer the
 * result is going to stays in reach: mark it up, then drag straight from the card.
 * The marked copy goes to the cache folder, never over the original, and every save
 * gets a new name because the composer dedupes attachments by path.
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
  const [editing, setEditing] = useState(false);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [shape, setShape] = useState<DragShape>("box");
  const [annotated, setAnnotated] = useState<Annotated | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Set once a press became a drag, so the click some platforms still deliver
  // after the drop does not also open the image.
  const draggedRef = useRef(false);
  // Read by the event listener, which subscribes once.
  const editingRef = useRef(false);
  editingRef.current = editing;

  const close = useCallback(() => {
    setShot(null);
    setEditing(false);
    setMarks([]);
    setAnnotated(null);
  }, []);

  useEffect(() => {
    // Wait for the real preference, so a user who turned it off never starts
    // the watcher for the moment before hydration.
    if (!hydrated) return;
    void invoke("snapshot_watch", { enabled }).catch((e) =>
      console.error("snapshot_watch failed:", e),
    );
    if (!enabled) close();
  }, [enabled, hydrated, close]);

  useEffect(() => {
    let alive = true;
    const unlistenP = listen<string>(IPC_EVENTS.SNAPSHOT, (e) => {
      const path = e.payload;
      // An event already in flight when the user turned the preview off.
      if (!path || !usePreferencesStore.getState().snapshotPreview) return;
      // A capture taken mid-edit must not wipe the marks; the file is still on disk.
      if (editingRef.current) return;
      setShot({ path, src: null });
      setCopied(false);
      setMarks([]);
      setAnnotated(null);
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
    if (!shot || hovered || !focused || editing) return;
    const t = window.setTimeout(close, DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [shot, hovered, focused, editing, close]);

  if (!shot) return null;
  // What the card offers: the marked copy once there is one, else the capture.
  const { path, src } = annotated ?? shot;
  const name = basename(path);

  /** The file to hand over right now, saving the marks first if they moved. */
  const currentFile = async (): Promise<Shot | null> => {
    if (!editing) return { path, src };
    if (marks.length === 0) {
      setAnnotated(null);
      return shot;
    }
    if (annotated?.marks === marks) return annotated;
    const dataUrl = canvasRef.current?.toDataURL("image/png");
    if (!dataUrl) return null;
    try {
      const saved = await invoke<string>("snapshot_save_annotated", {
        source: shot.path,
        dataUrl,
      });
      const next = { path: saved, src: dataUrl, marks };
      setAnnotated(next);
      return next;
    } catch (e) {
      toast(`Could not save the marked screenshot: ${String(e)}`, { variant: "error" });
      return null;
    }
  };

  const finishEditing = () => {
    void currentFile().then((file) => {
      if (!file) return;
      setEditing(false);
      // The element that saw the pointer enter is gone, so no leave would ever arrive.
      setHovered(false);
    });
  };

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
      const ghost = dragIcon(editing ? canvasRef.current : imgRef.current);
      void currentFile().then((file) => {
        if (!file) return;
        void invoke("snapshot_drag", { path: file.path, image: ghost }).catch((err) =>
          console.error("snapshot_drag failed:", err),
        );
      });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const copyPath = () => {
    void currentFile().then((file) => {
      if (file) void copyToClipboard(file.path).then(() => setCopied(true));
    });
  };

  const changeMarks = (next: Mark[]) => {
    setMarks(next);
    setCopied(false);
  };

  if (editing && shot.src) {
    return (
      <div
        role="dialog"
        aria-label={`Mark up ${name}`}
        onKeyDown={(e) => {
          if (e.key === "Escape") finishEditing();
        }}
        className="bg-popover text-popover-foreground fixed right-3 bottom-10 z-[60] flex w-[min(720px,calc(100vw-1.5rem))] flex-col border shadow-lg"
      >
        <div className="text-muted-foreground flex items-center gap-1 py-1 pr-1 pl-2 text-[11px]">
          <span className="min-w-0 flex-1 truncate">Click for a number, or drag to draw:</span>
          <Button
            size="xs"
            variant={shape === "box" ? "secondary" : "ghost"}
            aria-pressed={shape === "box"}
            onClick={() => setShape("box")}
          >
            <Square />
            Box
          </Button>
          <Button
            size="xs"
            variant={shape === "arrow" ? "secondary" : "ghost"}
            aria-pressed={shape === "arrow"}
            onClick={() => setShape("arrow")}
          >
            <MoveUpRight />
            Arrow
          </Button>
          <span className="tedi-header-divider" aria-hidden />
          <Button
            size="xs"
            variant="ghost"
            disabled={marks.length === 0}
            onClick={() => changeMarks(marks.slice(0, -1))}
          >
            <Undo2 />
            Undo
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={marks.length === 0}
            onClick={() => changeMarks([])}
          >
            <Trash2 />
            Clear
          </Button>
        </div>
        <div className="bg-muted flex min-h-0 items-center justify-center overflow-hidden">
          <SnapshotAnnotator
            src={shot.src}
            marks={marks}
            shape={shape}
            onChange={changeMarks}
            canvasRef={canvasRef}
          />
        </div>
        <div className="text-muted-foreground flex items-center gap-1 py-1 pr-1 pl-2 text-[11px]">
          <div
            onPointerDown={onPointerDown}
            className="hover:text-foreground flex h-6 min-w-0 flex-1 cursor-grab items-center gap-1 select-none active:cursor-grabbing"
          >
            <GripVertical className="size-3 shrink-0" />
            <span className="truncate">Drag from here to drop the result</span>
          </div>
          <Button size="xs" variant="ghost" onClick={copyPath}>
            {copied ? <Check /> : <Copy />}
            {copied ? "Copied" : "Copy path"}
          </Button>
          <Button size="xs" variant="default" onClick={finishEditing}>
            <Check />
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-label={`Screenshot ${name}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="bg-popover text-popover-foreground animate-in fade-in slide-in-from-right-3 fixed right-3 bottom-10 z-[60] w-72 border shadow-lg duration-200 ease-out"
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
              close();
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onOpen(path);
              close();
            }}
            className="bg-muted relative flex h-36 items-center justify-center overflow-hidden"
          >
            {src ? (
              // Not natively draggable: the drag is the native one started above.
              <img
                ref={imgRef}
                src={src}
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
          {shot.src ? (
            <IconTooltip
              label="Add numbers, boxes and arrows, so an AI knows what you mean"
              side="top"
            >
              <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
            </IconTooltip>
          ) : null}
          <IconTooltip label="Copy the file path" side="top">
            <Button size="xs" variant="ghost" onClick={copyPath}>
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
          onClick={close}
          className="bg-popover/80 hover:bg-popover absolute top-1 right-1"
        >
          <X />
        </Button>
      </IconTooltip>
    </div>
  );
}
