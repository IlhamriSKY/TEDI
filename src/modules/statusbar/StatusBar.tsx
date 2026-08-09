import { memo } from "react";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";
import { AiOpenButton } from "@/modules/ai/components/AiStatusBarControls";
import { useChatStore } from "@/modules/ai";
import {
  BuiltinSectionRightToggles,
  ExtensionStatusItems,
  RightPanelActionToggles,
  RightPanelCompactToggles,
  RightPanelDefaultToggles,
  SidebarSectionRightToggles,
} from "@/modules/extensions";
import { SchedulerStatusPill } from "@/modules/scheduler";
import { useScmRightPanelStore } from "@/modules/scm/scmRightPanelStore";
import { useSshRightPanelStore } from "@/modules/ssh/sshRightPanelStore";
import { SshRoutePill } from "@/modules/ssh/SshRoutePill";
import type { SshRouteHop } from "@/modules/ssh/status";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setStatusBarCompact } from "@/modules/settings/store";
import { UpdaterPill } from "@/modules/updater";
import { cn } from "@/lib/utils";
import { IS_LINUX, IS_MAC, IS_WINDOWS } from "@/lib/platform";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { ZoomControl } from "./ZoomControl";
import { Eye, EyeOff, GitBranch, Server } from "lucide-react";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onOpenMini: () => void;
  /** Whether any SSH leaf is connected. Gates the right-slot Remote toggle so
   *  it appears only alongside a live session, mirroring the left sidebar. */
  hasAnySshLeaf: boolean;
  /** True when the ACTIVE pane is a live SSH session. Hides the local-OS badge,
   *  which would otherwise misrepresent the remote shell the breadcrumb points at. */
  activeIsSsh?: boolean;
  /** SFTP session id of the active SSH leaf (set only when `activeIsSsh`). Lets
   *  the breadcrumb browse subfolders remotely instead of hitting the local
   *  filesystem with a remote path. */
  sshSessionId?: number | null;
  /** ProxyJump chain of the active SSH leaf, when it has one. Takes the slot
   *  the local-OS badge vacates on an SSH pane, which is the honest thing to
   *  put there: what this shell is actually reached through. */
  sshRoute?: SshRouteHop[];
};

/** One status-bar group. The hairline that separates it from the group before
 *  it is drawn by `.sb-group` in globals.css, which hides an empty group and
 *  only gives a group its divider when a non-empty one precedes it - so a group
 *  whose children all render null (zoom at 100%, no extension items, agent
 *  idle) never leaves a dangling line behind. */
function Group({ children }: { children: React.ReactNode }) {
  return <div className="sb-group flex shrink-0 items-center gap-1.5">{children}</div>;
}

// Memoized. Callbacks are stable and props are primitives, so shallow equality
// skips re-render on unrelated parent updates.
function StatusBarInner({
  cwd,
  filePath,
  home,
  onCd,
  onOpenMini,
  hasAnySshLeaf,
  activeIsSsh,
  sshSessionId,
  sshRoute,
}: Props) {
  const panelOpen = useChatStore((s) => s.panelOpen);
  const togglePanel = useChatStore((s) => s.togglePanel);
  const compact = usePreferencesStore((s) => s.statusBarCompact);

  return (
    <footer className="border-border/60 bg-card/60 flex h-8 shrink-0 items-center justify-between gap-3 border-t px-3 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
        {/* One slot, two readings of "where am I". A jump chain wins whenever
            there is one - deliberately NOT gated on `activeIsSsh`, which is
            only true once the session is fully connected: the route is most
            worth showing while the chain is still coming up, and afterwards if
            it broke. Otherwise the local-OS badge, except on a connected SSH
            pane where it would misdescribe the remote shell the breadcrumb
            points at. A direct connection has no route, so that case is
            unchanged: an empty slot. */}
        {sshRoute?.length ? <SshRoutePill route={sshRoute} /> : activeIsSsh ? null : <OsBadge />}
        <CwdBreadcrumb
          cwd={cwd}
          filePath={filePath}
          home={home}
          onCd={onCd}
          sshSessionId={sshSessionId}
        />
      </div>
      {/* Left to right: the update prompt, the zoom pill, things you READ, then
          things you CLICK (actions first, panel toggles after). Zoom sits ahead
          of the AI usage meters rather than with the other actions: it is only
          on screen while zoomed, and that is where it is wanted. Compact mode
          keeps only what you glance at - the update prompt, the AI meters and
          the AI panel - and folds the rest away. */}
      <div className="flex shrink-0 items-center gap-1.5">
        {/* 1. Update. Leftmost and alone: it is the one thing here that asks
            something of you, and it is absent the rest of the time. */}
        <Group>
          <UpdaterPill />
        </Group>

        {/* 2. Zoom, immediately left of the AI usage meters. Its own group so
            the hairline keeps it off them; it renders null at 100%, and
            `.sb-group:empty` drops the divider with it. */}
        {compact ? null : (
          <Group>
            <ZoomControl />
          </Group>
        )}

        {/* 3. Status: read-only readouts. The agent pill leads (a pending
            approval or an error has to read first), then the AI usage meters,
            Discord, Remote Access and the scheduler. */}
        <Group>
          <AgentStatusPill onClick={onOpenMini} />
          <ExtensionStatusItems kind="status" metersOnly={compact} />
          {compact ? null : <SchedulerStatusPill />}
        </Group>

        {/* 4a. Actions: a click does the thing, nothing slides out. */}
        {compact ? null : (
          <Group>
            <ExtensionStatusItems kind="action" />
            <RightPanelActionToggles />
          </Group>
        )}

        {/* 4b. Panel triggers: a click opens (or closes) a side panel. Always
            has content (the AI button), so it always carries the last divider
            when anything precedes it. */}
        <Group>
          {compact ? null : (
            <>
              <RightPanelCompactToggles />
              <SidebarSectionRightToggles />
              <BuiltinSectionRightToggles />
              <RightPanelDefaultToggles />
              <ScmRightOpenButton />
              <SshRightOpenButton hasAnySshLeaf={hasAnySshLeaf} />
            </>
          )}
          <AiOpenButton onToggle={togglePanel} active={panelOpen} />
          <CompactToggle compact={compact} />
        </Group>
      </div>
    </footer>
  );
}

export const StatusBar = memo(StatusBarInner);

/**
 * Folds the status bar down to the update prompt, the AI meters and the AI
 * panel button. Sits at the far right so the groups it hides collapse away from
 * it, and the button itself never moves.
 */
function CompactToggle({ compact }: { compact: boolean }) {
  const label = compact ? "Show all status bar items" : "Compact status bar";
  const Icon = compact ? Eye : EyeOff;
  return (
    <IconTooltip label={label} side="top">
      <button
        type="button"
        onClick={() => void setStatusBarCompact(!compact)}
        aria-label={label}
        aria-pressed={compact}
        className="text-muted-foreground hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors"
      >
        <Icon size={15} strokeWidth={1.75} className="shrink-0" />
      </button>
    </IconTooltip>
  );
}

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
        <GitBranch size={16} strokeWidth={1.75} className="shrink-0" />
      </button>
    </IconTooltip>
  );
}

/**
 * SSH (Remote) status-bar toggle. Mirrors `ScmRightOpenButton`: shown whenever
 * the user has docked the Remote explorer to the right AND a session is live
 * (the left sidebar hides SSH the same way when no leaf is connected). Clicking
 * toggles the right-slot panel; the open state shows as active.
 */
function SshRightOpenButton({ hasAnySshLeaf }: { hasAnySshLeaf: boolean }) {
  const sshInRightPanel = usePreferencesStore((s) => s.sshInRightPanel);
  const open = useSshRightPanelStore((s) => s.open);
  const toggle = useSshRightPanelStore((s) => s.toggle);
  if (!sshInRightPanel || !hasAnySshLeaf) return null;
  return (
    <IconTooltip label={`${open ? "Close" : "Open"} Remote`} side="top">
      <button
        type="button"
        onClick={toggle}
        aria-label={`${open ? "Close" : "Open"} Remote`}
        aria-pressed={open}
        className={cn(
          "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors",
          open ? "text-foreground bg-accent/60" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Server size={16} strokeWidth={1.75} className="shrink-0" />
      </button>
    </IconTooltip>
  );
}
