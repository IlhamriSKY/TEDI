import { Fragment, useEffect, useRef, useState } from "react";
import { useSshHosts } from "./connections";
import type { SshHopState, SshStatus } from "./status";
import { cn } from "@/lib/utils";
import { Laptop, Server } from "lucide-react";

/**
 * What a connecting SSH pane shows instead of three dim banner lines.
 *
 * The chain is the animation: one node per host in connect order, the segment
 * the handshake is currently working on carrying a travelling pulse, and each
 * node going green as that hop authenticates. On a jump chain that is the only
 * place the user can watch WHERE the connect is - a stall at the bastion and a
 * stall at the target look identical in the terminal's scrollback.
 *
 * Purely decorative: `pointer-events-none` throughout, so the terminal
 * underneath keeps every click, selection and file-drop hit test it had. The
 * `[tedi] connecting to …` banner still goes to the terminal, unchanged, and is
 * what remains in the scrollback afterwards.
 */

type Props = {
  /** Live status of this leaf, or null for a local pane. */
  status: SshStatus | null;
  /** Saved connection the leaf opened, for its name / host / auth mode. */
  connectionId?: string;
};

/** How long the green "Connected" card stays up before it fades out. */
const DONE_MS = 550;

const AUTH_LABEL = {
  password: "password auth",
  key: "key auth",
  agent: "agent auth",
} as const;

type Node = {
  host: string;
  state: SshHopState;
  /** The machine TEDI runs on, drawn with a laptop rather than a server. */
  isLocal?: boolean;
};

export function SshConnectOverlay({ status, connectionId }: Props) {
  const hosts = useSshHosts();
  const kind = status?.kind;
  const connecting = kind === "connecting" || kind === "reconnecting";

  // Hold the card for a beat on success so the chain is seen completing,
  // instead of vanishing the instant the shell channel opens. Gated on having
  // actually been connecting, so re-emitting a stored `connected` status (a tab
  // switch re-attaching a live session) never flashes a card.
  const wasConnecting = useRef(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (connecting) {
      wasConnecting.current = true;
      return;
    }
    if (kind !== "connected" || !wasConnecting.current) return;
    wasConnecting.current = false;
    setDone(true);
    const t = window.setTimeout(() => setDone(false), DONE_MS);
    return () => window.clearTimeout(t);
  }, [kind, connecting]);

  if (!connecting && !done) return null;

  const conn = connectionId ? hosts.get(connectionId) : undefined;
  const route = status?.route;
  // A direct connection has no route (see `buildSshRoute`), so draw the one hop
  // it does have: this PC to the target.
  const hops: Node[] = route?.length
    ? route.map((h) => ({ host: h.host, state: done ? "up" : h.state }))
    : [{ host: conn?.host ?? "remote host", state: done ? "up" : "pending" }];
  const nodes: Node[] = [{ host: "This PC", state: "up", isLocal: true }, ...hops];

  const target = route?.find((h) => h.isTarget);
  const targetLabel = target
    ? `${target.user}@${target.host}:${target.port}`
    : conn
      ? `${conn.user}@${conn.host}:${conn.port}`
      : "";
  const title = done
    ? "Connected"
    : kind === "reconnecting"
      ? "Reconnecting…"
      : `Connecting to ${conn?.name || conn?.host || "remote host"}`;

  return (
    <div
      className={cn(
        "bg-background/70 pointer-events-none absolute inset-0 z-10 flex items-center justify-center backdrop-blur-[2px]",
        done ? "animate-out fade-out-0 duration-500" : "animate-in fade-in-0 duration-200",
      )}
      // The pane already announces its state through the tab dot and the status
      // bar; this is the same information drawn large, so it stays out of the
      // a11y tree rather than double-announcing it on every reconnect.
      aria-hidden
    >
      <div className="border-border bg-popover text-popover-foreground flex w-[min(26rem,92%)] flex-col items-center gap-4 rounded-lg border px-4 py-5 shadow-lg">
        {/* The chain sizes itself to the pane: nodes and segments share the row
            and shrink past their natural width, so a five-hop chain in a narrow
            split still draws as a chain (with truncated labels) instead of
            spilling out of the card. */}
        <div className="flex w-full items-start justify-center">
          {nodes.map((node, i) => (
            <Fragment key={`${node.host}-${i}`}>
              {i > 0 ? <Segment from={nodes[i - 1]} to={node} /> : null}
              <div className="flex max-w-20 min-w-0 flex-1 flex-col items-center gap-1.5">
                <span
                  className={cn(
                    "border-border bg-muted/40 flex size-8 items-center justify-center rounded-full border",
                    node.state === "pending" && "animate-pulse",
                  )}
                >
                  {node.isLocal ? (
                    <Laptop size={14} strokeWidth={1.75} className="text-muted-foreground" />
                  ) : (
                    <Server size={14} strokeWidth={1.75} className={STATE_TEXT[node.state]} />
                  )}
                </span>
                <span className="text-muted-foreground w-full truncate text-center text-[10px]">
                  {node.host}
                </span>
              </div>
            </Fragment>
          ))}
        </div>

        <div className="flex flex-col items-center gap-1 text-center">
          <span className={cn("text-xs font-medium", done ? "text-icon-idle" : "text-foreground")}>
            {title}
          </span>
          {targetLabel ? (
            <span className="text-muted-foreground font-mono text-[11px]">{targetLabel}</span>
          ) : null}
          {status?.kind === "reconnecting" ? (
            <span className="text-muted-foreground text-[11px]">
              {status.reason} · attempt {status.attempt}
            </span>
          ) : conn ? (
            <span className="text-muted-foreground text-[11px]">
              {AUTH_LABEL[conn.authMode]}
              {status?.kind === "connecting" && status.attempt > 1
                ? ` · attempt ${status.attempt}`
                : ""}
            </span>
          ) : null}
        </div>

        {/* The wait before the next attempt, drained by the same keyframe the
            toast countdown uses - the delay is known up front, so the bar needs
            no timer of its own. */}
        {status?.kind === "reconnecting" ? (
          <span className="bg-muted h-px w-40 overflow-hidden">
            <span
              className="bg-icon-working block h-full w-full origin-left"
              style={{ animation: `tedi-toast-drain ${status.nextDelayMs}ms linear forwards` }}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** The wire between two nodes. Solid once the hop on its right is up, pulsing
 *  while that hop is the one being dialled, dim beyond a break. */
function Segment({ from, to }: { from: Node; to: Node }) {
  const active = from.state === "up" && to.state === "pending";
  return (
    <span
      className={cn(
        "relative mt-4 block h-px max-w-8 min-w-2 flex-1 overflow-hidden",
        to.state === "up"
          ? "bg-icon-idle"
          : to.state === "failed"
            ? "bg-icon-blocked"
            : "bg-border",
      )}
    >
      {active ? (
        <span className="animate-ssh-hop-flow via-icon-working absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent to-transparent" />
      ) : null}
    </span>
  );
}

/** The `text-*` twin of `hopDotClass`: same three colours, on an icon instead
 *  of a dot. A `Record` rather than a switch so a new hop state fails to
 *  compile here too. */
const STATE_TEXT: Record<SshHopState, string> = {
  pending: "text-icon-working",
  up: "text-icon-idle",
  failed: "text-icon-blocked",
};
