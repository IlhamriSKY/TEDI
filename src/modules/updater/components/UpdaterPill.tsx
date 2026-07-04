import { IconTooltip } from "@/components/ui/icon-tooltip";
import { formatBytes } from "@/lib/format";
import { CircleAlert, Download, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useUpdater } from "../lib/useUpdater";
import { UpdaterDialog } from "./UpdaterDialog";

export function UpdaterPill() {
  const updater = useUpdater();
  const [open, setOpen] = useState(false);

  // `tedi --update` (and its single-instance forward) bumps `forceOpenSeq`.
  // Mirror into local open flag so the dialog pops.
  useEffect(() => {
    if (updater.forceOpenSeq > 0) setOpen(true);
  }, [updater.forceOpenSeq]);

  // Surface the pill for the error state too, so an explicit check that fails
  // (`tedi --update`, the trigger event, the dialog's Retry) tells the user why.
  // Background sweeps that fail no longer reach `error` (see useUpdater's silent
  // flag), so an unreachable GitHub at launch never lights up the red pill.
  const visible =
    updater.state.kind === "available" ||
    updater.state.kind === "manual-available" ||
    updater.state.kind === "downloading" ||
    updater.state.kind === "ready" ||
    updater.state.kind === "error";

  const label =
    updater.state.kind === "ready"
      ? "Restart to apply update"
      : updater.state.kind === "downloading"
        ? `Downloading update ${formatProgress(updater.state.received, updater.state.total)}`
        : updater.state.kind === "available"
          ? `Update available · v${updater.state.version}`
          : updater.state.kind === "manual-available"
            ? `Update available · v${updater.state.version}`
            : updater.state.kind === "error"
              ? `Update check failed: ${updater.state.message}`
              : "Update";

  const Icon =
    updater.state.kind === "ready"
      ? RefreshCw
      : updater.state.kind === "error"
        ? CircleAlert
        : Download;

  const isError = updater.state.kind === "error";
  const pillClass = isError
    ? "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/35"
    : "bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-primary/35";
  const pillLabel =
    updater.state.kind === "ready"
      ? "Restart"
      : updater.state.kind === "error"
        ? "Update check failed"
        : updater.state.kind === "downloading"
          ? // Inline the % so the pill shows progress; tooltip has the long form.
            `Updating ${formatProgress(updater.state.received, updater.state.total)}`
          : "Update";

  // The dialog must keep a single, stable position in the tree. Rendering it
  // from two different return branches (pill vs. no-pill) made the modal
  // unmount + remount whenever the updater state flipped visibility - e.g.
  // Retry drives error → checking → error - and the remount race left Radix's
  // scroll-lock with `pointer-events: none` stuck on the body, so the modal
  // could no longer be clicked or closed. Toggle only the pill button; the
  // dialog stays mounted in place for every state (incl. `tedi --update`,
  // which pops it without a pill).
  return (
    <>
      {visible && (
        <IconTooltip label={label} side="top">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={label}
            className={`inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium shadow-sm transition-colors focus-visible:ring-2 focus-visible:outline-none ${pillClass}`}
          >
            <Icon size={11} strokeWidth={1.75} className="shrink-0" />
            <span className="truncate">{pillLabel}</span>
          </button>
        </IconTooltip>
      )}
      <UpdaterDialog
        open={open}
        onOpenChange={setOpen}
        state={updater.state}
        onInstall={() => void updater.downloadAndInstall()}
        onRelaunch={() => void updater.relaunchApp()}
        onRetry={() => void updater.checkForUpdate()}
      />
    </>
  );
}

function formatProgress(received: number, total: number | null): string {
  if (!total || total <= 0) return formatBytes(received);
  const pct = Math.min(100, Math.floor((received / total) * 100));
  return `${pct}%`;
}
