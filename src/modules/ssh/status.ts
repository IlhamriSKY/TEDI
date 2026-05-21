/// Lifecycle status of a single SSH leaf. Owned by `useTerminalSession`
/// and surfaced to React via `onSshStatus` so the tab bar (dot) and the
/// status bar (chip) can render without driving their own polling.

export type SshStatus =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | {
      kind: "connected";
      fingerprint: string;
      since: number;
      /**
       * Russh session id returned by `ssh_open` — addresses the live shell
       * channel AND any SFTP channels opened on the same handle. Only set
       * while connected; reconnects produce a fresh id.
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

/** Tailwind class for a small status dot. Reused by TabBar and StatusBar. */
export function statusDotClass(s: SshStatus): string {
  switch (statusTone(s)) {
    case "neutral":
      return "bg-muted-foreground/60";
    case "warn":
      return "bg-yellow-500 dark:bg-yellow-400";
    case "ok":
      return "bg-emerald-500 dark:bg-emerald-400";
    case "bad":
      return "bg-red-500 dark:bg-red-400";
  }
}

/** Tailwind `text-*` class for the SSH icon itself. Used on the cloud icon
 *  in the tab bar so the icon's colour carries the connection status — no
 *  separate dot overlay needed. Sky is the resting tint when there's no
 *  status yet (icon is rendered before the session settles). */
export function statusIconClass(s: SshStatus | undefined): string {
  if (!s) return "text-sky-600 dark:text-sky-400";
  switch (statusTone(s)) {
    case "neutral":
      return "text-sky-600 dark:text-sky-400";
    case "warn":
      return "text-yellow-600 dark:text-yellow-400 animate-pulse";
    case "ok":
      return "text-emerald-600 dark:text-emerald-400";
    case "bad":
      return "text-red-600 dark:text-red-400";
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

export function isLive(s: SshStatus): boolean {
  return s.kind === "connecting" || s.kind === "connected" || s.kind === "reconnecting";
}
