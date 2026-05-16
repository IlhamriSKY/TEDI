import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, KEY_SEP, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  getBindingTokens,
  SHORTCUTS,
  type ShortcutId,
} from "@/modules/shortcuts/shortcuts";
import {
  BookOpenIcon,
  DocumentCodeIcon,
  FolderOpenIcon,
  GridViewIcon,
  KeyboardIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  Settings01Icon,
  SidebarLeftIcon,
  TextWrapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  SearchInline,
  type SearchInlineHandle,
  type SearchTarget,
} from "./SearchInline";
import type { Tab } from "@/modules/tabs";
import { TabBar } from "@/modules/tabs";
import { SshMenu } from "@/modules/ssh/SshMenu";
import type { SshConnection } from "@/modules/ssh/connections";
import type { SshStatus } from "@/modules/ssh/status";

type Props = {
  tabs: Tab[];
  activeId: number;
  /** Activate a pane entry (or standalone tab when leafId is null). */
  onSelectEntry: (tabId: number, leafId: number | null) => void;
  /** Close a pane entry or standalone tab. */
  onCloseEntry: (tabId: number, leafId: number | null) => void;
  onNewTerminal: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  /** Promote a preview-editor leaf to persistent on double-click. */
  onPinLeaf: (tabId: number, leafId: number) => void;
  /** Reorder a tab in the tab strip (drag-and-drop). */
  onReorderTabs?: (fromTabId: number, beforeTabId: number | null) => void;
  onToggleSidebar: () => void;
  onOpenFolder: () => void;
  onSplit: (dir: "row" | "col") => void;
  /** Layout currently below per-tab pane cap (still has room for a split). */
  canSplit: boolean;
  onOpenShortcuts: () => void;
  onOpenSettings: () => void;
  /** Open a saved SSH host as a new terminal tab. */
  onConnectSsh: (conn: SshConnection) => void;
  /**
   * Move a leaf out of its current tab into `targetTabId` as a split. Used
   * by the per-entry "Move to group" button on the tab strip. Caller toasts
   * on full.
   */
  onMoveLeafToGroup: (leafId: number, targetTabId: number) => void;
  /** Flip the orientation of the split node that directly contains `leafId`. */
  onRotateLeafSplit: (leafId: number) => void;
  /** Per-leaf SSH session status, forwarded to the tab strip for the dot. */
  sshStatuses?: Map<number, SshStatus>;
  searchTarget: SearchTarget;
  searchRef: RefObject<SearchInlineHandle | null>;
  /** Markdown-preview toggle for the active editor leaf. `null` hides the
   *  button (active tab/leaf isn't a markdown editor). */
  mdPreviewToggle: { active: boolean; toggle: () => void } | null;
  /** Word-wrap toggle for the active editor leaf. `null` hides the button
   *  (active tab/leaf isn't an editor, or markdown preview is showing). */
  lineWrapToggle: { active: boolean; toggle: () => void } | null;
};

const COMPACT_WIDTH = 720;

/**
 * Manual window drag fallback. Tauri's automatic `data-tauri-drag-region`
 * detection is flaky on WebView2 (Windows) when the region wraps Radix
 * primitives + dnd-kit DOM - mousedown bubbles past the auto-listener for
 * reasons that aren't reproducible from JS. Calling `startDragging()`
 * directly from a React mousedown handler bypasses the auto-detection and
 * always works. Interactive elements + explicit `data-tauri-drag-region="false"`
 * children are excluded so clicks on buttons / tabs still behave normally.
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
  onNewPreview,
  onNewEditor,
  onPinLeaf,
  onReorderTabs,
  onToggleSidebar,
  onOpenFolder,
  onSplit,
  canSplit,
  onOpenShortcuts,
  onOpenSettings,
  onConnectSsh,
  onMoveLeafToGroup,
  onRotateLeafSplit,
  sshStatuses,
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
        className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={onOpenShortcuts}
        aria-label={shortcutLabel}
      >
        <HugeiconsIcon icon={KeyboardIcon} size={16} strokeWidth={1.75} />
      </Button>
    </IconTooltip>
  );

  const settingsButton = (
    <IconTooltip label="Settings">
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
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
      data-tauri-drag-region
      onMouseDown={onHeaderMouseDown}
      className={`flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-card select-none ${
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
            className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
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
            className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
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
                  className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
                  aria-label="Split pane"
                  disabled={!canSplit}
                >
                  <HugeiconsIcon
                    icon={GridViewIcon}
                    size={16}
                    strokeWidth={1.75}
                  />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">Split pane</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="start" className="w-auto min-w-56">
            <DropdownMenuItem onSelect={() => onSplit("row")}>
              <HugeiconsIcon
                icon={LayoutTwoColumnIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1 whitespace-nowrap">Split right</span>
              {splitRightTokens && (
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {splitRightTokens}
                </span>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onSplit("col")}>
              <HugeiconsIcon
                icon={LayoutTwoRowIcon}
                size={14}
                strokeWidth={1.75}
              />
              <span className="flex-1 whitespace-nowrap">Split down</span>
              {splitDownTokens && (
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  {splitDownTokens}
                </span>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {!IS_MAC && shortcutsButton}
      </div>

      {!IS_MAC && <span className="mx-1 h-5 w-px shrink-0 bg-border" />}

      {IS_MAC && <span className="mr-1 h-full w-px shrink-0 bg-border" />}

      <div className="flex min-w-0 flex-1 items-center gap-2">
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelectEntry={onSelectEntry}
          onCloseEntry={onCloseEntry}
          onNewTerminal={onNewTerminal}
          onNewPreview={onNewPreview}
          onNewEditor={onNewEditor}
          onPinLeaf={onPinLeaf}
          onReorderTabs={onReorderTabs}
          onMoveLeafToGroup={onMoveLeafToGroup}
          onRotateLeafSplit={onRotateLeafSplit}
          sshStatuses={sshStatuses}
          compact={compact}
        />
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
      </div>

      {mdPreviewToggle && (
        <IconTooltip
          label={
            mdPreviewToggle.active
              ? "Show source"
              : "Preview markdown"
          }
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={mdPreviewToggle.toggle}
            aria-label={
              mdPreviewToggle.active ? "Show source" : "Preview markdown"
            }
            aria-pressed={mdPreviewToggle.active}
            className={`size-7 shrink-0 rounded-md hover:bg-accent hover:text-foreground ${
              mdPreviewToggle.active
                ? "bg-accent text-foreground"
                : "text-muted-foreground"
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
            aria-label={
              lineWrapToggle.active ? "Disable word wrap" : "Enable word wrap"
            }
            aria-pressed={lineWrapToggle.active}
            className={`size-7 shrink-0 rounded-md hover:bg-accent hover:text-foreground ${
              lineWrapToggle.active
                ? "bg-accent text-foreground"
                : "text-muted-foreground"
            }`}
          >
            <HugeiconsIcon icon={TextWrapIcon} size={15} strokeWidth={1.75} />
          </Button>
        </IconTooltip>
      )}

      <SearchInline ref={searchRef} target={searchTarget} compact={compact} />

      {/* Vertical divider between the search bar and the trailing utility
          cluster (shortcuts on macOS, SSH, settings, window controls). */}
      <span className="mx-1 h-5 w-px shrink-0 bg-border" />

      {IS_MAC && (
        <>
          {shortcutsButton}
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

      {USE_CUSTOM_WINDOW_CONTROLS && (
        <>
          <span className="ml-1 h-5 w-px shrink-0 bg-border" />
          <WindowControls />
        </>
      )}
    </div>
  );
}
