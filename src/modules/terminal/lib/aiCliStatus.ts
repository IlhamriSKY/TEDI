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
  | "grok"
  | "amazon-q"
  | "cody"
  | "goose"
  | "cursor"
  | "ollama";

/**
 * `done` marks a turn that just finished and is awaiting attention: emitted on
 * the working->quiet edge and held (a gentle breathing badge) until the user
 * focuses or types in that terminal, then it decays to `idle`. Distinct from
 * `idle` so a completed agent stays visible at a glance across many terminals.
 */
export type AiCliState = "idle" | "working" | "blocking" | "done";

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
    case "done":
      return `${tool} · done`;
  }
}

/**
 * Themable text color for a state on its own, for surfaces that label a state
 * without holding a terminal's status object (the workspace board's column
 * headers). {@link aiCliIconColorClass} is this keyed by a live status.
 */
export function aiCliStateColorClass(state: AiCliState): string {
  switch (state) {
    case "idle":
      return "text-[color:var(--tedi-icon-idle)]";
    case "working":
      return "text-[color:var(--tedi-icon-working)]";
    case "blocking":
      return "text-[color:var(--tedi-icon-blocked)]";
    case "done":
      return "text-[color:var(--tedi-icon-done)]";
  }
}

/**
 * Just the themable text color for the terminal-leaf icon, WITHOUT any
 * animation. The building block for {@link aiCliIconClass}.
 */
export function aiCliIconColorClass(s: NonNullable<AiCliStatus>): string {
  return aiCliStateColorClass(s.state);
}

/**
 * Tailwind classes for the terminal-leaf icon when an AI CLI is active:
 * themable color + a smooth "breathing" pulse while working / blocking so an
 * active prompt is always visible. Idle stays solid (no animation). Color
 * resolves from the themable `--tedi-icon-*` CSS variables.
 */
export function aiCliIconClass(s: NonNullable<AiCliStatus>): string {
  const color = aiCliIconColorClass(s);
  return s.state === "idle" ? color : `${color} animate-ai-breathe`;
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
    case "grok":
      return "Grok";
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
