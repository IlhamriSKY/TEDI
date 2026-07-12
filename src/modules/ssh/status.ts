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
