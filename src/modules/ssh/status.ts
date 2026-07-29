// Lifecycle status of one SSH leaf. Owned by `useTerminalSession` and
// pushed to React via `onSshStatus` so the tab bar and status bar render
// without polling.

export type SshStatus =
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
