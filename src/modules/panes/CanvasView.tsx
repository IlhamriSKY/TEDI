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
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LeafIcon } from "@/components/LeafIcon";
import { resolveExtIcon } from "@/lib/iconRegistry";
import { cn } from "@/lib/utils";
import { setPaneDragActive } from "@/modules/browser";
import { panelsRegistry, useRegistry } from "@/modules/extensions";
import { AiChatMenuItems } from "@/modules/ai/components/AiChatMenuItems";
import { statusLabelClass } from "@/modules/ssh/status";
import { extensionStateLabelClass } from "@/modules/tabs/lib/entries";
import { leafLabel } from "@/modules/tabs/lib/tabHelpers";
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

/**
 * Canvas viewport bounds. Zooming OUT below 1 is the point of it: the window
 * layer is box-sized, so at 0.4 the whole 0..100 coordinate space occupies less
 * than half the screen and a dozen panes fit at once; above 1 you work close in
 * and pan around.
 */
const VIEW_MIN = 0.25;
const VIEW_MAX = 2;
const VIEW_STEP = 0.15;

/** Per-pane zoom bounds and step. Same 0.1 step the app-wide content zoom uses,
 *  so a canvas pane and the status-bar control move in the same increments. */
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;

/**
 * Geometry for a window that has none yet, cascaded from the top left so a run
 * of fresh windows is reachable rather than one stack. Seeded on first render,
 * which is what lets a pane arrive from ANY path - the canvas `+`, a split, a
 * tab opened while in tabs view, a workspace saved before canvas existed -
 * without a single opener having to know about geometry.
 */
function defaultCanvasRect(index: number, z: number): CanvasRect {
  const step = index % 6;
  return { x: 3 + step * 5, y: 4 + step * 6, w: 46, h: 48, z };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

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
      patch[leaf.id] = defaultCanvasRect(seeded + i, ++z);
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

  /** Everything placed. On an UNBOUNDED canvas this is the only frame there is,
   *  so it answers "how far can I pan" and "what does Fit mean". */
  const bounds = useMemo(
    () => contentBounds(list.flatMap(({ leaf }) => (leaf.canvasRect ? [leaf.canvasRect] : []))),
    [list],
  );

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
    if (!box || e.button !== 0 || e.target !== e.currentTarget) return;
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
      setPaneDragActive(false);
    };
    setPaneDragActive(true);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
  };

  // A preview pane is a NATIVE webview: it is positioned from
  // `getBoundingClientRect` so it follows the transform, but its page does not
  // scale with it and would show a cropped corner. Hide it while zoomed rather
  // than draw a lie; it comes back at 100%.
  useEffect(() => {
    setPaneDragActive(view.zoom !== 1);
    // The latch is APP-WIDE and shared with the split-pane drag, so leaving the
    // canvas while zoomed would hide every preview webview everywhere, with
    // nothing left mounted to turn it back on.
    return () => setPaneDragActive(false);
  }, [view.zoom]);

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
      <DropdownMenuItem onSelect={add.browser}>
        <Globe size={14} strokeWidth={1.75} />
        <span className="flex-1">Browser</span>
      </DropdownMenuItem>
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

  /** Where a right-click asked for the menu, in box pixels, or null. Radix
   *  needs an anchor in the DOM, so an empty span is parked there and the
   *  menu is opened against it. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);

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
          // Faint dot grid, the usual "this is a canvas you arrange things on"
          // cue. One CSS gradient, no image and no element: `--border` is the
          // theme's own hairline colour, so it follows every preset and both
          // light and dark without a second token. The dots stay put while the
          // layer inside moves, which is what reads as a fixed surface.
          className="bg-sidebar/40 border-border/60 relative min-h-0 flex-1 overflow-hidden rounded-md border bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] bg-[length:16px_16px]"
        >
          {/* The window layer. Box-sized and transformed as a whole, so window
              rectangles stay in one 0..100 space no matter where the viewport
              is - the minimap and the drag math both read that space directly.
              `origin-top-left` is what makes `pan + p * zoom` the whole mapping.
              A terminal inside is RASTER-scaled at zoom != 1 (soft, but exactly
              placed): xterm measures its own layout, which a transform leaves
              alone, unlike CSS `zoom`. */}
          <div
            onPointerDown={startPan}
            // Only the background: a right-click ON a window is that window's
            // business, and the same test `startPan` uses keeps the two gestures
            // agreeing about what "empty canvas" means.
            onContextMenu={(e) => {
              if (e.target !== e.currentTarget) return;
              const r = boxRef.current?.getBoundingClientRect();
              if (!r) return;
              e.preventDefault();
              setMenuAt({ x: e.clientX - r.left, y: e.clientY - r.top });
            }}
            className={cn(
              "absolute inset-0 origin-top-left",
              view.zoom !== 1 || view.x !== 0 || view.y !== 0 ? "cursor-grab" : null,
            )}
            style={{ transform: `translate(${view.x}%, ${view.y}%) scale(${view.zoom})` }}
          >
            {list.map(({ leaf, tabId }, i) => {
              const rect = leaf.canvasRect ?? defaultCanvasRect(i, i + 1);
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
                />
              );
            })}
          </div>
          {/* Anchored to the pointer. The span lives in the BOX, not the
              transformed layer, so the menu opens where the cursor actually is
              rather than where the layer's scaled coordinates would put it. */}
          <DropdownMenu
            open={menuAt !== null}
            onOpenChange={(open) => {
              if (!open) setMenuAt(null);
            }}
          >
            <DropdownMenuTrigger asChild>
              <span
                aria-hidden
                className="pointer-events-none absolute size-0"
                style={{ left: menuAt?.x ?? 0, top: menuAt?.y ?? 0 }}
              />
            </DropdownMenuTrigger>
            {addMenu}
          </DropdownMenu>
          <Minimap
            windows={list.map(({ leaf }, i) => ({
              id: leaf.id,
              rect: leaf.canvasRect ?? defaultCanvasRect(i, i + 1),
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
  const { sshHosts, sshStatuses, aiCliStatuses, aiTitles, aiStates } = use(PaneMetaContext);
  const remoteSession = useRemoteEditorBinding(node);
  // Live geometry while a gesture is running, so the frame follows the pointer
  // without a state write per frame (which would re-fit every xterm on the
  // canvas 60 times a second). Committed once on pointerup.
  const [dragging, setDragging] = useState(false);

  const isSsh = node.leafKind === "terminal" && !!node.sshConnectionId;
  const label = leafLabel(node, sshHosts, undefined, aiTitles);
  const zoom = rect.zoom ?? 1;
  // A native webview composites ABOVE the DOM, so no CSS reaches it and it has
  // its own zoom buttons in the address bar; a WebGL terminal canvas scales
  // through xterm's font size instead (`paneZoom`). Everything else is DOM.
  const zoomable = node.leafKind !== "browser";
  const cssZoom = zoomable && node.leafKind !== "terminal" ? zoom : 1;

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
    // A preview pane's native webview composites ABOVE the DOM and would eat
    // the pointer mid-gesture. Same latch the split-pane drag uses.
    setPaneDragActive(true);
    setDragging(true);

    const onMove = (ev: globalThis.PointerEvent) => {
      const dx = ((ev.clientX - startX) / (b0.width * viewZoom)) * 100;
      const dy = ((ev.clientY - startY) / (b0.height * viewZoom)) * 100;
      if (dx !== 0 || dy !== 0) moved = true;
      if (handle === "move") {
        // No clamp: the canvas is unbounded, so a window may be dragged past
        // any edge and the viewport follows it.
        latest = { ...rect, x: rect.x + dx, y: rect.y + dy };
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
        latest = next;
      }
      el.style.left = `${latest.x}%`;
      el.style.top = `${latest.y}%`;
      el.style.width = `${latest.w}%`;
      el.style.height = `${latest.h}%`;
    };
    const end = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setPaneDragActive(false);
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
        zIndex: rect.z,
      }}
      onMouseDownCapture={onFocus}
      onWheelCapture={onZoomWheel}
      className={cn(
        "bg-background absolute flex flex-col overflow-hidden rounded-md border shadow-lg",
        focused ? "border-primary/60 ring-primary/30 ring-1" : "border-border",
      )}
    >
      <div
        onPointerDown={(e) => startGesture(e, "move")}
        className="border-border/60 bg-card group/head flex h-7 shrink-0 cursor-grab items-center gap-1.5 border-b px-2 select-none active:cursor-grabbing"
      >
        <LeafIcon
          info={leafIconInfo(node, aiCliStatuses, aiStates)}
          size={13}
          className="text-muted-foreground/80"
        />
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
            flush
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
