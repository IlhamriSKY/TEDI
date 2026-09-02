import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { WindowControls } from "@/components/WindowControls";
import { cn } from "@/lib/utils";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { SearchInline, type SearchInlineHandle, type SearchTarget } from "./SearchInline";
import type { Tab } from "@/modules/tabs";
import { TabBar } from "@/modules/tabs";
import type { WorkspaceView } from "@/modules/workspaces/store";
import { SshMenu } from "@/modules/ssh/SshMenu";
import { ExtensionHeaderItems } from "@/modules/extensions/components/ExtensionHeaderItems";
import { McpInstallButton } from "@/modules/mcpInstall/McpInstallButton";
import { useTheme } from "@/modules/theme";
import type { SshConnection } from "@/modules/ssh/connections";
import type { SshStatus } from "@/modules/ssh/status";
import type { AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import {
  Columns3,
  FolderOpen,
  LayoutDashboard,
  Moon,
  PanelLeft,
  Puzzle,
  Settings,
  SquareKanban,
  Sun,
} from "lucide-react";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** Activate a pane entry, or standalone tab when leafId is null. */
  onSelectEntry: (tabId: number, leafId: number | null) => void;
  /** Close a pane entry or standalone tab. */
  onCloseEntry: (tabId: number, leafId: number | null) => void;
  onNewTerminal: () => void;
  /** Open a new local terminal tab pre-flagged as private (AI cannot read it). */
  onNewPrivateTerminal?: () => void;
  /** Toggle the per-leaf privacy flag from the tab right-click menu. */
  onTogglePrivate?: (leafId: number) => void;
  /** Pin or unpin a whole tab. See `TabBar`. */
  onSetTabPinned?: (tabId: number, pinned: boolean) => void;
  /** Set a leaf's tab name, or `null` to fall back to the derived one. */
  onRenameLeaf?: (leafId: number, title: string | null) => void;
  onNewPreview: () => void;
  /** `+` -> Note: open a scratch note in the editor. */
  onNewNote: () => void;
  /** `+` -> AI Chat: open one chat from history as a pane. */
  onOpenAiChat: (sessionId: string) => void;
  /** `+` -> Agent...: open the agent picker dialog. */
  onOpenAgents: () => void;
  /** How the active workspace presents its panes. Drives the TOGGLE's state,
   *  not the strip - a workspace stays "in canvas mode" even while a diff tab
   *  is borrowing the tabs presentation. */
  view: WorkspaceView;
  /** Whether to draw the tab strip. See `effectiveView` in App. */
  showTabStrip: boolean;
  /** Switch the active workspace between tabs / kanban / canvas. */
  onSetView: (view: WorkspaceView) => void;
  /** Pin a preview-editor leaf on double-click. */
  onPinLeaf: (tabId: number, leafId: number) => void;
  /** Drag-and-drop reorder of the tab strip. */
  onReorderTabs?: (fromTabId: number, beforeTabId: number | null) => void;
  /** Drag-and-drop reorder inside a split group. */
  onReorderLeafInGroup?: (leafId: number, beforeLeafId: number | null) => void;
  onToggleSidebar: () => void;
  /** Open a folder as the new workspace root. */
  onOpenFolder: () => void;
  /** Split the active pane. Forwarded to the TabBar's `+` dropdown. */
  onSplit: (dir: "row" | "col") => void;
  /** True when the active tab still has room for another split. */
  canSplit: boolean;
  onOpenExtensions: () => void;
  onOpenSettings: () => void;
  /** Open a saved SSH host as a new terminal tab. `opts.private` opens it
   *  pre-flagged as private (AI cannot see its contents or even existence). */
  onConnectSsh: (conn: SshConnection, opts?: { private?: boolean }) => void;
  /** Move a leaf into `targetTabId` as a split. Caller toasts on full. */
  onMoveLeafToGroup: (leafId: number, targetTabId: number) => void;
  /** Pop `leafId` out into a new top-level tab. Returns "invalid" if not in a multi-leaf split. */
  onMoveLeafToNewTab: (leafId: number) => "ok" | "invalid";
  /** Flip the orientation of the split that contains `leafId`. */
  onRotateLeafSplit: (leafId: number) => void;
  /** Per-leaf SSH status for the tab-strip dot. */
  sshStatuses?: Map<number, SshStatus>;
  /** Per-leaf AI CLI status for the tab-strip dot. */
  aiCliStatuses?: Map<number, AiCliStatus>;
  searchTarget: SearchTarget;
  searchRef: RefObject<SearchInlineHandle | null>;
};

const COMPACT_WIDTH = 720;

/**
 * Manual window-drag fallback. Tauri's auto `data-tauri-drag-region` is flaky
 * on WebView2 when the region wraps Radix + dnd-kit DOM. Calling `startDragging()`
 * from a React mousedown handler works reliably. Interactive elements and
 * `data-tauri-drag-region="false"` children are excluded.
 */
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [role="tab"], [role="menuitem"], [data-tauri-drag-region="false"]';

function onHeaderMouseDown(e: React.MouseEvent<HTMLElement>) {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (!target?.closest) return;
  // Portaled content (the SshMenu dialogs, dropdown/context menus, tooltips)
  // renders into `document.body`, but React still bubbles its events up the
  // *React* tree - straight into this handler. Without this guard, selecting
  // text in one of those dialogs drags the window instead, and double-clicking
  // a word maximizes it. Only real DOM descendants of the header row drag.
  if (!e.currentTarget.contains(target)) return;
  if (target.closest(INTERACTIVE_SELECTOR)) return;
  const w = getCurrentWindow();
  if (e.detail === 2) {
    void w.toggleMaximize();
  } else {
    void w.startDragging();
  }
}

/**
 * Tabs / Kanban / Canvas, the three ways a workspace can present its panes.
 *
 * In the toolbar rather than the Workspaces sidebar because two of the three
 * HIDE the tab strip, and a switch you have to open a collapsible panel to
 * reach is a poor way back from a view you did not mean to enter. The setting
 * is still per workspace - this just writes the active one.
 */
function WorkspaceViewToggle({
  view,
  onSetView,
}: {
  view: WorkspaceView;
  onSetView: (view: WorkspaceView) => void;
}) {
  const items: { id: WorkspaceView; label: string; Icon: typeof PanelLeft }[] = [
    { id: "tabs", label: "Tabs", Icon: Columns3 },
    { id: "kanban", label: "Kanban", Icon: SquareKanban },
    { id: "canvas", label: "Canvas", Icon: LayoutDashboard },
  ];
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {items.map(({ id, label, Icon }) => (
        <IconTooltip key={id} label={label}>
          <Button
            onClick={() => onSetView(id)}
            aria-label={`${label} view`}
            aria-pressed={view === id}
            variant="ghost"
            size="icon-sm"
            className={cn(
              "size-6 shrink-0 rounded",
              view === id
                ? "bg-accent text-accent-foreground"
                : cn("text-muted-foreground", TOOLBAR_HOVER),
            )}
          >
            <Icon size={15} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
      ))}
    </div>
  );
}

function HeaderImpl({
  tabs,
  activeId,
  onSelectEntry,
  onCloseEntry,
  onNewTerminal,
  onNewPrivateTerminal,
  onTogglePrivate,
  onSetTabPinned,
  onRenameLeaf,
  onNewPreview,
  onNewNote,
  onOpenAiChat,
  onOpenAgents,
  view,
  showTabStrip,
  onSetView,
  onPinLeaf,
  onReorderTabs,
  onReorderLeafInGroup,
  onToggleSidebar,
  onOpenFolder,
  onSplit,
  canSplit,
  onOpenExtensions,
  onOpenSettings,
  onConnectSsh,
  onMoveLeafToGroup,
  onMoveLeafToNewTab,
  onRotateLeafSplit,
  sshStatuses,
  aiCliStatuses,
  searchTarget,
  searchRef,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setCompact(w < COMPACT_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { resolvedTheme, setTheme } = useTheme();

  const extensionsButton = (
    <IconTooltip label="Extensions">
      <Button
        variant="ghost"
        size="icon"
        className={cn("text-muted-foreground", TOOLBAR_HOVER, "size-7 shrink-0 rounded-md")}
        onClick={onOpenExtensions}
        aria-label="Extensions"
      >
        <Puzzle size={16} strokeWidth={1.75} />
      </Button>
    </IconTooltip>
  );

  // Light / dark, as one toolbar button beside Install MCP. It replaced the
  // three-card Appearance picker in Settings: switching theme is a thing people
  // do while working, and a separate window is the wrong place for it. Two
  // states only, no "system" - the OS default still seeds a first run, it just
  // is not offered as a thing to pick.
  const themeButton = (
    <IconTooltip label={resolvedTheme === "dark" ? "Switch to light" : "Switch to dark"}>
      <Button
        variant="ghost"
        size="icon"
        className={cn("text-muted-foreground", TOOLBAR_HOVER, "size-7 shrink-0 rounded-md")}
        onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
        aria-label={resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      >
        {resolvedTheme === "dark" ? (
          <Sun size={15} strokeWidth={1.75} />
        ) : (
          <Moon size={15} strokeWidth={1.75} />
        )}
      </Button>
    </IconTooltip>
  );

  const settingsButton = (
    <IconTooltip label="Settings">
      <Button
        variant="ghost"
        size="icon"
        className={cn("text-muted-foreground", TOOLBAR_HOVER, "size-7 shrink-0 rounded-md")}
        onClick={onOpenSettings}
        aria-label="Settings"
      >
        <Settings size={15} strokeWidth={1.75} />
      </Button>
    </IconTooltip>
  );

  return (
    <div
      ref={rootRef}
      data-tedi-header
      className="border-border/60 bg-card flex shrink-0 flex-col border-b select-none"
    >
      {/* Row 1: toolbar. Window controls and drag region scoped to this row. */}
      <div
        data-tauri-drag-region
        onMouseDown={onHeaderMouseDown}
        className={`flex h-9 shrink-0 items-center gap-2 ${IS_MAC ? "pr-2 pl-20" : "pr-0 pl-2"}`}
      >
        <div className="flex shrink-0 items-center gap-0.5">
          <IconTooltip label="Toggle sidebar">
            <Button
              onClick={onToggleSidebar}
              aria-label="Toggle sidebar"
              variant="ghost"
              size="icon-sm"
              className={cn("text-muted-foreground", TOOLBAR_HOVER, "shrink-0 rounded-md")}
            >
              <PanelLeft size={18} strokeWidth={1.75} />
            </Button>
          </IconTooltip>

          <IconTooltip label="Open folder…">
            <Button
              onClick={onOpenFolder}
              aria-label="Open folder"
              variant="ghost"
              size="icon-sm"
              className={cn("text-muted-foreground", TOOLBAR_HOVER, "shrink-0 rounded-md")}
            >
              <FolderOpen size={16} strokeWidth={1.75} />
            </Button>
          </IconTooltip>
        </div>

        <span className="bg-border mx-0.5 h-5 w-px shrink-0" />
        <WorkspaceViewToggle view={view} onSetView={onSetView} />

        {/* Drag spacer between the left and right icon clusters. */}
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />

        {/* The per-file cluster that used to sit here - detected-URL globe,
            `placement: "left"` extension buttons (Beautify), word wrap, and
            before them the markdown source/preview toggle - all moved onto the
            pane header beside its float button. Each acts on one pane, and the
            toolbar copy could only ever address the focused one. */}
        <SearchInline ref={searchRef} target={searchTarget} compact={compact} />

        {/* Divider before the trailing cluster. */}
        <span className="bg-border mx-1 h-5 w-px shrink-0" />

        <SshMenu onConnect={onConnectSsh} />
        <ExtensionHeaderItems />
        {extensionsButton}
        <McpInstallButton />
        {themeButton}
        {settingsButton}

        {USE_CUSTOM_WINDOW_CONTROLS && (
          <>
            <span className="bg-border ml-1 h-5 w-px shrink-0" />
            <WindowControls />
          </>
        )}
      </div>

      {/* Row 2: tab strip. Hidden in kanban and canvas view, which each show the
          whole workspace at once - a strip of the same panes beside them would
          be a second, disagreeing index of the thing already on screen. It comes
          BACK for a non-pane tab (a diff, source control, an extension tab):
          those are not panes, so neither view has anything to say about them,
          and without the strip one would be unreachable. h-10 (40px) fits the 28px triggers + 10px scrollbar.
          Painted with the canvas (`bg-background`) so the strip recesses below the toolbar's
          `bg-card`, and the active tab (accent) reads as lifted out of the strip. */}
      {showTabStrip ? (
        <div
          data-tauri-drag-region
          onMouseDown={onHeaderMouseDown}
          // `data-tab-strip` marks the whole row (tabs + the trailing drag region)
          // as an OS file-drop target: dropping a file here opens it in an editor,
          // a folder opens a terminal tab. Hit-tested by `useEditorFileDrop`,
          // which also sets `data-drop-active` while a drag hovers the row - the
          // only affordance the user gets, since Tauri's native drag intercept
          // means no HTML dragover fires to style against.
          data-tab-strip
          className="border-border/60 bg-background data-[drop-active=true]:bg-accent/50 flex h-10 shrink-0 items-center border-t pl-2 transition-colors"
        >
          <TabBar
            tabs={tabs}
            activeId={activeId}
            onSelectEntry={onSelectEntry}
            onCloseEntry={onCloseEntry}
            onNewTerminal={onNewTerminal}
            onNewPrivateTerminal={onNewPrivateTerminal}
            onTogglePrivate={onTogglePrivate}
            onSetTabPinned={onSetTabPinned}
            onRenameLeaf={onRenameLeaf}
            onNewPreview={onNewPreview}
            onNewNote={onNewNote}
            onOpenAiChat={onOpenAiChat}
            onOpenAgents={onOpenAgents}
            onPinLeaf={onPinLeaf}
            onReorderTabs={onReorderTabs}
            onReorderLeafInGroup={onReorderLeafInGroup}
            onMoveLeafToGroup={onMoveLeafToGroup}
            onMoveLeafToNewTab={onMoveLeafToNewTab}
            onRotateLeafSplit={onRotateLeafSplit}
            onSplit={onSplit}
            canSplit={canSplit}
            sshStatuses={sshStatuses}
            aiCliStatuses={aiCliStatuses}
            compact={compact}
          />
          {/* Trailing drag region after the tabs. */}
          <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Memoised so unrelated App.tsx re-renders (AI streaming tokens, status bar
 * ticks, sidebar resize, etc.) don't ripple through the header + tab strip.
 * Callers MUST pass stable callback references (use `useCallback`) or memo
 * is a no-op.
 */
export const Header = memo(HeaderImpl);
