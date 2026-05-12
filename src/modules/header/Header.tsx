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
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  getBindingTokens,
  SHORTCUTS,
  type ShortcutId,
} from "@/modules/shortcuts/shortcuts";
import type { Tab } from "@/modules/tabs";
import { TabBar } from "@/modules/tabs";
import {
  FolderOpenIcon,
  GridViewIcon,
  KeyboardIcon,
  LayoutTwoColumnIcon,
  LayoutTwoRowIcon,
  Settings01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  SearchInline,
  type SearchInlineHandle,
  type SearchTarget,
} from "./SearchInline";

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onClose: (id: number) => void;
  /** Promote a preview (transient) tab to persistent. */
  onPin: (id: number) => void;
  onToggleSidebar: () => void;
  onOpenFolder: () => void;
  onSplit: (dir: "row" | "col") => void;
  /** Active tab is a pane tab and below the per-tab pane cap. */
  canSplit: boolean;
  onOpenShortcuts: () => void;
  onOpenSettings: () => void;
  searchTarget: SearchTarget;
  searchRef: RefObject<SearchInlineHandle | null>;
};

const COMPACT_WIDTH = 720;

export function Header({
  tabs,
  activeId,
  onSelect,
  onNew,
  onNewPreview,
  onNewEditor,
  onClose,
  onPin,
  onToggleSidebar,
  onOpenFolder,
  onSplit,
  canSplit,
  onOpenShortcuts,
  onOpenSettings,
  searchTarget,
  searchRef,
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

      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        data-tauri-drag-region
      >
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelect={onSelect}
          onNew={onNew}
          onNewPreview={onNewPreview}
          onNewEditor={onNewEditor}
          onClose={onClose}
          onPin={onPin}
          compact={compact}
        />
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
      </div>

      <SearchInline ref={searchRef} target={searchTarget} compact={compact} />

      {IS_MAC && (
        <>
          {shortcutsButton}
          {settingsButton}
        </>
      )}

      {!IS_MAC && settingsButton}

      {USE_CUSTOM_WINDOW_CONTROLS && (
        <>
          <span className="ml-1 h-5 w-px shrink-0 bg-border" />
          <WindowControls />
        </>
      )}
    </div>
  );
}
