import { createContext, Fragment, memo, use, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  Cancel01Icon,
  CloudServerIcon,
  ComputerTerminal02Icon,
  DragDropVerticalIcon,
  LockedIcon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { cn } from "@/lib/utils";
import { EditorPane, type EditorPaneHandle } from "@/modules/editor";
import { TerminalPane, type TerminalPaneHandle } from "@/modules/terminal";
import type { SearchAddon } from "@xterm/addon-search";
import type { PaneEdge, PaneLeaf, PaneNode } from "@/modules/terminal/lib/panes";
import { leaves } from "@/modules/terminal/lib/panes";
import type { TediOpenInput, TediSpawnTabInput } from "@/modules/terminal/lib/useTerminalSession";
import { statusLabelClass, type SshStatus } from "@/modules/ssh/status";
import type { SshConnection } from "@/modules/ssh/connections";
import { aiCliIconClass, type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";

export type LeafBundle = {
  // terminal-only
  setTerminalRef: (h: TerminalPaneHandle | null) => void;
  onSearchReady: (addon: SearchAddon) => void;
  onCwd: (cwd: string) => void;
  onDetectedLocalUrl: (url: string) => void;
  onExit: (code: number) => void;
  onTediOpen: (input: TediOpenInput) => void;
  onTediSpawnTab: (input: TediSpawnTabInput) => void;
  onSshStatus: (status: SshStatus) => void;
  onAiCliStatus: (status: AiCliStatus) => void;
  onPtyId: (ptyId: string) => void;
  // editor-only
  setEditorRef: (h: EditorPaneHandle | null) => void;
  onDirtyChange: (dirty: boolean) => void;
  onCloseLeaf: () => void;
};

type Props = {
  node: PaneNode;
  tabVisible: boolean;
  activeLeafId: number;
  onFocusLeaf: (leafId: number) => void;
  getBundle: (leafId: number) => LeafBundle;
  /** Editor leaf ids currently rendered in markdown preview. */
  mdPreviewLeafIds: ReadonlySet<number>;
  /** Drag-and-drop: drop `sourceLeafId` onto an `edge` of `targetLeafId`. */
  onMovePaneLeaf?: (sourceLeafId: number, targetLeafId: number, edge: PaneEdge) => void;
  /** Close button in a pane header. Hidden when omitted. */
  onCloseLeaf?: (leafId: number) => void;
  /** Saved SSH connections, keyed by id. Resolves a leaf's `ssh:<host>` label. */
  sshHosts?: Map<string, SshConnection>;
  /** Live SSH status per terminal leaf id. Colors the SSH header label. */
  sshStatuses?: Map<number, SshStatus>;
  /** Live AI CLI status per terminal leaf id. Tints the header icon (idle/working/blocking). */
  aiCliStatuses?: Map<number, AiCliStatus>;
};

type PaneDragState = {
  sourceLeafId: number | null;
  overLeafId: number | null;
  edge: PaneEdge | null;
};

type PaneDndValue = {
  drag: PaneDragState;
  leafCount: number;
  onCloseLeaf?: (leafId: number) => void;
};

const PaneDndContext = createContext<PaneDndValue>({
  drag: { sourceLeafId: null, overLeafId: null, edge: null },
  leafCount: 1,
});

type PaneMetaValue = {
  sshHosts?: Map<string, SshConnection>;
  sshStatuses?: Map<number, SshStatus>;
  aiCliStatuses?: Map<number, AiCliStatus>;
};

// SSH host/status lives in its own context so status pushes re-render only the
// leaf headers (not the memoized split tree or xterm/CodeMirror bodies).
const PaneMetaContext = createContext<PaneMetaValue>({});

const DRAG_PREFIX = "pane-drag:";
const DROP_PREFIX = "pane-drop:";

function parsePaneId(id: string | number, prefix: string): number | null {
  const s = String(id);
  if (!s.startsWith(prefix)) return null;
  const n = Number(s.slice(prefix.length));
  return Number.isFinite(n) ? n : null;
}

/** Diagonal-quadrant hit test: which edge of `rect` the pointer is closest to. */
function computeEdge(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): PaneEdge {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const nx = rect.width ? (x - cx) / (rect.width / 2) : 0;
  const ny = rect.height ? (y - cy) / (rect.height / 2) : 0;
  if (Math.abs(nx) >= Math.abs(ny)) return nx < 0 ? "left" : "right";
  return ny < 0 ? "top" : "bottom";
}

function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function leafLabel(node: PaneLeaf, sshHosts?: Map<string, SshConnection>): string {
  if (node.leafKind === "editor") return baseName(node.path);
  // SSH terminal: mirror the tab strip's `ssh:<host>` (bare "ssh" if the
  // connection was deleted), so tab and pane read identically.
  if (node.sshConnectionId) {
    const host = sshHosts?.get(node.sshConnectionId);
    return host ? `ssh:${host.host}` : "ssh";
  }
  return node.cwd ? baseName(node.cwd) : "shell";
}

/** Heavy leaf content. Memoized so pointer-move re-renders during a drag don't churn xterm/CodeMirror. */
const LeafBody = memo(function LeafBody({
  node,
  tabVisible,
  focused,
  b,
  mdPreview,
}: {
  node: PaneLeaf;
  tabVisible: boolean;
  focused: boolean;
  b: LeafBundle;
  mdPreview: boolean;
}) {
  if (node.leafKind === "terminal") {
    return (
      <ErrorBoundary label="terminal pane" resetKeys={[node.id]}>
        <div className="h-full w-full p-1.5">
          <TerminalPane
            leafId={node.id}
            visible={tabVisible}
            focused={focused}
            initialCwd={node.cwd}
            sshConnectionId={node.sshConnectionId}
            savedPtyId={node.savedPtyId}
            ref={b.setTerminalRef}
            onSearchReady={(_id, addon) => b.onSearchReady(addon)}
            onCwd={(_id, cwd) => b.onCwd(cwd)}
            onDetectedLocalUrl={(_id, url) => b.onDetectedLocalUrl(url)}
            onExit={(_id, code) => b.onExit(code)}
            onTediOpen={(_id, input) => b.onTediOpen(input)}
            onTediSpawnTab={(_id, input) => b.onTediSpawnTab(input)}
            onSshStatus={(_id, status) => b.onSshStatus(status)}
            onAiCliStatus={(_id, status) => b.onAiCliStatus(status)}
            onPtyId={(_id, ptyId) => b.onPtyId(ptyId)}
          />
        </div>
      </ErrorBoundary>
    );
  }
  return (
    <ErrorBoundary label="editor pane" resetKeys={[node.id, node.path]}>
      <EditorPane
        ref={b.setEditorRef}
        path={node.path}
        onDirtyChange={b.onDirtyChange}
        onClose={b.onCloseLeaf}
        mdPreview={mdPreview}
        sshSessionId={node.sshSessionId}
        aiDisabled={node.private === true}
      />
    </ErrorBoundary>
  );
});

function DropIndicator({ edge }: { edge: PaneEdge }) {
  const pos =
    edge === "left"
      ? "inset-y-0 left-0 w-1/2"
      : edge === "right"
        ? "inset-y-0 right-0 w-1/2"
        : edge === "top"
          ? "inset-x-0 top-0 h-1/2"
          : "inset-x-0 bottom-0 h-1/2";
  return (
    <div
      className={cn(
        "border-primary/70 bg-primary/20 pointer-events-none absolute z-20 rounded-md border-2",
        pos,
      )}
    />
  );
}

function PaneLeafFrame({
  node,
  tabVisible,
  focused,
  b,
  mdPreview,
  onFocusLeaf,
}: {
  node: PaneLeaf;
  tabVisible: boolean;
  focused: boolean;
  b: LeafBundle;
  mdPreview: boolean;
  onFocusLeaf: (leafId: number) => void;
}) {
  const { drag, leafCount, onCloseLeaf } = use(PaneDndContext);
  const { sshHosts, sshStatuses, aiCliStatuses } = use(PaneMetaContext);
  const draggable = leafCount > 1;
  const {
    listeners,
    attributes,
    setNodeRef: setDragRef,
  } = useDraggable({
    id: `${DRAG_PREFIX}${node.id}`,
    disabled: !draggable,
  });
  const { setNodeRef: setDropRef } = useDroppable({ id: `${DROP_PREFIX}${node.id}` });

  const isSource = drag.sourceLeafId === node.id;
  const isOver = drag.overLeafId === node.id && drag.sourceLeafId !== node.id && drag.edge !== null;
  const isPrivate = node.private === true;
  const isSsh = node.leafKind === "terminal" && !!node.sshConnectionId;
  const sshStatus = isSsh ? sshStatuses?.get(node.id) : undefined;
  const aiCli = node.leafKind === "terminal" ? aiCliStatuses?.get(node.id) : undefined;
  // Icon shape precedence mirrors the tab strip: private (lock) > SSH (cloud) > kind.
  const Icon = isPrivate
    ? LockedIcon
    : isSsh
      ? CloudServerIcon
      : node.leafKind === "terminal"
        ? ComputerTerminal02Icon
        : PencilEdit02Icon;
  // Icon colour carries AI CLI state (idle/working/blocking, working+blocking
  // pulse) for every leaf including private. Private's red lives on the label,
  // so the lock colour stays free to show AI status (no ambiguity).
  const iconClass = aiCli ? aiCliIconClass(aiCli) : "text-muted-foreground/80";

  return (
    <div
      ref={setDropRef}
      onMouseDownCapture={() => {
        if (!focused) onFocusLeaf(node.id);
      }}
      onFocus={() => {
        if (!focused) onFocusLeaf(node.id);
      }}
      data-pane-leaf={node.id}
      className={cn(
        "bg-background relative flex h-full w-full flex-col overflow-hidden rounded-md border shadow-sm transition-colors",
        focused ? "border-primary/60 ring-primary/30 ring-1" : "border-border",
        isSource && "opacity-60",
      )}
    >
      {/* Per-pane navigation header: drag handle + label + close. */}
      <div className="border-border/60 bg-muted/40 flex h-7 shrink-0 items-center gap-1 border-b px-1 select-none">
        <button
          type="button"
          ref={setDragRef}
          {...listeners}
          {...attributes}
          disabled={!draggable}
          aria-label="Drag to move pane"
          title={draggable ? "Drag to move pane" : undefined}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded transition-colors",
            draggable
              ? "text-muted-foreground/70 hover:bg-muted hover:text-foreground cursor-grab active:cursor-grabbing"
              : "text-muted-foreground/40 cursor-default",
          )}
        >
          <HugeiconsIcon icon={DragDropVerticalIcon} size={14} strokeWidth={2} />
        </button>
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={2}
          className={cn("shrink-0", iconClass)}
        />
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            "text-muted-foreground",
            node.leafKind === "editor" && node.preview && "italic",
            // SSH status colors the label, matching the tab strip.
            isSsh && statusLabelClass(sshStatus),
            // Private signal lives on the label (red), not the icon. Last = wins.
            isPrivate && "text-destructive",
          )}
        >
          {leafLabel(node, sshHosts)}
        </span>
        {node.leafKind === "editor" && node.dirty && (
          <span className="bg-icon-working size-1.5 shrink-0 rounded-full" />
        )}
        {onCloseLeaf && (
          <button
            type="button"
            aria-label="Close pane"
            title="Close pane"
            onClick={(e) => {
              e.stopPropagation();
              onCloseLeaf(node.id);
            }}
            className="text-muted-foreground/70 hover:bg-muted hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded transition-colors"
          >
            <HugeiconsIcon icon={Cancel01Icon} size={13} strokeWidth={2} />
          </button>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        <LeafBody
          node={node}
          tabVisible={tabVisible}
          focused={focused}
          b={b}
          mdPreview={mdPreview}
        />
      </div>
      {isOver && drag.edge && <DropIndicator edge={drag.edge} />}
    </div>
  );
}

type NodesProps = {
  node: PaneNode;
  tabVisible: boolean;
  activeLeafId: number;
  onFocusLeaf: (leafId: number) => void;
  getBundle: (leafId: number) => LeafBundle;
  mdPreviewLeafIds: ReadonlySet<number>;
};

const PaneNodes = memo(function PaneNodes({
  node,
  tabVisible,
  activeLeafId,
  onFocusLeaf,
  getBundle,
  mdPreviewLeafIds,
}: NodesProps) {
  if (node.kind === "leaf") {
    return (
      <PaneLeafFrame
        node={node}
        tabVisible={tabVisible}
        focused={node.id === activeLeafId}
        b={getBundle(node.id)}
        mdPreview={mdPreviewLeafIds.has(node.id)}
        onFocusLeaf={onFocusLeaf}
      />
    );
  }

  return (
    <ResizablePanelGroup
      orientation={node.dir === "row" ? "horizontal" : "vertical"}
      className="gap-1.5"
    >
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          {i > 0 && (
            <ResizableHandle
              withHandle
              className="bg-border/50 hover:bg-primary/50 transition-colors"
            />
          )}
          <ResizablePanel id={`pane-${child.id}`} minSize="10%">
            <PaneNodes
              node={child}
              tabVisible={tabVisible}
              activeLeafId={activeLeafId}
              onFocusLeaf={onFocusLeaf}
              getBundle={getBundle}
              mdPreviewLeafIds={mdPreviewLeafIds}
            />
          </ResizablePanel>
        </Fragment>
      ))}
    </ResizablePanelGroup>
  );
});

export function PaneTreeView({
  node,
  tabVisible,
  activeLeafId,
  onFocusLeaf,
  getBundle,
  mdPreviewLeafIds,
  onMovePaneLeaf,
  onCloseLeaf,
  sshHosts,
  sshStatuses,
  aiCliStatuses,
}: Props) {
  const leafList = useMemo(() => leaves(node), [node]);
  const leafCount = leafList.length;

  const [drag, setDrag] = useState<PaneDragState>({
    sourceLeafId: null,
    overLeafId: null,
    edge: null,
  });
  // Latest resolved drop target. Kept in a ref so `onDragEnd` reads it without
  // closing over stale `drag` state.
  const latestRef = useRef<{ over: number | null; edge: PaneEdge | null }>({
    over: null,
    edge: null,
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const clearOver = () => {
    if (latestRef.current.over === null && latestRef.current.edge === null) return;
    latestRef.current = { over: null, edge: null };
    setDrag((d) => ({ ...d, overLeafId: null, edge: null }));
  };

  const reset = () => {
    latestRef.current = { over: null, edge: null };
    setDrag({ sourceLeafId: null, overLeafId: null, edge: null });
  };

  const handleDragStart = (ev: DragStartEvent) => {
    latestRef.current = { over: null, edge: null };
    setDrag({ sourceLeafId: parsePaneId(ev.active.id, DRAG_PREFIX), overLeafId: null, edge: null });
  };

  const handleDragMove = (ev: DragMoveEvent) => {
    const sourceId = parsePaneId(ev.active.id, DRAG_PREFIX);
    if (!ev.over) {
      clearOver();
      return;
    }
    const overId = parsePaneId(ev.over.id, DROP_PREFIX);
    if (overId === null || overId === sourceId) {
      clearOver();
      return;
    }
    const ae = ev.activatorEvent as PointerEvent;
    const x = ae.clientX + ev.delta.x;
    const y = ae.clientY + ev.delta.y;
    const edge = computeEdge(ev.over.rect, x, y);
    if (latestRef.current.over === overId && latestRef.current.edge === edge) return;
    latestRef.current = { over: overId, edge };
    setDrag((d) => ({ ...d, overLeafId: overId, edge }));
  };

  const handleDragEnd = (ev: DragEndEvent) => {
    const sourceId = parsePaneId(ev.active.id, DRAG_PREFIX);
    const { over, edge } = latestRef.current;
    reset();
    if (sourceId !== null && over !== null && edge !== null && over !== sourceId) {
      onMovePaneLeaf?.(sourceId, over, edge);
    }
  };

  const ctxValue = useMemo<PaneDndValue>(
    () => ({ drag, leafCount, onCloseLeaf }),
    [drag, leafCount, onCloseLeaf],
  );
  const metaValue = useMemo<PaneMetaValue>(
    () => ({ sshHosts, sshStatuses, aiCliStatuses }),
    [sshHosts, sshStatuses, aiCliStatuses],
  );

  const draggedLeaf =
    drag.sourceLeafId !== null ? (leafList.find((l) => l.id === drag.sourceLeafId) ?? null) : null;
  const draggedIsSsh = draggedLeaf?.leafKind === "terminal" && !!draggedLeaf.sshConnectionId;
  const draggedIcon =
    draggedLeaf?.private === true
      ? LockedIcon
      : draggedIsSsh
        ? CloudServerIcon
        : draggedLeaf?.leafKind === "terminal"
          ? ComputerTerminal02Icon
          : PencilEdit02Icon;
  const draggedAiCli =
    draggedLeaf?.leafKind === "terminal" ? aiCliStatuses?.get(draggedLeaf.id) : undefined;
  // Icon colour follows AI status (even when private); private's red is on the label.
  const draggedIconClass = draggedAiCli ? aiCliIconClass(draggedAiCli) : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={reset}
    >
      <PaneMetaContext.Provider value={metaValue}>
        <PaneDndContext.Provider value={ctxValue}>
          <PaneNodes
            node={node}
            tabVisible={tabVisible}
            activeLeafId={activeLeafId}
            onFocusLeaf={onFocusLeaf}
            getBundle={getBundle}
            mdPreviewLeafIds={mdPreviewLeafIds}
          />
        </PaneDndContext.Provider>
      </PaneMetaContext.Provider>
      <DragOverlay dropAnimation={null}>
        {draggedLeaf && (
          <div className="bg-accent/95 text-accent-foreground ring-primary/50 flex h-7 max-w-72 cursor-grabbing items-center gap-1.5 rounded-md px-2 text-xs shadow-lg ring-1 backdrop-blur-sm">
            <HugeiconsIcon
              icon={draggedIcon}
              size={13}
              strokeWidth={2}
              className={draggedIconClass}
            />
            <span className={cn("truncate", draggedLeaf.private === true && "text-destructive")}>
              {leafLabel(draggedLeaf, sshHosts)}
            </span>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
