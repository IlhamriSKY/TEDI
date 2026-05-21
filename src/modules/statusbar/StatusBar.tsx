import { memo } from "react";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";
import { AiOpenButton } from "@/modules/ai/components/AiStatusBarControls";
import { useChatStore } from "@/modules/ai";
import { ExtensionStatusItems } from "@/modules/extensions";
import { SchedulerStatusPill } from "@/modules/scheduler";
import { UpdaterPill } from "@/modules/updater";
import { Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { IS_LINUX, IS_MAC, IS_WINDOWS } from "@/lib/platform";
import { CwdBreadcrumb } from "./CwdBreadcrumb";

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
};

// Memoised: callers pass useCallback-stable callbacks + primitive cwd / file
// path / detectedPreviewUrl, so the shallow equality check skips render
// whenever only unrelated parent state churned (tab open/close, OSC 7
// updates, AI streaming).
function StatusBarInner({
  cwd,
  filePath,
  home,
  onCd,
  onOpenMini,
  hasComposer,
  detectedPreviewUrl,
  onOpenPreview,
}: Props) {
  const panelOpen = useChatStore((s) => s.panelOpen);
  const openPanel = useChatStore((s) => s.openPanel);

  return (
    <footer className="border-border/60 bg-card/60 flex h-8 shrink-0 items-center justify-between gap-3 border-t px-3 text-[11px]">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate">
        <OsBadge />
        <CwdBreadcrumb cwd={cwd} filePath={filePath} home={home} onCd={onCd} />
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {/* Extension-contributed status icons, leftmost in the status
            cluster so they don't fight the AI / updater pills for
            primary attention. */}
        <ExtensionStatusItems />
        <SchedulerStatusPill />
        <UpdaterPill />
        {detectedPreviewUrl && onOpenPreview ? (
          <IconTooltip label={`Open ${detectedPreviewUrl} as a preview tab`} side="top">
            <button
              type="button"
              onClick={onOpenPreview}
              aria-label={`Open ${detectedPreviewUrl} as a preview tab`}
              className="border-border/70 bg-accent/40 text-foreground/90 hover:bg-accent hover:text-foreground flex h-6 max-w-64 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors"
            >
              <HugeiconsIcon
                icon={Globe02Icon}
                size={11}
                strokeWidth={1.75}
                className="text-muted-foreground shrink-0"
              />
              <span className="truncate">Open preview</span>
              <span className="text-muted-foreground truncate">
                {hostFromUrl(detectedPreviewUrl)}
              </span>
            </button>
          </IconTooltip>
        ) : null}
        <AgentStatusPill onClick={onOpenMini} />
        {!panelOpen || !hasComposer ? <AiOpenButton onOpen={openPanel} /> : null}
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

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
