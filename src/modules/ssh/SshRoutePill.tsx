import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  hopDotClass,
  sshHopDetail,
  sshHopLabel,
  type SshHopState,
  type SshRouteHop,
} from "./status";
import { ChevronRight, Laptop } from "lucide-react";

const HOP_STATE_LABEL: Record<SshHopState, string> = {
  pending: "not reached yet",
  up: "authenticated",
  failed: "did not connect",
};

/**
 * The path a chained SSH session actually takes, as a status-bar pill:
 * `[this PC] > bastion > prod-db`, one dot per hop, coloured by how far the
 * handshake got.
 *
 * Before this, a ProxyJump chain was invisible unless you read the terminal
 * scrollback: you picked "prod-db" with no indication that it is reached
 * through a bastion, and a failure named a host you never chose. Only chained
 * sessions render - `route` is null for a direct connection (see
 * `SshRouteHop`), so an ordinary session gets no extra chrome.
 */

export function SshRoutePill({ route }: { route: SshRouteHop[] | undefined }) {
  if (!route || route.length === 0) return null;

  // The hop the user is waiting on: the first that has not come up. Named in
  // the tooltip so a stalled connect says which link it is stuck at.
  const waitingOn = route.find((h) => h.state === "pending");
  const broken = route.find((h) => h.state === "failed");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="border-border bg-muted/40 text-muted-foreground inline-flex h-5 shrink-0 cursor-default items-center gap-1 rounded-full border pr-2 pl-1.5 text-[11px] font-medium"
          aria-label={`SSH route: ${route.map(sshHopDetail).join(" via ")}`}
        >
          <Laptop size={11} strokeWidth={1.75} className="shrink-0 opacity-70" />
          {route.map((hop, i) => (
            <span key={`${hop.host}-${i}`} className="inline-flex items-center gap-1">
              <ChevronRight size={10} strokeWidth={2} className="shrink-0 opacity-50" />
              <span
                aria-hidden
                className={cn("size-1.5 shrink-0 rounded-full", hopDotClass(hop.state))}
              />
              {/* Jump hosts drop the user and show the host alone; only the
                  target is worth the full `user@host` in a status bar. Ports
                  and per-hop state are in the tooltip - a three-hop chain
                  spelled out in full would crowd out the breadcrumb. */}
              <span className={cn("max-w-40 truncate", hop.isTarget && "text-foreground")}>
                {hop.isTarget ? sshHopLabel(hop) : hop.host}
              </span>
            </span>
          ))}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="flex flex-col gap-1 text-[11px]">
          <span className="text-muted-foreground">
            {route.length - 1 === 1
              ? "Through 1 jump host"
              : `Through ${route.length - 1} jump hosts`}
          </span>
          {route.map((hop, i) => (
            <span key={`${hop.host}-${i}`} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn("size-1.5 shrink-0 rounded-full", hopDotClass(hop.state))}
              />
              <span className="font-mono">{sshHopDetail(hop)}</span>
              <span className="text-muted-foreground">
                {hop.isTarget ? "· target" : "· jump"} · {HOP_STATE_LABEL[hop.state]}
              </span>
            </span>
          ))}
          {broken ? (
            <span className="text-destructive">Stopped at {sshHopDetail(broken)}</span>
          ) : waitingOn ? (
            <span className="text-muted-foreground">Waiting on {sshHopDetail(waitingOn)}…</span>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
