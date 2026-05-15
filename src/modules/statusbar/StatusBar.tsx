import { IconTooltip } from "@/components/ui/icon-tooltip";
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";
import { AiOpenButton } from "@/modules/ai/components/AiStatusBarControls";
import { useChatStore } from "@/modules/ai";
import { UpdaterPill } from "@/modules/updater";
import { Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { IS_LINUX, IS_MAC, IS_WINDOWS } from "@/lib/platform";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { SshStatusPill } from "@/modules/ssh/components/SshStatusPill";
import type { SshConnection } from "@/modules/ssh/connections";
import type { SshStatus } from "@/modules/ssh/status";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onOpenMini: () => void;
  /** Only rendered when the AI panel is open and a key is loaded. */
  hasComposer: boolean;
  /** When set, render a one-click "Open preview" chip pointing at this URL. */
  detectedPreviewUrl?: string | null;
  onOpenPreview?: () => void;
  /**
   * When the active leaf is an SSH terminal, both `sshStatus` and
   * `sshConnection` are passed in and the status chip renders next to the
   * updater pill. Untouched for local terminal / editor / preview tabs.
   */
  sshStatus?: SshStatus | null;
  sshConnection?: SshConnection | null;
  onSshReconnect?: () => void;
  onSshDisconnect?: () => void;
  onSshEdit?: () => void;
};

export function StatusBar({
  cwd,
  filePath,
  home,
  onCd,
  onOpenMini,
  hasComposer,
  detectedPreviewUrl,
  onOpenPreview,
  sshStatus,
  sshConnection,
  onSshReconnect,
  onSshDisconnect,
  onSshEdit,
}: Props) {
  const panelOpen = useChatStore((s) => s.panelOpen);
  const openPanel = useChatStore((s) => s.openPanel);

  return (
    <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/60 px-3 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
        <OsBadge />
        <CwdBreadcrumb cwd={cwd} filePath={filePath} home={home} onCd={onCd} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {sshStatus && sshConnection && onSshReconnect && onSshDisconnect && onSshEdit ? (
          <SshStatusPill
            status={sshStatus}
            connection={sshConnection}
            onReconnect={onSshReconnect}
            onDisconnect={onSshDisconnect}
            onEdit={onSshEdit}
          />
        ) : null}
        <UpdaterPill />
        {detectedPreviewUrl && onOpenPreview ? (
          <IconTooltip
            label={`Open ${detectedPreviewUrl} as a preview tab`}
            side="top"
          >
            <button
              type="button"
              onClick={onOpenPreview}
              aria-label={`Open ${detectedPreviewUrl} as a preview tab`}
              className="flex h-6 max-w-64 cursor-pointer items-center gap-1.5 rounded-md border border-border/70 bg-accent/40 px-2 text-[11px] text-foreground/90 transition-colors hover:bg-accent hover:text-foreground"
            >
              <HugeiconsIcon
                icon={Globe02Icon}
                size={11}
                strokeWidth={1.75}
                className="shrink-0 text-muted-foreground"
              />
              <span className="truncate">Open preview</span>
              <span className="truncate text-muted-foreground">
                {hostFromUrl(detectedPreviewUrl)}
              </span>
            </button>
          </IconTooltip>
        ) : null}
        <AgentStatusPill onClick={onOpenMini} />
        {!panelOpen || !hasComposer ? (
          <AiOpenButton onOpen={openPanel} />
        ) : null}
      </div>
    </footer>
  );
}

function OsBadge() {
  const label = IS_WINDOWS
    ? "Windows"
    : IS_MAC
      ? "macOS"
      : IS_LINUX
        ? "Linux"
        : null;
  if (!label) return null;
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border bg-muted/40 px-2 text-[11px] font-medium text-muted-foreground">
      {label}
    </span>
  );
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
