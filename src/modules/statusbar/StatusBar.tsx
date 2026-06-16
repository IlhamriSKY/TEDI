import { memo } from "react";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";
import { AiOpenButton } from "@/modules/ai/components/AiStatusBarControls";
import { useChatStore } from "@/modules/ai";
import {
  ExtensionStatusItems,
  RightPanelCompactToggles,
  RightPanelDefaultToggles,
  SidebarSectionRightToggles,
} from "@/modules/extensions";
import { SchedulerStatusPill } from "@/modules/scheduler";
import { useScmRightPanelStore } from "@/modules/scm/scmRightPanelStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { UpdaterPill } from "@/modules/updater";
import { GitBranchIcon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { IS_LINUX, IS_MAC, IS_WINDOWS } from "@/lib/platform";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { ZoomIndicator } from "./ZoomIndicator";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onOpenMini: () => void;
  /** When set, shows a one-click "Open preview" chip pointing at this URL. */
  detectedBrowserUrl?: string | null;
  onOpenPreview?: () => void;
};

// Memoized. Callbacks are stable and props are primitives, so shallow equality
// skips re-render on unrelated parent updates.
function StatusBarInner({
  cwd,
  filePath,
  home,
  onCd,
  onOpenMini,
  detectedBrowserUrl,
  onOpenPreview,
}: Props) {
  const panelOpen = useChatStore((s) => s.panelOpen);
  const togglePanel = useChatStore((s) => s.togglePanel);

  return (
    <footer className="border-border/60 bg-card/60 flex h-8 shrink-0 items-center justify-between gap-3 border-t px-3 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
        {/* "Open preview" detected-URL action, pinned leftmost as an icon-only
            button (the URL lives in the tooltip + aria-label) so it reads the
            same as the other status-bar icon buttons. */}
        {detectedBrowserUrl && onOpenPreview ? (
          <IconTooltip label={`Open ${detectedBrowserUrl} as a preview tab`} side="top">
            <button
              type="button"
              onClick={onOpenPreview}
              aria-label={`Open ${detectedBrowserUrl} as a preview tab`}
              className="text-muted-foreground hover:text-foreground flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-opacity hover:opacity-80"
            >
              <HugeiconsIcon icon={Globe02Icon} size={16} strokeWidth={1.75} className="shrink-0" />
            </button>
          </IconTooltip>
        ) : null}
        <OsBadge />
        <CwdBreadcrumb cwd={cwd} filePath={filePath} home={home} onCd={onCd} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {/* Update pill sits just left of the extension status icons (Discord,
            etc.) so the right cluster leads with the update prompt. */}
        <UpdaterPill />
        {/* Extension-contributed borderless icons (status items + compact
            panel toggles + movable sidebar-section toggles) cluster at the
            leftmost slot so the icon row stays visually unified, and a section's
            toggle keeps the same position as the other tree-panel toggles. */}
        <ExtensionStatusItems />
        <RightPanelCompactToggles />
        <SidebarSectionRightToggles />
        <ZoomIndicator />
        <SchedulerStatusPill />
        <AgentStatusPill onClick={onOpenMini} />
        {/* Default (non-compact) right-panel toggles sit with the other
            "open X" buttons so the icon row reads consistently. */}
        <RightPanelDefaultToggles />
        <ScmRightOpenButton />
        <AiOpenButton onToggle={togglePanel} active={panelOpen} />
      </div>
    </footer>
  );
}

export const StatusBar = memo(StatusBarInner);

function OsBadge() {
  const label = IS_WINDOWS ? "Windows" : IS_MAC ? "macOS" : IS_LINUX ? "Linux" : null;
  if (!label) return null;
  return (
    <span className="border-border bg-muted/40 text-muted-foreground inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-medium">
      {label}
    </span>
  );
}

/**
 * Source Control status-bar toggle. Shown whenever the user has opted in to the
 * right-panel SCM layout (and SCM is enabled); it stays in place whether open or
 * closed (clicking toggles, the open state shows as active) so the status-bar
 * row never reflows. Icon-only chrome matches `AiOpenButton` and the extension
 * panel toggles so the right cluster reads as a single row of glyphs.
 */
function ScmRightOpenButton() {
  const showSourceControl = usePreferencesStore((s) => s.showSourceControl);
  const sourceControlInRightPanel = usePreferencesStore((s) => s.sourceControlInRightPanel);
  const open = useScmRightPanelStore((s) => s.open);
  const toggle = useScmRightPanelStore((s) => s.toggle);
  if (!showSourceControl || !sourceControlInRightPanel) return null;
  return (
    <IconTooltip label={`${open ? "Close" : "Open"} Source Control`} side="top">
      <button
        type="button"
        onClick={toggle}
        aria-label={`${open ? "Close" : "Open"} Source Control`}
        aria-pressed={open}
        className={cn(
          "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors",
          open ? "text-foreground bg-accent/60" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <HugeiconsIcon icon={GitBranchIcon} size={16} strokeWidth={1.75} className="shrink-0" />
      </button>
    </IconTooltip>
  );
}
