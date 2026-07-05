import {
  createContext,
  Fragment,
  memo,
  use,
  useCallback,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
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
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TERMINAL_PRESETS, type TerminalPalette } from "@/modules/settings/terminalPalette";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LeafIcon, type LeafIconInfo } from "@/components/LeafIcon";
import { cn } from "@/lib/utils";
import { EditorPane, type EditorPaneHandle } from "@/modules/editor";
import { useExplorerIconsReady } from "@/modules/explorer/lib/iconResolver";
import { BrowserPane, setPaneDragActive } from "@/modules/browser";
import { ExtensionPanelMount } from "@/modules/extensions/components/ExtensionPanelMount";
import { TerminalPane, type TerminalPaneHandle } from "@/modules/terminal";
import type { SearchAddon } from "@xterm/addon-search";
import type { PaneEdge, PaneLeaf, PaneNode, SplitDir } from "@/modules/terminal/lib/panes";
import { leaves } from "@/modules/terminal/lib/panes";
import type { TediOpenInput, TediSpawnTabInput } from "@/modules/terminal/lib/useTerminalSession";
import { statusLabelClass, type SshStatus } from "@/modules/ssh/status";
import { extensionStateLabelClass } from "@/modules/tabs/lib/entries";
import type { SshConnection } from "@/modules/ssh/connections";
import { type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import { useTerminalTitles } from "@/modules/terminal/lib/terminalTitles";
import { closeFloat, floatPane } from "./floatHost";
import { useFloatStore } from "./floatStore";
import type { FloatLeafParams } from "./floatProtocol";
import { GripVertical, SquareArrowOutUpRight, X } from "lucide-react";

/** Leaf kinds that can be floated into their own window. Terminals mirror live
 *  over Tauri events (the primary "watch an agent while working" case); an SSH
 *  pane is a terminal leaf so it floats through the same path. Editor float is a
 *  deliberate follow-up, not a bootstrap problem: EditorPane is self-contained
 *  (file IO by path, cross-window-safe) and FloatApp already renders it, but
 *  it hands off: the main pane unmounts its editor while floating (so two live
 *  CodeMirror views can't race and save-stomp the same file) and saves before
 *  float + on dock-back. Remote/SFTP editors depend on the main window's russh
 *  session, so those are gated out. Browser panes are native Tauri webview
 *  overlays that can't be mirrored at all. NOTE: float windows only run on a real
 *  Tauri build, so this path is build-green but needs a manual smoke test. */
function floatParamsFor(node: PaneLeaf, title: string): FloatLeafParams | null {
  if (node.leafKind === "terminal") return { leafId: node.id, kind: "terminal", title };
  if (node.leafKind === "editor" && node.sshSessionId === undefined)
    return {
      leafId: node.id,
      kind: "editor",
      title,
      path: node.path,
      privateLeaf: node.private === true,
    };
  return null;
}

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
  // preview-only
  onBrowserUrlChange: (url: string) => void;
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
  /** Open extension tabs offered in the per-pane "Split with…" header menu. */
  extTabs?: { id: number; title: string }[];
  /** Split this tab's pane (next to `leafId`, in `dir`) with an open extension
   *  tab, relocating it into the pane. */
  onSplitWithExtTab?: (extTabId: number, leafId: number, dir: SplitDir) => void;
  /** Set (or clear, with `null`) a terminal leaf's per-pane theme override.
   *  `themeId` is a `TERMINAL_PRESETS` id. Backs the header "Terminal theme" menu. */
  onSetTerminalTheme?: (leafId: number, themeId: string | null) => void;
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
  extTabs?: { id: number; title: string }[];
  onSplitWithExtTab?: (extTabId: number, leafId: number, dir: SplitDir) => void;
  onSetTerminalTheme?: (leafId: number, themeId: string | null) => void;
};

const PaneDndContext = createContext<PaneDndValue>({
  drag: { sourceLeafId: null, overLeafId: null, edge: null },
  leafCount: 1,
});

/** Radio value for "follow the global terminal theme" (clears the override). */
const FOLLOW_GLOBAL_THEME = "__follow_global__";

/** Compact palette chip for a terminal-theme menu row. */
function ThemeSwatch({ palette }: { palette: TerminalPalette }) {
  const dots = [palette.ansi.red, palette.ansi.green, palette.ansi.blue, palette.ansi.yellow];
  return (
    <span
      aria-hidden
      className="border-border/40 flex h-3.5 w-7 shrink-0 items-center gap-[2px] overflow-hidden rounded-[3px] border px-1"
      style={{ background: palette.background }}
    >
      {dots.map((c, i) => (
        <span key={i} className="size-1.5 rounded-full" style={{ background: c }} />
      ))}
    </span>
  );
}

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
  if (node.leafKind === "browser") {
    if (node.title) return node.title;
    try {
      return new URL(node.url).host || node.url || "browser";
    } catch {
      return node.url || "browser";
    }
  }
  if (node.leafKind === "extension-panel") return node.title || "panel";
  // SSH terminal: mirror the tab strip's `ssh:<host>` (bare "ssh" if the
  // connection was deleted), so tab and pane read identically.
  if (node.sshConnectionId) {
    const host = sshHosts?.get(node.sshConnectionId);
    return host ? `ssh:${host.host}` : "ssh";
  }
  return node.cwd ? baseName(node.cwd) : "shell";
}

/** Build the shared {@link LeafIconInfo} for a pane leaf so the header and the
 *  drag overlay render the exact icon the tab strip shows for the same leaf. */
function leafIconInfo(node: PaneLeaf, aiCliStatuses?: Map<number, AiCliStatus>): LeafIconInfo {
  return {
    leafKind: node.leafKind,
    isPrivate: node.private === true,
    isSsh: node.leafKind === "terminal" && !!node.sshConnectionId,
    editorFileName: node.leafKind === "editor" ? baseName(node.path) : undefined,
    editorRemote: node.leafKind === "editor" && node.sshSessionId !== undefined,
    browserUrl: node.leafKind === "browser" ? node.url : undefined,
    aiCliStatus: node.leafKind === "terminal" ? (aiCliStatuses?.get(node.id) ?? null) : null,
  };
}

/** Heavy leaf content. Memoized so pointer-move re-renders during a drag don't churn xterm/CodeMirror. */
const LeafBody = memo(function LeafBody({
  node,
  tabVisible,
  isFloating,
  editorHandleRef,
  focused,
  b,
  mdPreview,
}: {
  node: PaneLeaf;
  tabVisible: boolean;
  /** True while this leaf is popped out into a float window. */
  isFloating: boolean;
  /** Captures the editor handle so the frame can save before floating. */
  editorHandleRef: RefObject<EditorPaneHandle | null>;
  focused: boolean;
  b: LeafBundle;
  mdPreview: boolean;
}) {
  // Register the editor handle both with the parent bundle (find/replace etc.)
  // and the frame's own ref (save-before-float). Stable so EditorPane doesn't
  // re-register each render.
  const setEditorRef = useCallback(
    (h: EditorPaneHandle | null) => {
      b.setEditorRef(h);
      editorHandleRef.current = h;
    },
    [b, editorHandleRef],
  );
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
            terminalThemeId={node.terminalThemeId}
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
  if (node.leafKind === "browser") {
    return (
      <ErrorBoundary label="browser pane" resetKeys={[node.id]}>
        <BrowserPane
          id={node.id}
          url={node.url}
          visible={tabVisible}
          onUrlChange={b.onBrowserUrlChange}
        />
      </ErrorBoundary>
    );
  }
  if (node.leafKind === "extension-panel") {
    return (
      <ErrorBoundary label="extension pane" resetKeys={[node.id]}>
        <ExtensionPanelMount extensionId={node.extensionId} panelId={node.panelId} surface="pane" />
      </ErrorBoundary>
    );
  }
  // Editor - while floating it's handed off to the float window; unmount here so
  // two live CodeMirror views can't race and save-stomp the same file (the parent
  // overlays a "floating" indicator in its place).
  if (isFloating) return null;
  return (
    <ErrorBoundary label="editor pane" resetKeys={[node.id, node.path]}>
      <EditorPane
        ref={setEditorRef}
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
  const { drag, leafCount, onCloseLeaf, extTabs, onSplitWithExtTab, onSetTerminalTheme } =
    use(PaneDndContext);
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

  // Re-render the header once the catppuccin file-icon set lands so editor
  // leaves swap from the pencil fallback to the real file-type glyph.
  useExplorerIconsReady();

  const isSource = drag.sourceLeafId === node.id;
  const isOver = drag.overLeafId === node.id && drag.sourceLeafId !== node.id && drag.edge !== null;
  const isPrivate = node.private === true;
  const isSsh = node.leafKind === "terminal" && !!node.sshConnectionId;
  const sshStatus = isSsh ? sshStatuses?.get(node.id) : undefined;
  // Extension-panel lifecycle tone (e.g. SQL Explorer connection state).
  const extState = node.leafKind === "extension-panel" ? node.state : undefined;

  // Program-set terminal title (OSC 2), e.g. a running agent's task. Appended to
  // the folder label so the pane header reads identically to the Workspaces
  // panel's terminal list for the same leaf.
  const termTitle = useTerminalTitles((s) =>
    node.leafKind === "terminal" ? s.titles[node.id] : undefined,
  );
  const baseLabel = leafLabel(node, sshHosts);
  const showTitle =
    node.leafKind === "terminal" &&
    !!termTitle &&
    termTitle !== baseLabel &&
    termTitle !== node.cwd;

  // Float the pane into its own always-on-top window (terminals mirror live via
  // Tauri events; editors open the file). Browser/extension panes can't float.
  const floatParams = floatParamsFor(node, baseLabel);
  const frameRef = useRef<HTMLDivElement>(null);
  const editorHandleRef = useRef<EditorPaneHandle | null>(null);
  const isFloating = useFloatStore((s) => s.floating.has(node.id));
  const doFloat = async () => {
    if (!floatParams) return;
    const r = frameRef.current?.getBoundingClientRect();
    // Editor hand-off: persist the buffer first so the float (which reads the file
    // by path) opens the live content and the main editor's unmount can't drop
    // unsaved edits. No-op when clean; skipped when already floating (ref is null).
    if (floatParams.kind === "editor") await editorHandleRef.current?.save();
    void floatPane(floatParams, { w: r?.width ?? 720, h: r?.height ?? 480 });
  };

  return (
    <div
      ref={(el) => {
        setDropRef(el);
        frameRef.current = el;
      }}
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
      {/* Per-pane navigation header (drag handle + label + close). A terminal
          leaf carries a right-click menu for its per-pane terminal theme; any
          leaf also offers "Split with <extension>" while an extension panel tab
          is open. The menu is dropped entirely when there is nothing to show
          (e.g. an editor pane with no extension tab open), so the header never
          opens an empty box. Only the header bar carries the menu so the
          terminal / editor body keeps its own. */}
      {(() => {
        const headerBar = (
          <div className="border-border/60 bg-card flex h-7 shrink-0 items-center gap-1 border-b px-1 select-none">
            {(() => {
              const dragHandle = (
                <button
                  type="button"
                  ref={setDragRef}
                  {...listeners}
                  {...attributes}
                  disabled={!draggable}
                  aria-label="Drag to move pane"
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded transition-colors",
                    draggable
                      ? "text-muted-foreground/70 hover:bg-muted hover:text-foreground cursor-grab active:cursor-grabbing"
                      : "text-muted-foreground/40 cursor-default",
                  )}
                >
                  <GripVertical size={14} strokeWidth={2} />
                </button>
              );
              // The grip only earns its place (and a tooltip) when the pane can
              // actually move - i.e. it shares the tab with another pane. A lone
              // pane has nothing to reorder, so hide the grip entirely instead of
              // showing a dead disabled button.
              return draggable ? (
                <IconTooltip label="Drag to move pane" side="bottom">
                  {dragHandle}
                </IconTooltip>
              ) : null;
            })()}
            {/* Same glyph the tab strip + drag overlay show for this leaf. The
            muted default tint is overridden by the AI CLI status when active. */}
            <LeafIcon
              info={leafIconInfo(node, aiCliStatuses)}
              size={13}
              className="text-muted-foreground/80"
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                "text-muted-foreground",
                node.leafKind === "editor" && node.preview && "italic",
                // SSH status colors the label, matching the tab strip.
                isSsh && statusLabelClass(sshStatus),
                // Extension-panel lifecycle tone (SQL Explorer connection state),
                // same palette + tab-strip parity.
                extState && extensionStateLabelClass(extState),
                // Private signal lives on the label (red), not the icon. Last = wins.
                isPrivate && "text-destructive",
              )}
            >
              {baseLabel}
              {showTitle ? <span className="opacity-60"> · {termTitle}</span> : null}
            </span>
            {node.leafKind === "editor" && node.dirty && (
              <span className="bg-foreground/60 size-1.5 shrink-0 rounded-full" />
            )}
            {floatParams && (
              <IconTooltip
                label={
                  isFloating
                    ? "Floating — click to focus its window"
                    : "Float pane in its own window"
                }
                side="bottom"
              >
                <button
                  type="button"
                  aria-label={
                    isFloating ? "Focus the floating window" : "Float pane in its own window"
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    doFloat();
                  }}
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded transition-colors",
                    isFloating
                      ? "text-primary hover:bg-muted"
                      : "text-muted-foreground/70 hover:bg-muted hover:text-foreground",
                  )}
                >
                  <SquareArrowOutUpRight size={12} strokeWidth={2} />
                </button>
              </IconTooltip>
            )}
            {onCloseLeaf && (
              <IconTooltip label="Close pane" side="bottom">
                <button
                  type="button"
                  aria-label="Close pane"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseLeaf(node.id);
                  }}
                  className="text-muted-foreground/70 hover:bg-muted hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded transition-colors"
                >
                  <X size={13} strokeWidth={2} />
                </button>
              </IconTooltip>
            )}
          </div>
        );

        const showThemeMenu = node.leafKind === "terminal" && !!onSetTerminalTheme;
        // Split-with-extension only applies while an extension panel is open as
        // a tab; without one there is nothing to relocate into the split.
        const hasSplit = !!onSplitWithExtTab && !!extTabs && extTabs.length > 0;
        // Nothing to offer -> render the bare header (no empty right-click box).
        if (!showThemeMenu && !hasSplit) return headerBar;

        return (
          <ContextMenu>
            <ContextMenuTrigger asChild>{headerBar}</ContextMenuTrigger>
            <ContextMenuContent>
              {/* Per-pane terminal theme. Only terminal leaves carry a palette. */}
              {node.leafKind === "terminal" && onSetTerminalTheme ? (
                <>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>Terminal theme</ContextMenuSubTrigger>
                    <ContextMenuSubContent className="max-h-[60vh] overflow-x-hidden overflow-y-auto">
                      <ContextMenuRadioGroup
                        value={node.terminalThemeId ?? FOLLOW_GLOBAL_THEME}
                        onValueChange={(v) =>
                          onSetTerminalTheme(node.id, v === FOLLOW_GLOBAL_THEME ? null : v)
                        }
                      >
                        <ContextMenuRadioItem value={FOLLOW_GLOBAL_THEME}>
                          Default (follow global)
                        </ContextMenuRadioItem>
                        <ContextMenuSeparator />
                        {TERMINAL_PRESETS.map((p) => (
                          <ContextMenuRadioItem key={p.id} value={p.id}>
                            <ThemeSwatch palette={p.palette} />
                            <span className="truncate">{p.palette.name}</span>
                          </ContextMenuRadioItem>
                        ))}
                      </ContextMenuRadioGroup>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  {hasSplit ? <ContextMenuSeparator /> : null}
                </>
              ) : null}
              {onSplitWithExtTab && extTabs && extTabs.length > 0
                ? extTabs.flatMap((et) => [
                    <ContextMenuItem
                      key={`${et.id}-row`}
                      onSelect={() => onSplitWithExtTab(et.id, node.id, "row")}
                    >
                      Split right with {et.title || "panel"}
                    </ContextMenuItem>,
                    <ContextMenuItem
                      key={`${et.id}-col`}
                      onSelect={() => onSplitWithExtTab(et.id, node.id, "col")}
                    >
                      Split down with {et.title || "panel"}
                    </ContextMenuItem>,
                  ])
                : null}
            </ContextMenuContent>
          </ContextMenu>
        );
      })()}
      {/* While floating, an independent window mirrors this leaf, so the pane
          hides its now-redundant terminal (kept mounted so the PTY + mirror tap
          stay alive) and shows an indicator instead. */}
      <div className="relative min-h-0 flex-1">
        <LeafBody
          node={node}
          tabVisible={tabVisible && !isFloating}
          isFloating={isFloating}
          editorHandleRef={editorHandleRef}
          focused={focused}
          b={b}
          mdPreview={mdPreview}
        />
        {isFloating && (
          <div className="bg-background text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-3 text-center text-[11px]">
            <SquareArrowOutUpRight size={22} strokeWidth={1.5} className="opacity-50" />
            <span className="max-w-56 leading-relaxed">
              This pane is open in a floating window.
            </span>
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={doFloat}
                className="hover:bg-muted hover:text-foreground border-border rounded-md border px-2 py-1 transition-colors"
              >
                Focus window
              </button>
              <button
                type="button"
                onClick={() => closeFloat(node.id)}
                className="hover:bg-muted hover:text-foreground border-border rounded-md border px-2 py-1 transition-colors"
              >
                Dock back
              </button>
            </span>
          </div>
        )}
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
          {i > 0 && <ResizableHandle withHandle />}
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
  extTabs,
  onSplitWithExtTab,
  onSetTerminalTheme,
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
    // Restore any preview webviews hidden for the drag.
    setPaneDragActive(false);
  };

  const handleDragStart = (ev: DragStartEvent) => {
    latestRef.current = { over: null, edge: null };
    setDrag({ sourceLeafId: parsePaneId(ev.active.id, DRAG_PREFIX), overLeafId: null, edge: null });
    // Hide preview webviews so the DOM drop indicators show over a browser pane
    // and the pointer reaches the DOM drop zones instead of the webview surface.
    setPaneDragActive(true);
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
    () => ({ drag, leafCount, onCloseLeaf, extTabs, onSplitWithExtTab, onSetTerminalTheme }),
    [drag, leafCount, onCloseLeaf, extTabs, onSplitWithExtTab, onSetTerminalTheme],
  );
  const metaValue = useMemo<PaneMetaValue>(
    () => ({ sshHosts, sshStatuses, aiCliStatuses }),
    [sshHosts, sshStatuses, aiCliStatuses],
  );

  // Re-render the overlay once the file-icon set lands so a dragged editor leaf
  // shows its file-type glyph rather than the pencil fallback.
  useExplorerIconsReady();

  const draggedLeaf =
    drag.sourceLeafId !== null ? (leafList.find((l) => l.id === drag.sourceLeafId) ?? null) : null;

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
          // Fixed 1:1 (28x28) chip with the leaf's own icon centered (file-type
          // glyph for editors, favicon for browsers, terminal/cloud for shells,
          // lock for private). The pane drag handle is tiny, so a centered
          // icon-only square reads cleaner than an icon+label pill clipped to the
          // handle's width.
          <div className="bg-accent text-accent-foreground ring-border flex size-7 items-center justify-center shadow-lg ring-1">
            <LeafIcon info={leafIconInfo(draggedLeaf, aiCliStatuses)} size={14} />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
