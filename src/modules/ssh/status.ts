// Lifecycle status of one SSH leaf. Owned by `useTerminalSession` and
// pushed to React via `onSshStatus` so the tab bar and status bar render
// without polling.

/**
 * How far the handshake has got with one host in the chain.
 * `pending` = not dialled yet, `up` = authenticated, `failed` = the attempt
 * died at or before this hop.
 */
export type SshHopState = "pending" | "up" | "failed";

/**
 * One host on the way to the target, in CONNECT order (the publicly reachable
 * entry host first, the target last). A chained connect is otherwise invisible
 * until it fails: the user picks "prod-db" and has no way to see that it is
 * reached through a bastion, or which link of the chain is the one that broke.
 */
export type SshRouteHop = {
  user: string;
  host: string;
  port: number;
  state: SshHopState;
  /** The host the user actually picked; every earlier hop is a jump. */
  isTarget: boolean;
};

/** `user@host`. What the status bar names the target with. */
export const sshHopLabel = (h: SshRouteHop): string => `${h.user}@${h.host}`;
/** `user@host:port`. What tooltips and the tab hover card spell out. */
export const sshHopDetail = (h: SshRouteHop): string => `${h.user}@${h.host}:${h.port}`;

type SshStatusKind =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | {
      kind: "connected";
      fingerprint: string;
      since: number;
      /**
       * Russh session id from `ssh_open`. Identifies the shell channel
       * and any SFTP channels on the same handle. Reconnects mint a new id.
       */
      sessionId: number;
    }
  | {
      kind: "reconnecting";
      attempt: number;
      nextDelayMs: number;
      reason: string;
    }
  | { kind: "disconnected"; reason: string; canRetry: boolean }
  | { kind: "error"; message: string; canRetry: boolean };

/**
 * The route rides on the status rather than in a store of its own: it changes
 * with the connection and every surface that renders SSH state (tab bar, pane
 * tree, status bar) already receives this object, so no new plumbing is needed.
 * Intersected rather than repeated per variant - narrowing on `kind` still
 * works, and no emit site has to remember to carry it.
 *
 * Absent on a direct connection: a single-hop route is not a route, and drawing
 * a one-item chain would be noise on every ordinary session.
 */
export type SshStatus = SshStatusKind & { route?: SshRouteHop[] };

/** One host as `buildSshRoute` needs it, shared by `SshJumpHop` and a connection. */
type RouteEndpoint = { user: string; host: string; port: number };

/**
 * Build the route for one connect attempt: the jump hosts in connect order
 * (entry first), then the target, all `pending`.
 *
 * Returns null when there are no jumps. A direct connection is a single host,
 * and rendering a one-item "chain" would put chrome on every ordinary session
 * to say nothing.
 */
export function buildSshRoute(
  jumps: readonly RouteEndpoint[],
  target: RouteEndpoint,
): SshRouteHop[] | null {
  if (jumps.length === 0) return null;
  const hop = (e: RouteEndpoint, isTarget: boolean): SshRouteHop => ({
    user: e.user,
    host: e.host,
    port: e.port,
    state: "pending",
    isTarget,
  });
  return [...jumps.map((j) => hop(j, false)), hop(target, true)];
}

/**
 * Set one hop's state. Returns the SAME array reference when nothing changed,
 * so callers can skip a re-render; a new array otherwise, because the route is
 * handed to React inside the status object and an in-place edit would not
 * repaint. An out-of-range index is a no-op rather than a throw: it means a hop
 * reported that is not in this attempt's chain, which is not worth killing a
 * live session over.
 */
export function markSshHop(route: SshRouteHop[], index: number, state: SshHopState): SshRouteHop[] {
  if (index < 0 || index >= route.length) return route;
  if (route[index].state === state) return route;
  return route.map((h, i) => (i === index ? { ...h, state } : h));
}

/**
 * Tailwind `bg-*` for a hop's dot. Lives here beside `statusLabelClass` so the
 * status-bar pill and the tab hover card cannot drift apart on what amber,
 * green and red mean - they render the same chain from the same data.
 */
export function hopDotClass(state: SshHopState): string {
  switch (state) {
    case "pending":
      return "bg-icon-working animate-pulse";
    case "up":
      return "bg-icon-idle";
    case "failed":
      return "bg-icon-blocked";
  }
}

/** Every hop up - what a live shell channel proves about the whole chain. */
export function allSshHopsUp(route: SshRouteHop[]): SshRouteHop[] {
  return route.every((h) => h.state === "up") ? route : route.map((h) => ({ ...h, state: "up" }));
}

/**
 * Mark every hop that never came up as failed. Called when an attempt dies: the
 * first hop still pending is where the chain broke, and leaving them all
 * `pending` would say nothing about where it stopped. Hops already `up` keep
 * that state, so the indicator shows how FAR it got, not just that it failed.
 */
export function failPendingSshHops(route: SshRouteHop[]): SshRouteHop[] {
  if (!route.some((h) => h.state === "pending")) return route;
  return route.map((h) => (h.state === "pending" ? { ...h, state: "failed" } : h));
}

/**
 * How a SAVED connection stands across every terminal leaf that uses it,
 * collapsed from the per-leaf statuses above.
 *
 * Remote editor leaves bind to the profile rather than to a leaf or a session
 * number (the only id that survives a restart), and read their live session
 * from here. "No entry at all" means no terminal is open for that host.
 */
export type SshConnectionBinding = {
  /** Live russh session, set once some leaf for this profile is connected. */
  sessionId?: number;
  /** A leaf for this profile is on its way up (idle, connecting, retrying).
   *  Distinguishes "wait a moment" from "this needs you to reconnect". */
  connecting: boolean;
};

/**
 * Fold one more terminal leaf's status into a connection's binding.
 *
 * The rules, in order: a connected leaf wins outright and is never displaced (so
 * two terminals on the same host settle on one session instead of flapping); a
 * leaf that has actually FAILED leaves the connection promptable, which is what
 * puts a Reconnect button on a waiting remote editor; anything else - idle,
 * handshaking, retrying, or not having reported yet - counts as on its way up,
 * so a restored workspace does not flash "not connected" during startup before
 * its terminals have even emitted a first status.
 */
export function foldSshBinding(
  prev: SshConnectionBinding | undefined,
  status: SshStatus | undefined,
): SshConnectionBinding {
  if (prev?.sessionId !== undefined) return prev;
  if (status?.kind === "connected") return { sessionId: status.sessionId, connecting: false };
  if (status?.kind === "error" || status?.kind === "disconnected") {
    return { connecting: prev?.connecting ?? false };
  }
  return { connecting: true };
}

export type SshStatusDotTone = "neutral" | "warn" | "ok" | "bad";

export function statusTone(s: SshStatus): SshStatusDotTone {
  switch (s.kind) {
    case "idle":
      return "neutral";
    case "connecting":
    case "reconnecting":
      return "warn";
    case "connected":
      return "ok";
    case "disconnected":
    case "error":
      return "bad";
  }
}

/** Tailwind `text-*` class for the SSH tab title text. Carries the status
 *  on the label. `connecting` / `reconnecting` pulse for visibility.
 *  Returns "" for idle/unknown so the label inherits the tab's default
 *  colour. */
export function statusLabelClass(s: SshStatus | undefined): string {
  if (!s) return "";
  switch (statusTone(s)) {
    case "neutral":
      return "";
    case "warn":
      return "text-icon-working animate-pulse";
    case "ok":
      return "text-icon-idle";
    case "bad":
      return "text-icon-blocked";
  }
}

export function statusLabel(s: SshStatus): string {
  switch (s.kind) {
    case "idle":
      return "Idle";
    case "connecting":
      return s.attempt > 1 ? `Connecting (attempt ${s.attempt})…` : "Connecting…";
    case "connected":
      return "Connected";
    case "reconnecting":
      return `Reconnecting in ${Math.round(s.nextDelayMs / 1000)}s (${s.attempt}/3)…`;
    case "disconnected":
      return `Disconnected${s.reason ? ` · ${s.reason}` : ""}`;
    case "error":
      return `Error · ${s.message}`;
  }
}
