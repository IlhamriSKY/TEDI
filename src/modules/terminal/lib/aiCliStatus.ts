/// Runtime status of a known AI CLI tool running inside a terminal leaf.
/// Owned by `useTerminalSession` and surfaced to React via `onAiCliStatus`
/// so the tab bar (text chip + toast + beep) can render without driving
/// its own polling. Mirrors the `SshStatus` shape used for SSH tabs.

export type AiCliKind =
  | "claude"
  | "codex"
  | "opencode"
  | "copilot"
  | "pi"
  | "aider"
  | "gemini"
  | "amazon-q"
  | "cody"
  | "goose"
  | "cursor"
  | "ollama";

export type AiCliState = "idle" | "working" | "blocking";

export type AiCliStatus = {
  tool: AiCliKind;
  state: AiCliState;
  /** Wall-clock ms of last state transition - used for toast de-dup. */
  since: number;
} | null;

export function aiCliLabel(s: NonNullable<AiCliStatus>): string {
  const tool = toolDisplayName(s.tool);
  switch (s.state) {
    case "idle":
      return `${tool} · idle`;
    case "working":
      return `${tool} · working`;
    case "blocking":
      return `${tool} · waiting for approval`;
  }
}

/** Short state word rendered inline next to the tab title. */
export function aiCliStateWord(s: NonNullable<AiCliStatus>): string {
  return s.state;
}

/** Tailwind classes for the inline state pill next to the tab title.
 *  Subtle tinted background + matching text - sits next to the tab label
 *  without overpowering it.
 *
 *  idle = green (tool is alive, waiting on nothing),
 *  working = yellow (actively processing),
 *  blocking = red blink (needs the user's answer / approval). */
export function aiCliStateChipClass(s: NonNullable<AiCliStatus>): string {
  switch (s.state) {
    case "idle":
      return "text-emerald-700 bg-emerald-100 dark:text-emerald-300 dark:bg-emerald-500/15";
    case "working":
      return "text-yellow-700 bg-yellow-100 dark:text-yellow-300 dark:bg-yellow-500/15";
    case "blocking":
      return "text-red-700 bg-red-100 dark:text-red-300 dark:bg-red-500/20 animate-pulse";
  }
}

/** Tailwind `text-*` class for the terminal-leaf icon when a known AI CLI
 *  is active. Drives the icon tint directly — TabBar no longer renders a
 *  separate "idle/working/blocking" chip, so the icon's colour IS the
 *  status indicator. `working` and `blocking` pulse to draw the eye. The
 *  detector is what clears the state cleanly when the CLI exits (alt-
 *  screen toggle, OSC 133;A, or SSH disconnect reset); the icon is just a
 *  mirror of that state. */
export function aiCliIconClass(s: NonNullable<AiCliStatus>): string {
  switch (s.state) {
    case "idle":
      return "text-emerald-600 dark:text-emerald-400";
    case "working":
      return "text-yellow-600 dark:text-yellow-400 animate-pulse";
    case "blocking":
      return "text-red-600 dark:text-red-400 animate-pulse";
  }
}

export function toolDisplayName(t: AiCliKind): string {
  switch (t) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "opencode";
    case "copilot":
      return "GitHub Copilot";
    case "pi":
      return "Pi";
    case "aider":
      return "Aider";
    case "gemini":
      return "Gemini";
    case "amazon-q":
      return "Amazon Q";
    case "cody":
      return "Cody";
    case "goose":
      return "Goose";
    case "cursor":
      return "Cursor Agent";
    case "ollama":
      return "Ollama";
  }
}
