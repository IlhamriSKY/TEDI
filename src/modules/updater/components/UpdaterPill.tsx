import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Download04Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import { useUpdater } from "../lib/useUpdater";
import { UpdaterDialog } from "./UpdaterDialog";

export function UpdaterPill() {
  const updater = useUpdater();
  const [open, setOpen] = useState(false);

  const visible =
    updater.state.kind === "available" ||
    updater.state.kind === "downloading" ||
    updater.state.kind === "ready";

  if (!visible) return null;

  const label =
    updater.state.kind === "ready"
      ? "Restart to apply update"
      : updater.state.kind === "downloading"
        ? `Downloading update ${formatProgress(updater.state.received, updater.state.total)}`
        : updater.state.kind === "available"
          ? `Update available · v${updater.state.version}`
          : "Update";

  const Icon =
    updater.state.kind === "ready" ? RefreshIcon : Download04Icon;

  return (
    <>
      <IconTooltip label={label} side="top">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={label}
          className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/35"
        >
          <HugeiconsIcon
            icon={Icon}
            size={11}
            strokeWidth={1.75}
            className="shrink-0 text-primary-foreground"
          />
          <span className="truncate">
            {updater.state.kind === "ready" ? "Restart" : "Update"}
          </span>
        </button>
      </IconTooltip>
      <UpdaterDialog
        open={open}
        onOpenChange={setOpen}
        state={updater.state}
        onInstall={() => void updater.downloadAndInstall()}
        onRelaunch={() => void updater.relaunchApp()}
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
