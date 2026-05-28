import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  CloudServerIcon,
  PencilEdit02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState } from "react";
import type { SshConnection } from "../connections";
import { statusDotClass, statusLabel, type SshStatus } from "../status";

type Props = {
  status: SshStatus;
  connection: SshConnection;
  onReconnect: () => void;
  onDisconnect: () => void;
  onEdit: () => void;
};

export function SshStatusPill({ status, connection, onReconnect, onDisconnect, onEdit }: Props) {
  const [open, setOpen] = useState(false);
  if (status.kind === "idle") return null;

  const dotClass = statusDotClass(status);
  const live =
    status.kind === "connecting" || status.kind === "connected" || status.kind === "reconnecting";
  const canReconnect =
    status.kind === "disconnected" || status.kind === "error" || status.kind === "connected"; // allow force-reconnect for fingerprint refresh
  const reason =
    status.kind === "disconnected"
      ? status.reason
      : status.kind === "error"
        ? status.message
        : status.kind === "reconnecting"
          ? status.reason
          : "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <IconTooltip label={statusLabel(status)} side="top">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`SSH ${connection.user}@${connection.host}: ${statusLabel(status)}`}
            className="border-border/70 bg-card text-foreground/90 hover:bg-accent hover:text-accent-foreground focus-visible:ring-primary/35 inline-flex h-6 max-w-56 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dotClass)} />
            <HugeiconsIcon
              icon={CloudServerIcon}
              size={11}
              strokeWidth={1.75}
              className="text-info shrink-0"
            />
            <span className="truncate font-medium">SSH</span>
            <span className="text-muted-foreground truncate">
              {connection.user}@{connection.host}
            </span>
            {status.kind === "reconnecting" ? (
              <span className="text-icon-working shrink-0">
                · {Math.round(status.nextDelayMs / 1000)}s
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
      </IconTooltip>
      <PopoverContent align="end" side="top" className="w-80 gap-2 p-3 text-xs">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 shrink-0 rounded-full", dotClass)} />
          <span className="font-semibold">{statusLabel(status)}</span>
        </div>
        <div className="text-muted-foreground grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <span>Name</span>
          <span className="text-foreground truncate">{connection.name}</span>
          <span>Host</span>
          <span className="text-foreground truncate font-mono">
            {connection.user}@{connection.host}:{connection.port}
          </span>
          {status.kind === "connected" ? (
            <>
              <span>Fingerprint</span>
              <span className="text-foreground truncate font-mono">
                {status.fingerprint || "-"}
              </span>
              <span>Since</span>
              <span className="text-foreground">{formatTime(status.since)}</span>
            </>
          ) : connection.lastFingerprint ? (
            <>
              <span>Last fingerprint</span>
              <span className="text-foreground truncate font-mono">
                {connection.lastFingerprint}
              </span>
            </>
          ) : null}
          {connection.lastConnectedAt ? (
            <>
              <span>Last connected</span>
              <span className="text-foreground">{formatRelative(connection.lastConnectedAt)}</span>
            </>
          ) : null}
          {reason ? (
            <>
              <span>Reason</span>
              <span className="text-foreground truncate">{reason}</span>
            </>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {canReconnect ? (
            <Button
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => {
                setOpen(false);
                onReconnect();
              }}
            >
              <HugeiconsIcon icon={RefreshIcon} size={12} strokeWidth={2} />
              {status.kind === "connected" ? "Reconnect" : "Reconnect now"}
            </Button>
          ) : null}
          {live ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 px-2 text-[11px]"
              onClick={() => {
                setOpen(false);
                onDisconnect();
              }}
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
              Disconnect
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-[11px]"
            onClick={() => {
              setOpen(false);
              onEdit();
            }}
          >
            <HugeiconsIcon icon={PencilEdit02Icon} size={12} strokeWidth={2} />
            Edit connection
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function formatTime(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return "-";
  }
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  try {
    return new Date(ms).toLocaleDateString();
  } catch {
    return `${days}d ago`;
  }
}
