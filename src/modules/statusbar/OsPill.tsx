import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BrandIcon, type OsBrandName } from "@/components/BrandIcon";
import { useRemoteOs } from "@/modules/ssh/remoteOs";
import {
  hopDotClass,
  sshHopDetail,
  type SshHopState,
  type SshRouteHop,
} from "@/modules/ssh/status";
import { IS_LINUX, IS_MAC, IS_WINDOWS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { Server } from "lucide-react";

const HOP_STATE_LABEL: Record<SshHopState, string> = {
  pending: "not reached yet",
  up: "authenticated",
  failed: "did not connect",
};

const LOCAL_OS: { brand: OsBrandName; label: string } | null = IS_WINDOWS
  ? { brand: "windows", label: "Windows" }
  : IS_MAC
    ? { brand: "apple", label: "macOS" }
    : IS_LINUX
      ? { brand: "linux", label: "Linux" }
      : null;

type Props = {
  /** SFTP session id of the active leaf when it is a connected SSH pane. */
  sshSessionId?: number | null;
  /** ProxyJump chain of the active leaf, when it has one. */
  sshRoute?: SshRouteHop[];
  /** Name of the host the active leaf is on. Carries the identity of a DIRECT
   *  connection, which has no route to name it. */
  sshHostLabel?: string | null;
};

/**
 * "Which machine is the breadcrumb about", as one glyph: the OS logo of the
 * shell in the active pane - the local one, or the remote read off its
 * `/etc/os-release`.
 *
 * The chain this replaced spelled every hop out in the bar (`[laptop] >
 * bastion > user@target`), which on a jump route ate most of the width the
 * breadcrumb needed. All of it - hosts, ports, per-hop state - is in the
 * tooltip now; the logo keeps the one bit worth a glance, and takes the hop
 * colour so a stalled or broken connect still reads without hovering.
 */
export function OsPill({ sshSessionId, sshRoute, sshHostLabel }: Props) {
  const remote = useRemoteOs(sshSessionId ?? null);
  const isRemote = sshSessionId != null || !!sshRoute?.length;
  if (!isRemote && !LOCAL_OS) return null;

  const os = isRemote ? remote : LOCAL_OS;
  const label = os?.label ?? "Remote host";
  // The hop the user is waiting on / the one that broke, same as the chain
  // pill showed with its dots.
  const broken = sshRoute?.find((h) => h.state === "failed");
  const waitingOn = sshRoute?.find((h) => h.state === "pending");
  const tint = broken
    ? "text-icon-blocked"
    : waitingOn
      ? "text-icon-working animate-pulse"
      : "text-muted-foreground";
  const target = sshRoute?.find((h) => h.isTarget);
  const host = target ? sshHopDetail(target) : (sshHostLabel ?? null);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Bare glyph, no pill: the bar's other leading marks (the breadcrumb's
            folder, the branch, the remote server) are all unboxed 14px icons, so
            a bordered circle here read as a control you could press. The fixed
            box stays because the three brand marks differ in aspect and the row
            would otherwise shift when the active pane changes host. */}
        <span
          className="inline-flex size-4 shrink-0 cursor-default items-center justify-center"
          aria-label={host ? `${label} - ${host}` : label}
        >
          {os?.brand ? (
            <BrandIcon brand={os.brand} size={14} className={cn("shrink-0", tint)} />
          ) : (
            <Server size={14} strokeWidth={1.75} className={cn("shrink-0", tint)} />
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">
        <div className="flex flex-col gap-1 text-[11px]">
          <span>{label}</span>
          {sshRoute?.length ? (
            <>
              <span className="text-muted-foreground">
                {sshRoute.length - 1 === 1
                  ? "Through 1 jump host"
                  : `Through ${sshRoute.length - 1} jump hosts`}
              </span>
              {sshRoute.map((hop, i) => (
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
            </>
          ) : host ? (
            <span className="text-muted-foreground font-mono">{host}</span>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
