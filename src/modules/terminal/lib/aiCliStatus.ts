// Runtime status of an AI CLI tool in a terminal leaf. Owned by
// `useTerminalSession`, surfaced via `onAiCliStatus`. Mirrors `SshStatus`.

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
  /** Wall-clock ms of last transition. Used for toast de-dup. */
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

/** Short state word for inline display. */
export function aiCliStateWord(s: NonNullable<AiCliStatus>): string {
  return s.state;
}

/**
 * Tailwind classes for the inline state pill. Colors resolve from the
 * themable `--tedi-icon-*` CSS variables (set in globals.css with sensible
 * defaults, overridable via Settings → Theme). Background is a soft tint
 * mixed from the same var via `color-mix()`.
 */
export function aiCliStateChipClass(s: NonNullable<AiCliStatus>): string {
  switch (s.state) {
    case "idle":
      return "text-[color:var(--tedi-icon-idle)] bg-[color:color-mix(in_oklab,var(--tedi-icon-idle)_15%,transparent)]";
    case "working":
      return "text-[color:var(--tedi-icon-working)] bg-[color:color-mix(in_oklab,var(--tedi-icon-working)_15%,transparent)]";
    case "blocking":
      return "text-[color:var(--tedi-icon-blocked)] bg-[color:color-mix(in_oklab,var(--tedi-icon-blocked)_18%,transparent)] animate-pulse";
  }
}

/**
 * Tailwind text color for the terminal-leaf icon when an AI CLI is active.
 * Resolves from themable CSS variables; working and blocking pulse.
 */
export function aiCliIconClass(s: NonNullable<AiCliStatus>): string {
  switch (s.state) {
    case "idle":
      return "text-[color:var(--tedi-icon-idle)]";
    case "working":
      return "text-[color:var(--tedi-icon-working)] animate-pulse";
    case "blocking":
      return "text-[color:var(--tedi-icon-blocked)] animate-pulse";
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
