import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, KEY_SEP, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getBindingTokens, SHORTCUTS, type ShortcutId } from "@/modules/shortcuts/shortcuts";
import {
  BookOpenIcon,
  DocumentCodeIcon,
  FolderOpenIcon,
  GridViewIcon,
  KeyboardIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  PuzzleIcon,
  Settings01Icon,
  SidebarLeftIcon,
  TextWrapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { SearchInline, type SearchInlineHandle, type SearchTarget } from "./SearchInline";
import type { Tab } from "@/modules/tabs";
import { TabBar } from "@/modules/tabs";
import { SshMenu } from "@/modules/ssh/SshMenu";
import type { SshConnection } from "@/modules/ssh/connections";
import type { SshStatus } from "@/modules/ssh/status";
import type { AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";

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
  onNewPreview: () => void;
  onNewEditor: () => void;
  /** Pin a preview-editor leaf on double-click. */
  onPinLeaf: (tabId: number, leafId: number) => void;
  /** Drag-and-drop reorder of the tab strip. */
  onReorderTabs?: (fromTabId: number, beforeTabId: number | null) => void;
  /** Drag-and-drop reorder inside a split group. */
  onReorderLeafInGroup?: (leafId: number, beforeLeafId: number | null) => void;
  onToggleSidebar: () => void;
  onOpenFolder: () => void;
  onSplit: (dir: "row" | "col") => void;
  /** True when the active tab still has room for another split. */
  canSplit: boolean;
  onOpenShortcuts: () => void;
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
  /** Markdown-preview toggle. `null` hides the button when not a markdown editor. */
  mdPreviewToggle: { active: boolean; toggle: () => void } | null;
  /** Word-wrap toggle. `null` hides the button when not an editor, or when previewing markdown. */
  lineWrapToggle: { active: boolean; toggle: () => void } | null;
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
  if (target.closest(INTERACTIVE_SELECTOR)) return;
  const w = getCurrentWindow();
  if (e.detail === 2) {
    void w.toggleMaximize();
  } else {
    void w.startDragging();
  }
}

export function Header({
  tabs,
  activeId,
  onSelectEntry,
  onCloseEntry,
  onNewTerminal,
  onNewPrivateTerminal,
  onTogglePrivate,
  onNewPreview,
  onNewEditor,
  onPinLeaf,
  onReorderTabs,
  onReorderLeafInGroup,
  onToggleSidebar,
  onOpenFolder,
  onSplit,
  canSplit,
  onOpenShortcuts,
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
  mdPreviewToggle,
  lineWrapToggle,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);

  const tokensFor = (id: ShortcutId): string => {
    const s = SHORTCUTS.find((s) => s.id === id);
    if (!s) return "";
    const bindings = userShortcuts[id] || s.defaultBindings;
    if (!bindings || bindings.length === 0) return "";
    return getBindingTokens(bindings[0]).join(KEY_SEP);
  };

  const shortcutLabel = useMemo(() => {
    const tokens = tokensFor("shortcuts.open");
    return tokens ? `Keyboard shortcuts (${tokens})` : "Keyboard shortcuts";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userShortcuts]);

  const splitRightTokens = tokensFor("pane.splitRight");
  const splitDownTokens = tokensFor("pane.splitDown");
  const wordWrapTokens = tokensFor("editor.toggleWordWrap");

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

  const shortcutsButton = (
    <IconTooltip label={shortcutLabel}>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:bg-accent hover:text-foreground size-7 shrink-0 rounded-md"
        onClick={onOpenShortcuts}
        aria-label={shortcutLabel}
      >
        <HugeiconsIcon icon={KeyboardIcon} size={16} strokeWidth={1.75} />
      </Button>
    </IconTooltip>
  );

  const extensionsButton = (
    <IconTooltip label="Extensions">
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:bg-accent hover:text-foreground size-7 shrink-0 rounded-md"
        onClick={onOpenExtensions}
        aria-label="Extensions"
      >
        <HugeiconsIcon icon={PuzzleIcon} size={16} strokeWidth={1.75} />
      </Button>
    </IconTooltip>
  );

  const settingsButton = (
    <IconTooltip label="Settings">
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:bg-accent hover:text-foreground size-7 shrink-0 rounded-md"
        onClick={onOpenSettings}
        aria-label="Settings"
      >
        <HugeiconsIcon icon={Settings01Icon} size={15} strokeWidth={1.75} />
      </Button>
    </IconTooltip>
  );

  return (
    <div
      ref={rootRef}
      className="border-border/60 bg-card flex shrink-0 flex-col border-b select-none"
    >
      {/* Row 1: toolbar. Window controls and drag region scoped to this row. */}
      <div
        data-tauri-drag-region
        onMouseDown={onHeaderMouseDown}
        className={`flex h-9 shrink-0 items-center gap-2 ${
          IS_MAC ? "pr-2 pl-20" : "pr-0 pl-2"
        }`}
      >
        <div className="flex shrink-0 items-center gap-0.5">
          <IconTooltip label="Toggle sidebar">
            <Button
              onClick={onToggleSidebar}
              aria-label="Toggle sidebar"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded-md"
            >
              <HugeiconsIcon icon={SidebarLeftIcon} size={18} strokeWidth={1.75} />
            </Button>
          </IconTooltip>

          <IconTooltip label="Open folder…">
            <Button
              onClick={onOpenFolder}
              aria-label="Open folder"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded-md"
            >
              <HugeiconsIcon icon={FolderOpenIcon} size={16} strokeWidth={1.75} />
            </Button>
          </IconTooltip>

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded-md disabled:opacity-50"
                    aria-label="Split pane"
                    disabled={!canSplit}
                  >
                    <HugeiconsIcon icon={GridViewIcon} size={16} strokeWidth={1.75} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Split pane</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="w-auto min-w-56">
              <DropdownMenuItem onSelect={() => onSplit("row")}>
                <HugeiconsIcon icon={LayoutTwoColumnIcon} size={14} strokeWidth={1.75} />
                <span className="flex-1 whitespace-nowrap">Split right</span>
                {splitRightTokens && (
                  <span className="text-muted-foreground text-xs whitespace-nowrap">
                    {splitRightTokens}
                  </span>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onSplit("col")}>
                <HugeiconsIcon icon={LayoutTwoRowIcon} size={14} strokeWidth={1.75} />
                <span className="flex-1 whitespace-nowrap">Split down</span>
                {splitDownTokens && (
                  <span className="text-muted-foreground text-xs whitespace-nowrap">
                    {splitDownTokens}
                  </span>
                )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {!IS_MAC && shortcutsButton}
          {!IS_MAC && extensionsButton}
        </div>

        {/* Drag spacer between the left and right icon clusters. */}
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />

        {mdPreviewToggle && (
          <IconTooltip label={mdPreviewToggle.active ? "Show source" : "Preview markdown"}>
            <Button
              variant="ghost"
              size="icon"
              onClick={mdPreviewToggle.toggle}
              aria-label={mdPreviewToggle.active ? "Show source" : "Preview markdown"}
              aria-pressed={mdPreviewToggle.active}
              className={`hover:bg-accent hover:text-foreground size-7 shrink-0 rounded-md ${
                mdPreviewToggle.active ? "bg-accent text-foreground" : "text-muted-foreground"
              }`}
            >
              <HugeiconsIcon
                icon={mdPreviewToggle.active ? DocumentCodeIcon : BookOpenIcon}
                size={15}
                strokeWidth={1.75}
              />
            </Button>
          </IconTooltip>
        )}

        {lineWrapToggle && (
          <IconTooltip
            label={`${lineWrapToggle.active ? "Disable" : "Enable"} word wrap${
              wordWrapTokens ? ` (${wordWrapTokens})` : ""
            }`}
          >
            <Button
              variant="ghost"
              size="icon"
              onClick={lineWrapToggle.toggle}
              aria-label={lineWrapToggle.active ? "Disable word wrap" : "Enable word wrap"}
              aria-pressed={lineWrapToggle.active}
              className={`hover:bg-accent hover:text-foreground size-7 shrink-0 rounded-md ${
                lineWrapToggle.active ? "bg-accent text-foreground" : "text-muted-foreground"
              }`}
            >
              <HugeiconsIcon icon={TextWrapIcon} size={15} strokeWidth={1.75} />
            </Button>
          </IconTooltip>
        )}

        <SearchInline ref={searchRef} target={searchTarget} compact={compact} />

        {/* Divider before the trailing cluster. */}
        <span className="bg-border mx-1 h-5 w-px shrink-0" />

        {IS_MAC && (
          <>
            {shortcutsButton}
            {extensionsButton}
            <SshMenu onConnect={onConnectSsh} />
            {settingsButton}
          </>
        )}

        {!IS_MAC && (
          <>
            <SshMenu onConnect={onConnectSsh} />
            {settingsButton}
          </>
        )}

        {/* Extensions button: left cluster on non-mac, right cluster on mac. */}

        {USE_CUSTOM_WINDOW_CONTROLS && (
          <>
            <span className="bg-border ml-1 h-5 w-px shrink-0" />
            <WindowControls />
          </>
        )}
      </div>

      {/* Row 2: tab strip across full width. h-10 (40px) fits the 28px triggers + 10px scrollbar. */}
      <div
        data-tauri-drag-region
        onMouseDown={onHeaderMouseDown}
        className="border-border/60 flex h-10 shrink-0 items-center border-t pl-2"
      >
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelectEntry={onSelectEntry}
          onCloseEntry={onCloseEntry}
          onNewTerminal={onNewTerminal}
          onNewPrivateTerminal={onNewPrivateTerminal}
          onTogglePrivate={onTogglePrivate}
          onNewPreview={onNewPreview}
          onNewEditor={onNewEditor}
          onPinLeaf={onPinLeaf}
          onReorderTabs={onReorderTabs}
          onReorderLeafInGroup={onReorderLeafInGroup}
          onMoveLeafToGroup={onMoveLeafToGroup}
          onMoveLeafToNewTab={onMoveLeafToNewTab}
          onRotateLeafSplit={onRotateLeafSplit}
          sshStatuses={sshStatuses}
          aiCliStatuses={aiCliStatuses}
          compact={compact}
        />
        {/* Trailing drag region after the tabs. */}
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
      </div>
    </div>
  );
}
