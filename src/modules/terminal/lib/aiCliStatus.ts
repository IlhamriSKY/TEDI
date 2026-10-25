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
 * Animation class for the terminal-leaf icon when an AI CLI is active: a smooth
 * "breathing" pulse while working / blocking so an active prompt is always
 * visible. Idle stays solid (null). The colour is {@link aiCliStateColorClass}.
 *
 * Put it on an HTML WRAPPER, never on the `<svg>` itself: Chromium cannot hand
 * an animation on an SVG element to the compositor, so each breathing glyph
 * cost a style recalc + paint on the main thread every frame. Measured live on
 * v0.4.70, 12 breathing glyphs, median of 6 rounds: GPU process 36% -> 29% of a
 * core, renderer 31% -> 21%, the same as pausing every animation.
 *
 * `done` breathes too, but a FINITE number of times (`.ai-breathe-settle`).
 * It is the only state the app holds indefinitely: it is set on the
 * working->quiet edge and kept until the user focuses that terminal, so on a
 * board of finished agents it is N badges that would otherwise animate for
 * hours. A running animation keeps the compositor producing a frame every
 * vsync, so "held until noticed" was costing a frame loop per finished agent
 * for as long as the user did not look. It still catches the eye when it
 * appears, then rests on its own colour.
 */
export function aiCliIconMotionClass(s: NonNullable<AiCliStatus>): string | null {
  if (s.state === "idle") return null;
  if (s.state === "done") return "ai-breathe-settle";
  return "animate-ai-breathe";
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
