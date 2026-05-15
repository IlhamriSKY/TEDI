/// Lifecycle status of a single SSH leaf. Owned by `useTerminalSession`
/// and surfaced to React via `onSshStatus` so the tab bar (dot) and the
/// status bar (chip) can render without driving their own polling.

export type SshStatus =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "connected"; fingerprint: string; since: number }
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
