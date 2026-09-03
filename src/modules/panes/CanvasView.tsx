/**
 * Canvas view: EVERY pane in the workspace drawn as a free-floating,
 * overlapping window you drag, resize and stack, on one surface with no tab
 * strip. One of the workspace's three presentations (see `WorkspaceView`),
 * alongside tabs and kanban.
 *
 * It renders nothing of its own: each window body is the same `LeafBody` the
 * split view uses, so a terminal, editor, browser, source control, board or
 * extension panel (SQL Explorer, API Client) keeps its PTY, session disposal,
 * AI context and workspace restore exactly as in tabs view. The tabs still
 * exist underneath - the canvas just lays their leaves out itself - which is
 * why switching views never respawns anything.
 *
 * Geometry lives on the LEAF (`PaneLeaf.canvasRect`) as percentages of the
 * canvas box, so it travels with a pane between tabs and rescales instead of
 * clipping when the window, sidebar or right slot resizes.
 */
import { use, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { InlineInput } from "@/modules/explorer/InlineInput";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LeafIcon } from "@/components/LeafIcon";
import { resolveExtIcon } from "@/lib/iconRegistry";
import { cn } from "@/lib/utils";
import { panelsRegistry, useRegistry } from "@/modules/extensions";
import { useBrowserExtensionReady } from "@/modules/extensions/browserBridge";
import { AiChatMenuItems } from "@/modules/ai/components/AiChatMenuItems";
import { statusLabelClass } from "@/modules/ssh/status";
import { extensionStateLabelClass } from "@/modules/tabs/lib/entries";
import { leafLabel, leafRenameSeed } from "@/modules/tabs/lib/tabHelpers";
import type { PaneTab } from "@/modules/tabs";
import { leaves, type CanvasRect, type PaneLeaf } from "@/modules/terminal/lib/panes";
import {
  clampPan,
  contentBounds,
  fitView,
  isNearViewport,
  mapRegion,
  zoomAbout,
  viewportBox,
  type Viewport,
} from "./canvasViewport";
import {
  FileCode,
  GitBranch,
  Globe,
  LayoutDashboard,
  Minus,
  Pin,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  LeafBody,
  PaneMetaContext,
  leafIconInfo,
  useRemoteEditorBinding,
  type LeafBundle,
  type PaneMetaValue,
} from "./PaneTreeView";

/** Smallest window edge, in device px. Converted to a percentage against the
 *  live canvas size so a small window stays usable on any display. */
const MIN_EDGE_PX = 200;

/**
 * What a pointer gesture on a window does: move it, or drag one of its eight
 * resize handles (`n`/`s`/`e`/`w` and the four corners).
 *
 * All eight, not just the bottom-right corner it started as: a lone 16px
 * invisible corner is the whole window's resize affordance, it sits under the
 * frame's rounded clip, and every other windowing surface lets you grab an
 * EDGE - so "resize doesn't work" was the only possible verdict.
 */
type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/** Placement + cursor for each resize handle. Edges stop short of the corners so
 *  a corner grab is never ambiguous. `z-20` clears the drag shield (`z-10`) and
 *  anything the leaf body paints. The handles paint NOTHING: the resize cursor
 *  is the affordance, the way it is on any window edge, and a highlight on eight
 *  invisible strips only made the frame flicker as the pointer crossed it. */
const HANDLES: { h: Handle; cls: string }[] = [
  { h: "n", cls: "top-0 right-3 left-3 h-1.5 cursor-ns-resize" },
  { h: "s", cls: "right-3 bottom-0 left-3 h-1.5 cursor-ns-resize" },
  { h: "w", cls: "top-3 bottom-3 left-0 w-1.5 cursor-ew-resize" },
  { h: "e", cls: "top-3 right-0 bottom-3 w-1.5 cursor-ew-resize" },
  { h: "nw", cls: "top-0 left-0 size-3 cursor-nwse-resize" },
  { h: "ne", cls: "top-0 right-0 size-3 cursor-nesw-resize" },
  { h: "sw", cls: "bottom-0 left-0 size-3 cursor-nesw-resize" },
  { h: "se", cls: "right-0 bottom-0 size-3 cursor-nwse-resize" },
];
/** Aspect of the minimap BODY (w-40 x h-24), so the region it frames is
 *  letterboxed to match instead of being stretched to fill. */
const MAP_ASPECT = 160 / 96;

/** Gutter between windows after Tidy, in percent of the canvas. */
const TIDY_GAP = 1.2;

/** Base `zIndex` a pinned window is lifted by. Far above any `z` a session of
 *  clicking could reach, so "pinned" always wins without capping the counter. */
const PINNED_Z = 1_000_000;

/**
 * Canvas viewport bounds. Zooming OUT below 1 is the point of it: the window
 * layer is box-sized, so at 0.4 the whole 0..100 coordinate space occupies less
 * than half the screen and a dozen panes fit at once; above 1 you work close in
 * and pan around.
 */
const VIEW_MIN = 0.15;
const VIEW_MAX = 2;
const VIEW_STEP = 0.15;

/**
 * How far the canvas actually goes, in the same 0..100 units a window rect uses.
 *
 * The space used to be unbounded while the ZOOM was not, and those two together
 * lose panes: zoomed out, a drag covers `1/zoom` times as much canvas per pixel,
 * so a short flick at 25% throws a window hundreds of units away - somewhere no
 * amount of further zooming out can bring back into view. Bounding the canvas to
 * exactly one fully-zoomed-out viewport (`100 / VIEW_MIN`) makes "zoom all the
 * way out" always show everything, which is what makes a window impossible to
 * lose. The base 0..100 area sits in the middle of it.
 *
 * Tied to the zoom floor rather than picked, so making the canvas bigger is one
 * edit: drop `VIEW_MIN` and the room grows with it, still fully framed by Fit.
 * At 0.15 that is ~6.7 screens each way - 44 screenfuls of area.
 */
const EXTENT = 100 / VIEW_MIN;
const CANVAS_MIN = (100 - EXTENT) / 2;
const CANVAS_MAX = CANVAS_MIN + EXTENT;

/** Auto-pan while a window is dragged against the viewport edge: how deep the
 *  trigger band is (device px) and how fast it pans (box-percent per frame). */
const EDGE_BAND_PX = 56;
const EDGE_PAN_STEP = 1.1;

/** Per-pane zoom bounds and step. Same 0.1 step the app-wide content zoom uses,
 *  so a canvas pane and the status-bar control move in the same increments. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;

/**
 * Geometry for a window that has none yet. Seeded on first render, which is
 * what lets a pane arrive from ANY path - the canvas `+`, a split, a tab opened
 * while in tabs view, a workspace saved before canvas existed - without a
 * single opener having to know about geometry.
 *
 * Placed against the VIEWPORT, not the canvas: the canvas is now many screens
 * across, so a fixed spot in its coordinate space is usually somewhere the user
 * is not looking, and a new pane simply never appeared. Centred on what is on
 * screen, at the same share OF THE SCREEN whatever the zoom (so one opened
 * while zoomed out is not a postage stamp), then cascaded a little per window
 * so a run of them is reachable rather than one stack.
 */
function defaultCanvasRect(index: number, z: number, view: Viewport): CanvasRect {
  const v = viewportBox(view);
  const w = v.w * 0.46;
  const h = v.h * 0.48;
  const step = index % 6;
  return insideCanvas({
    x: v.x + (v.w - w) / 2 + step * v.w * 0.03,
    y: v.y + (v.h - h) / 2 + step * v.h * 0.03,
    w,
    h,
    z,
  });
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Hold a window inside the canvas (see `EXTENT`). One place, so a move and an
 *  edge-resize cannot disagree about where the canvas ends. */
function insideCanvas(r: CanvasRect): CanvasRect {
  const w = Math.min(r.w, EXTENT);
  const h = Math.min(r.h, EXTENT);
  return {
    ...r,
    w,
    h,
    x: clamp(r.x, CANVAS_MIN, CANVAS_MAX - w),
    y: clamp(r.y, CANVAS_MIN, CANVAS_MAX - h),
  };
}

/** `MIN_EDGE_PX` as a percentage of `boxPx`, floored and capped so a very small
 *  or very large canvas still leaves room for more than one window. */
const minPct = (boxPx: number) => clamp((MIN_EDGE_PX / Math.max(boxPx, 1)) * 100, 8, 30);

/** What the canvas `+` can open. Each entry is an EXISTING tab opener, so a
 *  window added here is an ordinary single-pane tab that the canvas then
 *  places - the same pane tabs view would show, and it survives a view switch. */
export type CanvasAdders = {
  terminal: () => void;
  editor: () => void;
  browser: () => void;
  sourceControl: () => void;
  board: () => void;
  /** Open one chat as a pane, deduped on the session. */
  aiChat: (sessionId: string) => void;
  extensionPanel: (extensionId: string, panelId: string, title: string, icon?: string) => void;
};

type Props = {
  /** Every pane tab in the workspace. Canvas is a view of the WORKSPACE, so it
   *  draws all their leaves on one surface. */
  tabs: PaneTab[];
  /** Owning tab of the focused pane, so exactly one window wears the ring. */
  activeTabId: number;
  getBundle: (leafId: number) => LeafBundle;
  mdPreviewLeafIds: ReadonlySet<number>;
  /** Focus a pane. Two-arg because a canvas spans tabs: focusing a window has
   *  to activate its owning tab too, or switching back to tabs view lands
   *  somewhere the user was not looking. */
  onFocusLeaf: (tabId: number, leafId: number) => void;
  /** Close a window. Routes through the app's dirty-editor confirm. */
  onCloseLeaf?: (leafId: number) => void;
  /** Merge geometry for one or more windows (drag, resize, raise, tidy, seed).
   *  Field-by-field, so each caller sends only what it changed. */
  onSetRects: (patch: Record<number, Partial<CanvasRect>>) => void;
  add: CanvasAdders;
  /** Workspace-wide values every leaf body may need (ssh hosts + statuses, the
   *  board's tab list, the SCM root). Provided here because a canvas window
   *  renders `LeafBody` outside `PaneTreeView`'s own provider. */
  meta: PaneMetaValue;
};

export function CanvasView({
  tabs,
  activeTabId,
  getBundle,
  mdPreviewLeafIds,
  onFocusLeaf,
  onCloseLeaf,
  onSetRects,
  add,
  meta,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  // Every pane of the workspace, paired with the tab that owns it.
  const list = useMemo(
    () => tabs.flatMap((t) => leaves(t.paneTree).map((leaf) => ({ leaf, tabId: t.id }))),
    [tabs],
  );

  // Panels an installed extension offers as a mountable surface - the SQL
  // Explorer (database) and API Client (API testing) among them. Read from the
  // registry so the menu follows install / enable / disable with no core list.
  const extPanels = useRegistry(panelsRegistry).filter((p) => p.item.surface === "tab");

  /**
   * The canvas viewport: `translate(pan%) scale(zoom)` with a top-left origin on
   * a box-sized layer, so a point at layer-coordinate `p` sits at box-percentage
   * `pan + p * zoom`. Keeping pan in PERCENT OF THE BOX (not pixels) means the
   * whole thing survives a window resize with no recomputation, exactly like the
   * window rectangles it contains.
   *
   * Local state, not persisted: it is where you are LOOKING, not what the
   * workspace contains, and it resets to a full view when you come back.
   */
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  // Live mirror of the view, so the seeding effect and the auto-pan loop can
  // read where we are looking without listing it as a dependency (a pan would
  // otherwise re-run them on every frame).
  const viewRef = useRef(view);
  viewRef.current = view;

  const maxZ = useMemo(
    () => list.reduce((m, { leaf }) => Math.max(m, leaf.canvasRect?.z ?? 0), 0),
    [list],
  );

  // Seed geometry for any pane that has none - one added from the canvas `+`, a
  // split, a tab opened while in tabs view, a workspace saved before canvas
  // existed. One place, so no opener has to know about rectangles.
  useEffect(() => {
    const missing = list.filter(({ leaf }) => leaf.canvasRect === undefined);
    if (missing.length === 0) return;
    const seeded = list.length - missing.length;
    let z = maxZ;
    const patch: Record<number, CanvasRect> = {};
    missing.forEach(({ leaf }, i) => {
      patch[leaf.id] = defaultCanvasRect(seeded + i, ++z, viewRef.current);
    });
    onSetRects(patch);
  }, [list, maxZ, onSetRects]);

  const raise = useCallback(
    (leafId: number) => {
      const hit = list.find(({ leaf }) => leaf.id === leafId)?.leaf;
      if (!hit?.canvasRect || hit.canvasRect.z >= maxZ) return;
      onSetRects({ [leafId]: { z: maxZ + 1 } });
    },
    [list, maxZ, onSetRects],
  );

  /** Lay every window out in a grid. The one-click answer to a canvas that has
   *  drifted into a pile, and to a window dragged somewhere unhelpful. */
  const tidy = () => {
    const n = list.length;
    if (n === 0) return;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const patch: Record<number, CanvasRect> = {};
    list.forEach(({ leaf }, i) => {
      const c = i % cols;
      const r = Math.floor(i / cols);
      patch[leaf.id] = {
        x: (c * 100) / cols + TIDY_GAP / 2,
        y: (r * 100) / rows + TIDY_GAP / 2,
        w: 100 / cols - TIDY_GAP,
        h: 100 / rows - TIDY_GAP,
        z: i + 1,
      };
    });
    onSetRects(patch);
  };

  /** Everything placed. What "how far can I pan" and "what does Fit mean"
   *  answer to, alongside the canvas edge itself. */
  const bounds = useMemo(
    () => contentBounds(list.flatMap(({ leaf }) => (leaf.canvasRect ? [leaf.canvasRect] : []))),
    [list],
  );
  // Mirrored for the same reason as `viewRef`: the auto-pan loop reads it every
  // frame and must not be rebuilt (nor its rAF restarted) when it changes.
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  /**
   * Pan by one auto-pan step, and answer with how far the canvas moved UNDER a
   * fixed screen point, in canvas units. A window being dragged adds that to its
   * own position so it stays under the pointer while the canvas slides past.
   *
   * Reads and writes `viewRef` as well as state so a burst of frames composes:
   * `setView` has not re-rendered yet when the next frame asks.
   */
  const autoPanBy = useCallback((gx: number, gy: number): { dx: number; dy: number } => {
    const v = viewRef.current;
    const next = clampPan(
      v.x - gx * EDGE_PAN_STEP,
      v.y - gy * EDGE_PAN_STEP,
      v.zoom,
      boundsRef.current,
    );
    if (next.x === v.x && next.y === v.y) return { dx: 0, dy: 0 };
    viewRef.current = { ...v, ...next };
    setView((prev) => ({ ...prev, ...next }));
    return { dx: -(next.x - v.x) / v.zoom, dy: -(next.y - v.y) / v.zoom };
  }, []);

  /** Frame everything, with a margin. The "where did my panes go" of a canvas
   *  with no edges; on an untouched one it lands back at 100%. */
  const fitAll = useCallback(() => setView(fitView(bounds, VIEW_MIN, VIEW_MAX)), [bounds]);

  /**
   * Step the zoom about a point given in box percentages, so the spot under the
   * pointer (or the middle, for the buttons) stays put.
   *
   * Takes a DELTA and reads the current zoom inside the updater, never from the
   * render closure: several wheel ticks, or two fast clicks, land in one React
   * batch where that closure is still the pre-step value, and every one of them
   * would compute the same target - so a four-click zoom-out moved one step.
   */
  const zoomBy = useCallback(
    (delta: number, atX = 50, atY = 50) =>
      setView((v) => zoomAbout(v, v.zoom + delta, atX, atY, bounds, VIEW_MIN, VIEW_MAX)),
    [bounds],
  );

  /** Ctrl/Cmd + wheel over the BACKGROUND zooms the canvas. Over a window the
   *  same chord zooms that pane instead, and the window swallows it first. */
  const onBackgroundWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const box = boxRef.current;
    if (!box) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    zoomBy(
      -Math.sign(e.deltaY) * VIEW_STEP,
      ((e.clientX - r.left) / r.width) * 100,
      ((e.clientY - r.top) / r.height) * 100,
    );
  };

  /** Drag the empty background to pan. There is nothing else a background drag
   *  could mean, so it needs no modifier. */
  const startPan = (e: React.PointerEvent) => {
    const box = boxRef.current;
    if (!box) return;
    // Left button pans from empty canvas - over a window a left drag is that
    // window's (the header moves it, the body selects text). The MIDDLE button
    // pans from anywhere, including straight over a window, for a canvas whose
    // windows leave no gap to grab.
    //
    // "Empty" is "not inside a window", NOT "the event target IS the layer".
    // The layer is box-sized and transformed, so the moment you pan or zoom at
    // all its own box slides off screen and most of what you see is the box
    // behind it - the identity test then failed everywhere and dragging the
    // background silently stopped working, which is what "the canvas does not
    // move" was. The minimap stops propagation, so it keeps its own drag.
    const onWindow = (e.target as Element | null)?.closest?.("[data-pane-leaf]") != null;
    if (e.button !== 1 && !(e.button === 0 && !onWindow)) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const from = view;
    const onMove = (ev: globalThis.PointerEvent) => {
      const dx = ((ev.clientX - sx) / r.width) * 100;
      const dy = ((ev.clientY - sy) / r.height) * 100;
      setView((v) => ({ ...v, ...clampPan(from.x + dx, from.y + dy, v.zoom, bounds) }));
    };
    const end = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
  };

  const hasKind = (kind: PaneLeaf["leafKind"]) => list.some(({ leaf }) => leaf.leafKind === kind);
  /** Chats already on this canvas, so the menu can grey them out rather than
   *  silently focusing one when the user expected a new window. */
  const openChats = useMemo(
    () => new Set(list.flatMap(({ leaf }) => (leaf.leafKind === "ai" ? [leaf.sessionId] : []))),
    [list],
  );
  /** The one pane wearing the focus ring: the active tab's active leaf. Looked
   *  up once, not once per window. */
  const focusedLeafId = tabs.find((t) => t.id === activeTabId)?.activeLeafId;
  const browserReady = useBrowserExtensionReady();

  /**
   * The Add menu, declared once and rendered by BOTH openers: the toolbar
   * button and the background right-click. One element, so the two can never
   * drift into offering different things.
   */
  const addMenu = (
    <DropdownMenuContent align="start" className="min-w-52">
      <DropdownMenuItem onSelect={add.terminal}>
        <SquareTerminal size={14} strokeWidth={1.75} />
        <span className="flex-1">Terminal</span>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={add.editor}>
        <FileCode size={14} strokeWidth={1.75} />
        <span className="flex-1">Editor</span>
      </DropdownMenuItem>
      {/* Only when the browser extension is actually installed and enabled.
          Core has no browser of its own any more, so an always-visible entry
          would be a menu item that silently does nothing. */}
      {browserReady ? (
        <DropdownMenuItem onSelect={add.browser}>
          <Globe size={14} strokeWidth={1.75} />
          <span className="flex-1">Browser</span>
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem disabled={hasKind("scm")} onSelect={add.sourceControl}>
        <GitBranch size={14} strokeWidth={1.75} />
        <span className="flex-1">Source Control</span>
      </DropdownMenuItem>
      <DropdownMenuItem disabled={hasKind("board")} onSelect={add.board}>
        <LayoutDashboard size={14} strokeWidth={1.75} />
        <span className="flex-1">Board</span>
      </DropdownMenuItem>
      <AiChatMenuItems openSessions={openChats} onOpen={add.aiChat} />
      {extPanels.length > 0 ? <DropdownMenuSeparator /> : null}
      {extPanels.map(({ extensionId, item }) => {
        const Icon = resolveExtIcon(item.icon) ?? LayoutDashboard;
        return (
          <DropdownMenuItem
            key={`${extensionId}:${item.id}`}
            onSelect={() =>
              add.extensionPanel(extensionId, item.id, item.title, item.icon ?? undefined)
            }
          >
            <Icon size={14} strokeWidth={1.75} />
            <span className="flex-1">{item.title}</span>
          </DropdownMenuItem>
        );
      })}
    </DropdownMenuContent>
  );

  /**
   * Where the last right-click asked for the menu, in box pixels, and whether
   * it is showing. Radix needs an anchor in the DOM, so a 1px span is parked
   * there and the menu opens against it.
   *
   * The point OUTLIVES the close on purpose. The popper tracks the anchor now
   * (see the span), so clearing the position on close dragged the menu to the
   * canvas corner while it was still fading - a blink out of the top left on
   * every dismiss. Only `open` changes; the span stays where it was.
   */
  const [menu, setMenu] = useState({ x: 0, y: 0, open: false });

  return (
    <PaneMetaContext.Provider value={meta}>
      <div className="flex h-full w-full flex-col gap-1.5">
        <div className="border-border bg-card flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs">
                <Plus size={13} strokeWidth={2} />
                Add
              </Button>
            </DropdownMenuTrigger>
            {addMenu}
          </DropdownMenu>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={tidy}>
            Tidy
          </Button>
          {/* Two badges, built like the status bar's zoom pill. The window
              headers carry a BARE `- 100% +` for that pane's own zoom, so the
              bordered pill is also what tells the canvas zoom apart from it. */}
          <div role="group" aria-label="Canvas zoom" className={cn(PILL, "ml-auto")}>
            <PillSeg
              label="Zoom out canvas"
              disabled={view.zoom <= VIEW_MIN}
              className="w-6"
              onClick={() => zoomBy(-VIEW_STEP)}
            >
              <Minus size={12} strokeWidth={2} className="shrink-0" />
            </PillSeg>
            {/* Fixed width + tabular-nums so stepping never resizes the pill and
                shifts the badge beside it. */}
            <PillSeg
              label="Fit all panes (Ctrl + wheel to zoom, drag to pan)"
              className="w-11 tabular-nums"
              onClick={fitAll}
            >
              {`${Math.round(view.zoom * 100)}%`}
            </PillSeg>
            <PillSeg
              label="Zoom in canvas"
              disabled={view.zoom >= VIEW_MAX}
              className="w-6"
              onClick={() => zoomBy(VIEW_STEP)}
            >
              <Plus size={12} strokeWidth={2} className="shrink-0" />
            </PillSeg>
          </div>
          <span className={cn(PILL, "px-2 tabular-nums")}>
            {list.length} {list.length === 1 ? "pane" : "panes"}
          </span>
        </div>

        <div
          ref={boxRef}
          data-canvas
          onWheel={onBackgroundWheel}
          // Right-click anywhere on the canvas gets the canvas menu, at the
          // pointer. On the BOX rather than the window layer, and gated on
          // `defaultPrevented` rather than on the target being the background:
          // anything with a menu of its own (a terminal's copy/paste, an
          // editor, any Radix menu) has already cancelled the event by the time
          // it bubbles here, and everything that has none - a window header,
          // the minimap, an extension panel - used to fall through to
          // WebView2's own "Refresh / Save as / Print" menu.
          onContextMenu={(e) => {
            if (e.defaultPrevented) return;
            const r = boxRef.current?.getBoundingClientRect();
            if (!r) return;
            e.preventDefault();
            setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, open: true });
          }}
          // Middle-drag pans from anywhere, so this has to catch the pointer
          // over a window too. Left-drag is filtered back to the bare layer
          // inside `startPan`.
          onPointerDown={startPan}
          // Chromium opens its middle-click autoscroll widget on mousedown,
          // which a pointerdown preventDefault does not stop.
          onMouseDown={(e) => {
            if (e.button === 1) e.preventDefault();
          }}
          className="bg-sidebar/40 border-border/60 relative min-h-0 flex-1 cursor-grab overflow-hidden rounded-md border"
        >
          {/* The window layer. Box-sized and transformed as a whole, so window
              rectangles stay in one 0..100 space no matter where the viewport
              is - the minimap and the drag math both read that space directly.
              `origin-top-left` is what makes `pan + p * zoom` the whole mapping.
              A terminal inside is RASTER-scaled at zoom != 1 (soft, but exactly
              placed): xterm measures its own layout, which a transform leaves
              alone, unlike CSS `zoom`. */}
          <div
            className="absolute inset-0 origin-top-left"
            style={{ transform: `translate(${view.x}%, ${view.y}%) scale(${view.zoom})` }}
          >
            {/* The canvas itself: where it ends, and the dot grid that makes a
                pan or a zoom VISIBLE. Both live INSIDE the transformed layer and
                span the whole extent, so they move and scale with the content -
                a grid pinned to the viewport made dragging the background look
                like nothing had happened at all, which is what "the canvas does
                not move" was. `pointer-events-none` keeps it out of the
                background/window hit test `startPan` relies on. */}
            <div
              aria-hidden
              className="border-border/70 pointer-events-none absolute rounded-md border-dashed bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] bg-[length:16px_16px]"
              style={{
                left: `${CANVAS_MIN}%`,
                top: `${CANVAS_MIN}%`,
                width: `${EXTENT}%`,
                height: `${EXTENT}%`,
                // Divided by the zoom so the edge is the SAME 2px on screen at
                // every scale. It lives inside the scaled layer (which is what
                // makes it move with the canvas), and a plain `border-2` there
                // renders 0.3px at the 15% floor - an edge you cannot see is
                // not an edge.
                borderWidth: `${2 / view.zoom}px`,
              }}
            />
            {list.map(({ leaf, tabId }, i) => {
              const rect = leaf.canvasRect ?? defaultCanvasRect(i, i + 1, view);
              return (
                <CanvasWindow
                  key={leaf.id}
                  node={leaf}
                  rect={rect}
                  onScreen={isNearViewport(rect, view)}
                  boxRef={boxRef}
                  focused={leaf.id === focusedLeafId}
                  b={getBundle(leaf.id)}
                  mdPreview={mdPreviewLeafIds.has(leaf.id)}
                  onFocus={() => {
                    onFocusLeaf(tabId, leaf.id);
                    raise(leaf.id);
                  }}
                  onClose={onCloseLeaf ? () => onCloseLeaf(leaf.id) : undefined}
                  onCommit={(patch) => onSetRects({ [leaf.id]: patch })}
                  viewZoom={view.zoom}
                  autoPanBy={autoPanBy}
                />
              );
            })}
          </div>
          {/* Anchored to the pointer. The span lives in the BOX, not the
              transformed layer, so the menu opens where the cursor actually is
              rather than where the layer's scaled coordinates would put it. */}
          {/* Not modal, which is what lets a SECOND right-click land somewhere
              new while this one is still open. A modal menu puts
              `pointer-events: none` on the body, so the next right-click never
              reaches the canvas at all: it only dismissed the menu, and the
              user had to right-click a third time to get one where they were
              actually pointing. Non-modal, the dismiss and the re-open both
              fire and the menu appears under the new pointer. */}
          <DropdownMenu
            modal={false}
            open={menu.open}
            onOpenChange={(open) => {
              if (!open) setMenu((m) => ({ ...m, open: false }));
            }}
          >
            <DropdownMenuTrigger asChild>
              {/* 1px, not `size-0`: floating-ui only watches a reference for
                  movement if it HAS a box (`observeMove` returns early on a
                  zero width or height), so a zero-size anchor pins the open
                  menu to wherever it first appeared - the second right-click
                  moved this span and the menu stayed put. */}
              <span
                aria-hidden
                className="pointer-events-none absolute size-px"
                style={{ left: menu.x, top: menu.y }}
              />
            </DropdownMenuTrigger>
            {addMenu}
          </DropdownMenu>
          <Minimap
            windows={list.map(({ leaf }, i) => ({
              id: leaf.id,
              rect: leaf.canvasRect ?? defaultCanvasRect(i, i + 1, view),
              focused: leaf.id === focusedLeafId,
            }))}
            view={view}
            onPanTo={(x, y) =>
              setView((v) => ({
                ...v,
                // Centre the viewport on the clicked point.
                ...clampPan(50 - x * v.zoom, 50 - y * v.zoom, v.zoom, bounds),
              }))
            }
          />
        </div>
      </div>
    </PaneMetaContext.Provider>
  );
}

/**
 * Overview of the canvas, bottom right: every window as a block in the same
 * 0..100 space they are stored in, plus the slice of it currently on screen.
 * Click or drag to go there.
 *
 * Worth its 40 lines only once zooming exists - at 100% the viewport IS the
 * canvas and the map would show one rectangle over another - so it hides
 * itself until the view moves, and the canvas stays clean by default.
 */
function Minimap({
  windows,
  view,
  onPanTo,
}: {
  windows: { id: number; rect: CanvasRect; focused: boolean }[];
  view: Viewport;
  onPanTo: (x: number, y: number) => void;
}) {
  const bodyRef = useRef<HTMLSpanElement>(null);

  // Always on. A canvas with no edges has no other way to answer "where am I,
  // and what else is out there", and a map that comes and goes is one more
  // thing to work out. An empty canvas has nothing to frame, which is the only
  // case it steps aside for.
  if (windows.length === 0) return null;

  const v = viewportBox(view);
  const region = mapRegion(contentBounds(windows.map((w) => w.rect)), view, MAP_ASPECT);
  /** Canvas coordinates -> percentages of the map body. */
  const mx = (n: number) => ((n - region.x) / region.w) * 100;
  const my = (n: number) => ((n - region.y) / region.h) * 100;

  const goTo = (e: React.PointerEvent) => {
    // The BODY, not the outer box: that now carries a label strip, and
    // measuring it would shift every click down by the strip's height.
    const r = bodyRef.current?.getBoundingClientRect();
    if (!r) return;
    onPanTo(
      region.x + ((e.clientX - r.left) / r.width) * region.w,
      region.y + ((e.clientY - r.top) / r.height) * region.h,
    );
  };

  return (
    <div
      aria-hidden
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        goTo(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) goTo(e);
      }}
      className="border-border bg-card/90 absolute right-2 bottom-2 h-24 w-40 cursor-pointer overflow-hidden rounded-md border shadow-lg"
    >
      <span ref={bodyRef} className="absolute inset-0 block">
        {windows.map((w) => (
          <div
            key={w.id}
            className={cn(
              "absolute rounded-[1px]",
              w.focused ? "bg-primary/70" : "bg-muted-foreground/40",
            )}
            style={{
              left: `${mx(w.rect.x)}%`,
              top: `${my(w.rect.y)}%`,
              width: `${(w.rect.w / region.w) * 100}%`,
              height: `${(w.rect.h / region.h) * 100}%`,
            }}
          />
        ))}
        <div
          className="border-primary bg-primary/10 pointer-events-none absolute border"
          style={{
            left: `${mx(v.x)}%`,
            top: `${my(v.y)}%`,
            width: `${(v.w / region.w) * 100}%`,
            height: `${(v.h / region.h) * 100}%`,
          }}
        />
      </span>
    </div>
  );
}

/**
 * One segment of the canvas toolbar's pill. Chrome copied verbatim from the
 * status bar's `ZoomControl` so the canvas zoom reads as the same KIND of
 * control the app already has, rather than a lookalike with its own spacing.
 * It takes a callback instead of a command id because these act on one canvas,
 * not on the app.
 */
function PillSeg({
  label,
  disabled = false,
  className,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <IconTooltip label={label} side="bottom">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn(
          "hover:bg-accent hover:text-accent-foreground flex h-full cursor-pointer items-center justify-center transition-colors first:rounded-l-md last:rounded-r-md disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent",
          className,
        )}
      >
        {children}
      </button>
    </IconTooltip>
  );
}

/** The pill shell. Same height, border, type scale and radius as the status
 *  bar's, so the two sit in the same visual family. */
const PILL =
  "border-border/60 bg-card text-muted-foreground flex h-6 shrink-0 items-center rounded-md border text-[11px] font-medium";

/** A zoom step button in a window header. `stopPropagation` on pointerdown so a
 *  click cannot start the header's drag gesture. */
function ZoomBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <IconTooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        onPointerDown={(e) => e.stopPropagation()}
        className="text-muted-foreground/70 hover:bg-muted hover:text-foreground flex size-4 shrink-0 items-center justify-center rounded disabled:pointer-events-none disabled:opacity-30"
      >
        {children}
      </button>
    </IconTooltip>
  );
}

function CanvasWindow({
  node,
  rect,
  onScreen,
  boxRef,
  focused,
  b,
  mdPreview,
  onFocus,
  onClose,
  onCommit,
  viewZoom,
  autoPanBy,
}: {
  node: PaneLeaf;
  rect: CanvasRect;
  boxRef: React.RefObject<HTMLDivElement | null>;
  focused: boolean;
  b: LeafBundle;
  mdPreview: boolean;
  onFocus: () => void;
  onClose?: () => void;
  onCommit: (patch: Partial<CanvasRect>) => void;
  /** Near enough the viewport to stay live. One that is not keeps its session
   *  but stops painting, which is what frees its WebGL context. */
  onScreen: boolean;
  /** Pan the canvas one step while this window is dragged against the edge.
   *  Answers with how far the canvas moved under the pointer, so the drag can
   *  keep the window there. */
  autoPanBy: (gx: number, gy: number) => { dx: number; dy: number };
  /** Canvas viewport scale. A pointer crossing N px of a layer scaled by `z`
   *  covers N/z of that layer's own coordinate space, so every drag and resize
   *  delta divides by it - without this, moving a window while zoomed out
   *  overshoots by exactly the zoom factor. */
  viewZoom: number;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  // LeafBody registers the editor handle here; only the float path reads it,
  // and a canvas window does not float, so it is write-only.
  const editorHandleRef = useRef<Parameters<LeafBundle["setEditorRef"]>[0]>(null);
  const { sshHosts, sshStatuses, aiCliStatuses, aiTitles, aiStates, onRenameLeaf } =
    use(PaneMetaContext);
  const remoteSession = useRemoteEditorBinding(node);
  // Live geometry while a gesture is running, so the frame follows the pointer
  // without a state write per frame (which would re-fit every xterm on the
  // canvas 60 times a second). Committed once on pointerup.
  const [dragging, setDragging] = useState(false);
  // Header title swapped for an edit field. Local: nothing outside this window
  // cares that it is being renamed, and the name itself lives on the leaf.
  const [renaming, setRenaming] = useState(false);

  const isSsh = node.leafKind === "terminal" && !!node.sshConnectionId;
  const label = leafLabel(node, sshHosts, undefined, aiTitles);
  const zoom = rect.zoom ?? 1;
  // A WebGL terminal canvas scales through xterm's font size (`paneZoom`)
  // rather than CSS; every other leaf is DOM and takes the transform.
  const zoomable = true;
  const cssZoom = node.leafKind !== "terminal" ? zoom : 1;

  /**
   * One zoom step, shared by the buttons and the wheel so the clamp and the
   * rounding cannot drift between them.
   *
   * Steps off a ref rather than the prop: a trackpad pinch fires several wheel
   * events, and two fast clicks land, inside ONE React batch, where the prop is
   * still the pre-step value - so every event in the burst would compute the
   * same target and only one step would stick.
   */
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const stepZoom = (dir: 1 | -1) => {
    const cur = zoomRef.current;
    const next = clamp(Math.round((cur + dir * ZOOM_STEP) * 100) / 100, ZOOM_MIN, ZOOM_MAX);
    if (next === cur) return;
    zoomRef.current = next;
    onCommit({ zoom: next });
  };

  /** Ctrl/Cmd + wheel over the window, the gesture every app uses for zoom.
   *  Capture phase so it wins before CodeMirror's own wheel handler, and it
   *  swallows the event so the webview never browser-zooms the whole app. */
  const onZoomWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    e.stopPropagation();
    // Swallowed even on a pane that cannot zoom (a browser window's chrome), so
    // the gesture never falls through to the webview and zooms the whole app.
    if (zoomable) stepZoom(e.deltaY > 0 ? -1 : 1);
  };

  const startGesture = (e: PointerEvent<HTMLElement>, handle: Handle) => {
    const box = boxRef.current;
    const el = elRef.current;
    if (!box || !el || e.button !== 0) return;
    e.preventDefault();
    onFocus();
    const b0 = box.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const minW = minPct(b0.width);
    const minH = minPct(b0.height);
    const north = handle.includes("n");
    const south = handle.includes("s");
    const west = handle.includes("w");
    const east = handle.includes("e");
    let latest = rect;
    let moved = false;
    // Keeps the gesture alive when the pointer crosses an xterm canvas or leaves
    // the frame. Optional, not load-bearing: the listeners below are on `window`,
    // which a captured event still bubbles to, so a synthetic pointer (which has
    // no active id and makes this throw) drags exactly the same.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // no active pointer to capture
    }
    // Same latch the split-pane drag uses, so a gesture that starts here
    // cannot be stolen mid-drag.
    setDragging(true);

    // Latest pointer, plus how far the auto-pan below has slid the canvas under
    // it (canvas units). `place` is split out of `onMove` because the auto-pan
    // loop has to re-place the window on frames where the pointer never moved.
    let px = startX;
    let py = startY;
    let panDx = 0;
    let panDy = 0;

    const place = () => {
      const dx = ((px - startX) / (b0.width * viewZoom)) * 100 + panDx;
      const dy = ((py - startY) / (b0.height * viewZoom)) * 100 + panDy;
      if (dx !== 0 || dy !== 0) moved = true;
      if (handle === "move") {
        latest = insideCanvas({ ...rect, x: rect.x + dx, y: rect.y + dy });
      } else {
        // A west/north drag moves the origin AND changes the size, so the
        // opposite edge stays put; the only limit left is the minimum size,
        // measured from that edge.
        const next = { ...rect };
        if (west) {
          next.x = Math.min(rect.x + dx, rect.x + rect.w - minW);
          next.w = rect.x + rect.w - next.x;
        }
        if (east) next.w = Math.max(rect.w + dx, minW);
        if (north) {
          next.y = Math.min(rect.y + dy, rect.y + rect.h - minH);
          next.h = rect.y + rect.h - next.y;
        }
        if (south) next.h = Math.max(rect.h + dy, minH);
        latest = insideCanvas(next);
      }
      el.style.left = `${latest.x}%`;
      el.style.top = `${latest.y}%`;
      el.style.width = `${latest.w}%`;
      el.style.height = `${latest.h}%`;
    };

    const onMove = (ev: globalThis.PointerEvent) => {
      px = ev.clientX;
      py = ev.clientY;
      place();
    };

    /**
     * Carry a window off the edge of the screen: while the pointer sits in the
     * band along any edge, the canvas pans that way and the window rides along,
     * staying under the pointer. Without it, putting a pane somewhere far away
     * was drop, pan, pick up, drop again.
     *
     * A rAF loop, not a pointermove handler: holding the pointer still against
     * the edge must keep panning, and that fires no events. Moving only - a
     * resize has a fixed opposite edge, so panning under it would fight the
     * gesture.
     */
    const push = (pos: number, lo: number, hi: number) => {
      if (pos < lo + EDGE_BAND_PX) return -Math.min(1, (lo + EDGE_BAND_PX - pos) / EDGE_BAND_PX);
      if (pos > hi - EDGE_BAND_PX) return Math.min(1, (pos - (hi - EDGE_BAND_PX)) / EDGE_BAND_PX);
      return 0;
    };
    let raf = 0;
    const edgePan = () => {
      raf = requestAnimationFrame(edgePan);
      const gx = push(px, b0.left, b0.right);
      const gy = push(py, b0.top, b0.bottom);
      if (gx === 0 && gy === 0) return;
      const d = autoPanBy(gx, gy);
      if (d.dx === 0 && d.dy === 0) return;
      panDx += d.dx;
      panDy += d.dy;
      moved = true;
      place();
    };
    if (handle === "move") raf = requestAnimationFrame(edgePan);

    const end = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (raf) cancelAnimationFrame(raf);
      setDragging(false);
      // A plain click on the header is a focus, not a move: committing it would
      // rewrite the tab (and re-snapshot the workspace) for nothing. Only the
      // two fields this gesture touched go back, so the raise it started with
      // survives.
      if (moved) {
        onCommit(
          handle === "move"
            ? { x: latest.x, y: latest.y }
            : { x: latest.x, y: latest.y, w: latest.w, h: latest.h },
        );
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  return (
    <div
      ref={elRef}
      data-pane-leaf={node.id}
      data-pane-private={node.private ? "" : undefined}
      style={{
        left: `${rect.x}%`,
        top: `${rect.y}%`,
        width: `${rect.w}%`,
        height: `${rect.h}%`,
        // Pinned windows share the ordinary `z` sequence, just lifted above
        // every unpinned one, so they still stack among themselves by the same
        // click-to-front rule. The layer above has a `transform`, so this whole
        // range is confined to its stacking context and can never climb over
        // the toolbar or the minimap.
        zIndex: (rect.pin ? PINNED_Z : 0) + rect.z,
      }}
      onMouseDownCapture={onFocus}
      onWheelCapture={onZoomWheel}
      className={cn(
        "bg-background absolute flex cursor-auto flex-col overflow-hidden rounded-md border shadow-lg",
        focused ? "border-primary/60 ring-primary/30 ring-1" : "border-border",
      )}
    >
      <ContextMenu modal={false}>
        <ContextMenuTrigger asChild>
          <div
            onPointerDown={(e) => startGesture(e, "move")}
            className="border-border/60 bg-card group/head flex h-7 shrink-0 cursor-grab items-center gap-1.5 border-b px-2 select-none active:cursor-grabbing"
          >
            {rect.pin ? (
              <Pin
                aria-label="Pinned on top"
                strokeWidth={2.25}
                className="text-muted-foreground/70 size-3 shrink-0"
              />
            ) : null}
            <LeafIcon
              info={leafIconInfo(node, aiCliStatuses, aiStates)}
              size={13}
              className="text-muted-foreground/80"
            />
            {renaming ? (
              // `stopPropagation` on pointerdown so a drag inside the field
              // cannot start the header's move gesture, and `select-text` to
              // undo the header's `select-none` (which would otherwise stop the
              // caret selecting anything). Same `InlineInput` the tab strip and
              // the explorer rename with, so all three commit identically.
              <span
                className="flex min-w-0 flex-1 select-text"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <InlineInput
                  initial={leafRenameSeed(node, sshHosts, undefined, aiTitles)}
                  placeholder="Pane name"
                  onCommit={(value) => {
                    setRenaming(false);
                    // Blank means "back to the derived name", not a nameless pane.
                    onRenameLeaf?.(node.id, value.trim() ? value : null);
                  }}
                  onCancel={() => setRenaming(false)}
                />
              </span>
            ) : (
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-xs",
                  "text-muted-foreground",
                  node.leafKind === "editor" && node.preview && "italic",
                  isSsh && statusLabelClass(sshStatuses?.get(node.id)),
                  node.leafKind === "extension-panel" && extensionStateLabelClass(node.state),
                  node.private === true && "text-destructive",
                )}
              >
                {label}
              </span>
            )}
            {node.leafKind === "editor" && node.dirty ? (
              <span className="bg-foreground/60 size-1.5 shrink-0 rounded-full" />
            ) : null}
            {zoomable ? (
              <span
                className={cn(
                  "flex shrink-0 items-center transition-opacity",
                  // At 100% the cluster is hover-only, so a tidy canvas shows nothing
                  // but names. Once zoomed it stays put: the percentage is state the
                  // user needs to see without hunting for it.
                  zoom === 1 && "opacity-0 group-hover/head:opacity-100",
                )}
              >
                <ZoomBtn label="Zoom out" disabled={zoom <= ZOOM_MIN} onClick={() => stepZoom(-1)}>
                  <Minus size={11} strokeWidth={2.25} />
                </ZoomBtn>
                <IconTooltip label="Reset zoom (Ctrl + wheel)" side="bottom">
                  <button
                    type="button"
                    aria-label={`Pane zoom ${Math.round(zoom * 100)}%, click to reset`}
                    onClick={() => onCommit({ zoom: 1 })}
                    onPointerDown={(e) => e.stopPropagation()}
                    className="text-muted-foreground hover:text-foreground w-8 shrink-0 text-center font-mono text-[10px] leading-4 tabular-nums"
                  >
                    {Math.round(zoom * 100)}%
                  </button>
                </IconTooltip>
                <ZoomBtn label="Zoom in" disabled={zoom >= ZOOM_MAX} onClick={() => stepZoom(1)}>
                  <Plus size={11} strokeWidth={2.25} />
                </ZoomBtn>
              </span>
            ) : null}
            {onClose ? (
              <IconTooltip label="Close" side="bottom">
                <button
                  type="button"
                  aria-label="Close window"
                  onClick={onClose}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="text-muted-foreground/70 hover:bg-destructive/15 hover:text-destructive flex size-5 shrink-0 items-center justify-center rounded"
                >
                  <X size={13} strokeWidth={2} />
                </button>
              </IconTooltip>
            ) : null}
          </div>
        </ContextMenuTrigger>
        {/* Same order and wording as the tab strip's own right-click menu
            (`renderEntryBody`), so a pane offers the same actions in the same
            places whichever view you are in. */}
        <ContextMenuContent className="min-w-44">
          <ContextMenuItem onSelect={() => setRenaming(true)}>Rename</ContextMenuItem>
          {/* Only once there is a name to drop, on the same condition the tab
              strip uses (`renamed`), so the two menus offer the same items. */}
          {node.customTitle !== undefined && (
            <ContextMenuItem onSelect={() => onRenameLeaf?.(node.id, null)}>
              Reset Name
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => onCommit({ pin: !rect.pin })}>
            {rect.pin ? "Unpin" : "Pin on Top"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <div
        className="relative min-h-0 flex-1"
        // CSS zoom scales the whole DOM body - editor, source control, board, an
        // extension panel - and is left at 1 for the two kinds it cannot reach.
        style={cssZoom === 1 ? undefined : { zoom: cssZoom }}
      >
        <ErrorBoundary label="canvas window" resetKeys={[node.id]}>
          <LeafBody
            node={node}
            tabVisible={onScreen}
            isFloating={false}
            editorHandleRef={editorHandleRef}
            focused={focused}
            b={b}
            mdPreview={mdPreview}
            remoteSession={remoteSession}
            paneZoom={node.leafKind === "terminal" ? zoom : undefined}
          />
        </ErrorBoundary>
        {/* Swallow pointer events over the body while resizing so the gesture
            can't be stolen by an xterm or CodeMirror underneath. */}
        {dragging ? <div className="absolute inset-0 z-10" /> : null}
      </div>

      {HANDLES.map(({ h, cls }) => (
        <div
          key={h}
          onPointerDown={(e) => startGesture(e, h)}
          aria-label={`Resize window ${h}`}
          className={cn("absolute z-20", cls)}
        />
      ))}
    </div>
  );
}
