import { IconTooltip } from "@/components/ui/icon-tooltip";
import { AlertCircleIcon, Download04Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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

  // Errors previously hid the pill, hiding the GitHub-unreachable case.
  // Now surface them so the user sees why.
  const visible =
    updater.state.kind === "available" ||
    updater.state.kind === "manual-available" ||
    updater.state.kind === "downloading" ||
    updater.state.kind === "ready" ||
    updater.state.kind === "error";

  // Render only the dialog (no pill) for transient states so `tedi --update`
  // can pop a status panel without leaving a permanent status-bar button.
  if (!visible) {
    return (
      <UpdaterDialog
        open={open}
        onOpenChange={setOpen}
        state={updater.state}
        onInstall={() => void updater.downloadAndInstall()}
        onRelaunch={() => void updater.relaunchApp()}
        onRetry={() => void updater.checkForUpdate()}
      />
    );
  }

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
      ? RefreshIcon
      : updater.state.kind === "error"
        ? AlertCircleIcon
        : Download04Icon;

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

  return (
    <>
      <IconTooltip label={label} side="top">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={label}
          className={`inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-[11px] font-medium shadow-sm transition-colors focus-visible:ring-2 focus-visible:outline-none ${pillClass}`}
        >
          <HugeiconsIcon icon={Icon} size={11} strokeWidth={1.75} className="shrink-0" />
          <span className="truncate">{pillLabel}</span>
        </button>
      </IconTooltip>
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
