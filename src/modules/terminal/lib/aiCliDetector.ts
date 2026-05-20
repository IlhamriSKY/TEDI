import type { AiCliKind, AiCliState, AiCliStatus } from "./aiCliStatus";

/**
 * AI CLI state detector. Classifies what the running AI tool (Claude Code,
 * opencode, codex, copilot, pi) is currently doing from the live xterm
 * buffer viewport. Inspired by https://github.com/ogulcancelik/herdr -
 * we read the screen content directly instead of parsing the raw byte
 * stream, so stale spinner glyphs in scrollback can never cause false
 * working states.
 *
 * Activation is pure keystroke-based: when the user types a known tool
 * name (`claude`, `opencode`, ...) at the shell prompt and presses Enter,
 * the detector switches into that tool's active mode. From there, screen
 * inspection drives all state transitions.
 *
 * Auto-clear: when the TUI exits xterm's alternate-screen buffer (i.e.
 * the AI tool quits and the shell prompt returns), the active tool is
 * cleared and the badge disappears with no further user action.
 */

const COMMAND_BUFFER_MAX = 512;

/** Re-classify cadence. The screen changes asynchronously so we poll. */
const RECLASSIFY_INTERVAL_MS = 250;

/**
 * Hold the `working` state for this long after the last positive signal.
 * Bridges the natural gaps between AI token chunks / TUI redraws so the
 * chip doesn't strobe back to idle mid-response.
 */
const WORKING_HOLD_MS = 2_500;

/**
 * On every "text + Enter" submission inside the tool TUI we seed
 * `lastWorkingAt = Date.now() + this` so the chip stays in working
 * mode through the latency between user submit and the AI's first
 * detectable byte (model warm-up, network round-trip). Total optimistic
 * window = this + WORKING_HOLD_MS.
 */
const SUBMIT_OPTIMISTIC_EXTRA_MS = 5_000;

/**
 * Hold `blocking` state for this long after the last approval-marker
 * read. Approval prompts persist until the user picks something and the
 * TUI may not redraw during that wait. Auto-cleared by any fresh
 * working hit (= AI moved on, the prompt was resolved).
 */
const BLOCKING_HOLD_MS = 60_000;

/**
 * Streaming-rate fallback for tools whose statusline doesn't match the
 * spinner-activity pattern (opencode in particular). To separate real
 * token streaming from idle-state animations (cursor blink, redraws on
 * focus changes), we require BOTH:
 *   - >= STREAMING_MIN_CHUNKS chunks within RATE_WINDOW_MS
 *   - >= STREAMING_MIN_BYTES total bytes in the same window
 * Cursor blinks emit ~1-2 chunks/s; opencode idle animations ~2-4
 * chunks/s; real streaming 6+ chunks/s.
 */
const RATE_WINDOW_MS = 1_500;
const STREAMING_MIN_CHUNKS = 4;
const STREAMING_MIN_BYTES = 40;

/**
 * Ignore PTY output that arrives within this many ms after a user
 * keystroke (or any xterm-to-PTY chunk like focus events). That output
 * is almost always the TUI echoing the keystroke and redrawing the
 * input box - NOT the AI generating - and would otherwise drive the
 * rate over the streaming threshold and false-fire working.
 */
const ECHO_SUPPRESS_MS = 250;

/**
 * Sliding window of decoded PTY output that the detector also scans for
 * blocking patterns. The viewport read (`opts.readBuffer`) goes through
 * xterm's write queue which is drained on a scheduler that browsers
 * can throttle when the element is `visibility: hidden` (other tab
 * active) - so a "do you want to proceed?" prompt printed while the user
 * is on a different tab can land in the xterm buffer many seconds late.
 * PTY bytes themselves keep flowing into `pushOutput` unchanged, so we
 * mirror them into this lightweight text buffer and pattern-match
 * directly. Width is kept short (a few seconds) so a just-answered
 * prompt ages out quickly - the buffer is also cleared on every user
 * Enter-submit so AI's follow-up response doesn't re-fire blocking off
 * the stale prompt text.
 */
const RECENT_OUTPUT_WINDOW_MS = 3_000;

/** Hard cap on the recent-output buffer in chars - guards against
 *  runaway memory when a long-running stream fills the window. */
const RECENT_OUTPUT_MAX_CHARS = 32_768;

/**
 * Strips ANSI escape sequences (CSI like `\x1b[1;31m`, OSC like
 * `\x1b]0;title\x07`) so substring matching against the recent output
 * isn't broken by mid-text styling. Cursor/screen control codes are
 * removed too - we only care about the textual content.
 */
const ANSI_RE = /\x1b\[[\d;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Tool activation patterns. Matched against the command line typed at the
 * shell prompt: when the user enters one of these and hits Enter, the
 * detector switches into that tool's active mode.
 *
 * Patterns work identically on Windows / macOS / Linux because we match
 * the user's command string before it reaches the shell - no platform
 * paths or binaries are inspected.
 */
const TOOL_PATTERNS: { tool: AiCliKind; commands: RegExp }[] = [
  { tool: "claude", commands: /^\s*(claude(?:-code)?)\b/ },
  { tool: "codex", commands: /^\s*codex\b/ },
  { tool: "opencode", commands: /^\s*opencode\b/ },
  { tool: "copilot", commands: /^\s*(gh\s+copilot|copilot)\b/ },
  { tool: "pi", commands: /^\s*pi\b/ },
  { tool: "aider", commands: /^\s*aider\b/ },
  { tool: "gemini", commands: /^\s*(gemini|gemini-cli)\b/ },
  { tool: "amazon-q", commands: /^\s*(q\s+chat|q\s+code|amazon-q)\b/ },
  { tool: "cody", commands: /^\s*cody\b/ },
  { tool: "goose", commands: /^\s*goose\b/ },
  { tool: "cursor", commands: /^\s*cursor-agent\b/ },
  { tool: "ollama", commands: /^\s*ollama\s+run\b/ },
];

function matchTool(line: string): AiCliKind | null {
  for (const t of TOOL_PATTERNS) {
    if (t.commands.test(line)) return t.tool;
  }
  return null;
}

// Spinner-glyph alphabet. The leading char of an "AI is spinning" line is
// almost always one of these in Claude Code / opencode / codex / etc. We
// pair this with the strict herdr "+ space + ellipsis + alphanumeric"
// pattern so a stray glyph in chat history doesn't cause a false match.
// The middle-dot `·` is intentionally excluded - it appears in paths,
// separators, and statuslines as a regular character.
const SPINNER_CHARS = new Set(Array.from("✱✲✳✴✵✶✷✸✹✺✻✼✽✾✿❀❁❂❃❇❈❉❊❋✢✣✤✥✦✧✨⊛⊕⊙◉◎◍⁂⁕※⍟☼★☆"));
const ELLIPSIS = "…";
const BRAILLE_LO = 0x2800;
const BRAILLE_HI = 0x28ff;

function isSpinnerLeadChar(ch: string): boolean {
  if (SPINNER_CHARS.has(ch)) return true;
  const code = ch.codePointAt(0) ?? 0;
  return code >= BRAILLE_LO && code <= BRAILLE_HI;
}

const ALPHANUM_RE = /[\p{L}\p{N}]/u;

/**
 * Detects the herdr-style "✻ Pondering… (35s · ↓ 279 tokens)" pattern -
 * a line that starts with a spinner glyph, then a space, then somewhere
 * an ellipsis, and at least one alphanumeric char. Strong evidence the
 * AI is actively spinning.
 */
function hasSpinnerActivity(content: string): boolean {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const first = line[0];
    if (!isSpinnerLeadChar(first)) continue;
    const rest = line.slice(first.length);
    if (!rest.startsWith(" ")) continue;
    if (!rest.includes(ELLIPSIS)) continue;
    if (ALPHANUM_RE.test(rest)) return true;
  }
  return false;
}

// Horizontal box-drawing chars that delimit a TUI's input box. We accept
// the whole family because different tools pick different glyphs.
const BORDER_CHARS = new Set(Array.from("─━═╌╍╴╶╸╺"));
const BORDER_CORNERS = new Set(Array.from("╭╮╰╯"));

function isBorderLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3) return false;
  for (const ch of trimmed) {
    if (!BORDER_CHARS.has(ch) && !BORDER_CORNERS.has(ch)) return false;
  }
  return true;
}

/**
 * Returns the chat-history portion of the viewport (everything above the
 * TUI's input prompt box). Strategy: find the last two horizontal-rule
 * lines from the bottom and return content above the second one. If no
 * border pair is found, fall back to dropping the bottom 30% of lines -
 * conservatively excluding tools with non-standard input-box rendering
 * so the user's own typed text doesn't false-match working patterns.
 */
function contentAbovePromptBox(content: string): string {
  const lines = content.split("\n");
  let borderCount = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isBorderLine(lines[i])) {
      borderCount++;
      if (borderCount === 2) return lines.slice(0, i).join("\n");
    }
  }
  const trim = Math.max(3, Math.floor(lines.length * 0.3));
  return lines.slice(0, Math.max(0, lines.length - trim)).join("\n");
}

// "AI is waiting for the user" markers. Checked case-insensitively
// against the full viewport so a question rendered above the input box
// AND a question baked into the prompt-box itself both fire blocking.
//
// IMPORTANT: only add phrases that are *unambiguous* blocking signals.
// Generic keyboard hints that appear in the input bar during *idle* state
// (e.g. "tab to amend", "ctrl+e to explain", "chat about this") used to
// be on this list and made the blocking badge stick on Claude Code at
// rest, which the user (correctly) reported as broken. The list now
// targets only phrases that imply "the AI is waiting on a user decision".
const BLOCKED_SUBSTRINGS: readonly string[] = [
  // Claude Code - explicit confirmation prompts only
  "do you want to proceed?",
  "would you like to proceed?",
  // Codex / opencode / amazon-q / cursor-agent style approvals
  "approve?",
  "approve this",
  "approve action",
  "allow this",
  "allow command",
  "allow this command",
  "run this command?",
  "execute this command?",
  "apply patch?",
  "apply changes?",
  "save file?",
  "save changes?",
  // Aider style
  "edit the file?",
  "add to the chat?",
  "create new file?",
  // Gemini / pi / generic single-shot confirmations
  "continue?",
  "are you sure?",
  "is this correct?",
  // Permission / connection
  "waiting for permission",
  "do you want to allow this connection?",
  // Generic single-key gates
  "press y to",
  "press enter to continue",
  "press any key to continue",
  "press any key to exit",
  "press any key",
  "select an option",
  "choose an option",
  "pick one",
  "[y/n]",
  "(y/n)",
  "[y/n/a]",
  "(y/n/a)",
  "(yes/no)",
  // Single-letter parenthesized choices - aider's standard prompt vocab
  // ("(Y)es / (N)o / (D)on't ask again"). Lowercase match against
  // stripped content; the literal `(y)es` etc. survive ANSI stripping.
  "(y)es",
  "(n)o",
  "(d)on't",
  // "esc to cancel" is a CANCEL-able wait state (approval prompt, file
  // picker) - distinct from "esc to interrupt" / "ctrl+c to interrupt"
  // which mark active generation. Lives in blocking, not working.
  "esc to cancel",
];

function hasConfirmationPrompt(content: string, lowerContent: string): boolean {
  let pos = lowerContent.indexOf("do you want");
  if (pos < 0) pos = lowerContent.indexOf("would you like");
  if (pos < 0) return false;
  const afterLower = lowerContent.slice(pos);
  if (afterLower.includes("yes")) return true;
  return content.slice(pos).includes("❯");
}

// Cursor glyphs that mark the currently-highlighted option in a TUI
// selection prompt. Different tools render this differently:
//   ❯  - most modern TUIs (opencode, codex, gemini, …)
//   >  - simple ASCII fallback
//   )  - Claude Code's "Do you want to proceed?" approval menu
//   ▶  - some Rust-based TUIs
const SELECTION_CURSOR_CHARS = ["❯", ">", ")", "▶"] as const;

function hasSelectionPrompt(content: string): boolean {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    let cursored = false;
    for (const c of SELECTION_CURSOR_CHARS) {
      if (line.startsWith(c)) {
        cursored = true;
        break;
      }
    }
    if (!cursored) continue;
    let hasDigit = false;
    let hasDot = false;
    for (const ch of line) {
      if (ch >= "0" && ch <= "9") hasDigit = true;
      else if (ch === ".") hasDot = true;
      if (hasDigit && hasDot) return true;
    }
  }
  return false;
}

function detectBlocking(content: string, lowerContent: string): boolean {
  for (const s of BLOCKED_SUBSTRINGS) {
    if (lowerContent.includes(s)) return true;
  }
  if (hasConfirmationPrompt(content, lowerContent)) return true;
  // A numbered menu with an active cursor pointer is always a blocking
  // interaction - the user has to pick something. Used to require a
  // yes/no choice on top of the cursor; that was too narrow and missed
  // free-form multi-choice prompts ("Choose a model", file picker, etc.).
  if (hasSelectionPrompt(content)) return true;
  return false;
}

// Live token-counter ("↓ 279 tokens" / "↑ 121 tokens") - near-universal
// statusline element while a model call is streaming.
const TOKEN_COUNTER_RE = /[↓↑⬇⬆]\s*\d[\d.,]*\s*(?:k|m)?\s*tokens?/i;
// Status verb followed by ellipsis or "(" - catches "Thinking..." etc
// without the strict spinner-glyph prefix that hasSpinnerActivity needs.
// Verb list aggregated across all 12 supported tools (see TOOL_PATTERNS):
// claude/codex/opencode/gemini/aider/copilot/cursor-agent each prefer
// different "what am I doing" verbs in their statusline.
const STATUS_VERB_RE =
  /\b(?:thinking|generating|loading|processing|streaming|working|reading|writing|editing|analyzing|reviewing|searching|running|executing|fetching|downloading|uploading|building|compiling|installing|planning|coding|exploring|inspecting|considering|reasoning|brainstorming|drafting|refining|finalizing|calling|invoking|querying|computing)(?:[.…]{1,3}|\s*\()/i;

function detectWorking(content: string): boolean {
  const above = contentAbovePromptBox(content);
  const aboveLower = above.toLowerCase();
  if (aboveLower.includes("esc to interrupt")) return true;
  if (aboveLower.includes("ctrl+c to interrupt")) return true;
  // Note: "esc to cancel" is intentionally NOT a working signal - it marks
  // a cancel-able *wait* (approval menu, file picker), not active
  // generation. See BLOCKED_SUBSTRINGS for the inverse classification.
  if (hasSpinnerActivity(above)) return true;
  if (TOKEN_COUNTER_RE.test(above)) return true;
  return STATUS_VERB_RE.test(above);
}

function detectExplicitIdle(content: string, lowerContent: string): boolean {
  if (content.includes("⌕ Search…")) return true;
  return lowerContent.includes("ctrl+r to toggle");
}

export type AiCliDetectorOptions = {
  /** Fires whenever the classified state (or active tool) changes. */
  onStatus: (status: AiCliStatus) => void;
  /** Visible xterm viewport content - newline-joined, original case. */
  readBuffer: () => string;
  /**
   * True when xterm's active buffer is the alternate screen. AI TUIs
   * (Claude, opencode, codex) enter it on startup; flipping back to the
   * main buffer means the TUI exited and the active tool should clear.
   */
  isAltScreen: () => boolean;
};

export type AiCliDetector = {
  /** xterm `onData` payloads - user keystrokes + xterm-to-PTY CSIs. */
  pushInput: (chunk: string) => void;
  /** PTY output bytes - drives the streaming-rate fallback. */
  pushOutput: (chunk: Uint8Array | string) => void;
  /** Drop the active tool (PTY teardown / explicit reset). */
  reset: () => void;
  /**
   * Wired to OSC 133;A (shell prompt start). When the shell prints a new
   * prompt while a tool was marked active, the tool exited - clear the
   * badge. Handles tools that don't use the alt-screen (`claude --help`,
   * `codex login`, `gemini --version`, plain stdin/stdout chats like
   * `ollama run`) which the alt-screen auto-clear path would otherwise
   * miss, leaving the badge stuck after the CLI is gone.
   */
  notifyShellPrompt: () => void;
  /** Free internal timers; called when the host session disposes. */
  dispose: () => void;
};

export function createAiCliDetector(opts: AiCliDetectorOptions): AiCliDetector {
  let cmdBuffer = "";
  let activeTool: AiCliKind | null = null;
  let lastEmittedTool: AiCliKind | null = null;
  let lastEmittedState: AiCliState = "idle";

  let lastWorkingAt = 0;
  let lastBlockingAt = 0;
  let outputSamples: { t: number; n: number }[] = [];
  /**
   * Rolling time-windowed buffer of decoded, ANSI-stripped PTY output.
   * The detector falls back to scanning this when the xterm viewport
   * read can't be trusted - see RECENT_OUTPUT_WINDOW_MS doc above.
   */
  let recentOutput: { t: number; text: string }[] = [];
  let recentOutputChars = 0;
  let lastUserInputAt = 0;
  let sawAltScreen = false;

  let hasSeenWorking = false;
  let userSubmittedAtLeastOnce = false;
  let pendingPrintable = false;

  let reclassifyTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const textDecoder = new TextDecoder("utf-8", { fatal: false });

  function emit(state: AiCliState) {
    if (disposed) return;
    if (!activeTool) {
      if (lastEmittedTool === null) return;
      lastEmittedTool = null;
      lastEmittedState = "idle";
      safeOnStatus(null);
      return;
    }
    if (activeTool === lastEmittedTool && state === lastEmittedState) return;
    lastEmittedTool = activeTool;
    lastEmittedState = state;
    safeOnStatus({ tool: activeTool, state, since: Date.now() });
  }

  // Defensive wrappers - never let a host callback throwing tear down the
  // detector loop. Errors are swallowed silently in production builds.
  function safeOnStatus(status: AiCliStatus) {
    try {
      opts.onStatus(status);
    } catch {
      // intentionally silent
    }
  }
  function safeReadBuffer(): string {
    try {
      return opts.readBuffer();
    } catch {
      return "";
    }
  }
  function safeIsAltScreen(): boolean {
    try {
      return opts.isAltScreen();
    } catch {
      return false;
    }
  }

  function resetRuntime() {
    lastWorkingAt = 0;
    lastBlockingAt = 0;
    outputSamples = [];
    recentOutput = [];
    recentOutputChars = 0;
    lastUserInputAt = 0;
    sawAltScreen = false;
    hasSeenWorking = false;
    userSubmittedAtLeastOnce = false;
    pendingPrintable = false;
  }

  function pruneRecentOutput(now: number) {
    while (recentOutput.length > 0 && now - recentOutput[0].t > RECENT_OUTPUT_WINDOW_MS) {
      recentOutputChars -= recentOutput[0].text.length;
      recentOutput.shift();
    }
    // Memory guard: when the window is dense (long burst of output), drop
    // the oldest chunks until we're back under the cap. Keep at least one
    // entry so the next reclassify still has *something* to scan.
    while (recentOutputChars > RECENT_OUTPUT_MAX_CHARS && recentOutput.length > 1) {
      recentOutputChars -= recentOutput[0].text.length;
      recentOutput.shift();
    }
  }

  function getRecentOutput(): string {
    if (recentOutput.length === 0) return "";
    if (recentOutput.length === 1) return recentOutput[0].text;
    let out = "";
    for (const c of recentOutput) out += c.text;
    return out;
  }

  function clearTool() {
    activeTool = null;
    resetRuntime();
    cmdBuffer = "";
    if (reclassifyTimer) {
      clearTimeout(reclassifyTimer);
      reclassifyTimer = null;
    }
    emit("idle");
  }

  function activateTool(tool: AiCliKind) {
    activeTool = tool;
    resetRuntime();
    emit("idle");
    scheduleReclassify();
  }

  function isStreamingOutput(): boolean {
    const now = Date.now();
    while (outputSamples.length > 0 && now - outputSamples[0].t > RATE_WINDOW_MS) {
      outputSamples.shift();
    }
    if (outputSamples.length < STREAMING_MIN_CHUNKS) return false;
    let total = 0;
    for (const s of outputSamples) total += s.n;
    return total >= STREAMING_MIN_BYTES;
  }

  function reclassify() {
    if (!activeTool) return;
    try {
      // Auto-clear: TUI left alternate-screen means the AI tool exited
      // back to the main shell. Drop the active tool so the badge clears.
      const isAlt = safeIsAltScreen();
      if (isAlt) {
        sawAltScreen = true;
      } else if (sawAltScreen) {
        clearTool();
        return;
      }
      if (!userSubmittedAtLeastOnce) {
        emit("idle");
        return;
      }
      const content = safeReadBuffer();
      const lower = content.toLowerCase();
      const now = Date.now();
      pruneRecentOutput(now);

      const workingHit = detectWorking(content);
      const explicitIdle = detectExplicitIdle(content, lower);
      const rateHit = isStreamingOutput();

      // Blocking is checked against BOTH the xterm viewport AND the recent
      // decoded PTY output. The viewport is the authoritative source while
      // the pane is visible; the raw output buffer is the fallback for when
      // the pane is hidden (other tab active) and xterm's write queue
      // hasn't drained yet - PTY bytes themselves still flow through
      // pushOutput so the prompt always lands here on time.
      //
      // The recent-output fallback is *skipped* whenever the AI is actively
      // producing output (workingHit or rateHit). If bytes are flowing, the
      // prompt that may still be cached in the recent buffer was already
      // answered and we'd otherwise mis-fire blocking on the stale text
      // while the AI is responding to the answer.
      let blockingHit = detectBlocking(content, lower);
      if (!blockingHit && !workingHit && !rateHit && recentOutput.length > 0) {
        const recent = getRecentOutput();
        if (recent) {
          blockingHit = detectBlocking(recent, recent.toLowerCase());
        }
      }

      if (!explicitIdle) {
        // Blocking takes priority over working. Many AI CLIs (Claude Code
        // in particular) paint their approval prompts WHILE also rendering
        // "esc to cancel" / a token counter from the still-active request,
        // so workingHit and blockingHit fire together. The old code reset
        // lastBlockingAt = 0 inside the working branch which let working
        // unconditionally overwrite blocking; that left the badge stuck at
        // WORKING through a "Do you want to proceed?" menu. The new flow:
        //   - workingHit clears blocking ONLY when blocking is absent
        //     (i.e. the AI genuinely moved on after the user answered)
        //   - blockingHit refreshes lastBlockingAt last, so it wins the
        //     emit decision below when both signals coexist
        if (workingHit || rateHit) {
          lastWorkingAt = now;
          hasSeenWorking = true;
          if (!blockingHit) lastBlockingAt = 0;
        }
        if (blockingHit && hasSeenWorking) lastBlockingAt = now;
      }

      if (now - lastBlockingAt < BLOCKING_HOLD_MS) emit("blocking");
      else if (now - lastWorkingAt < WORKING_HOLD_MS) emit("working");
      else emit("idle");
    } catch {
      // Pattern matching / buffer parsing should never break the loop;
      // swallow and stay in the current state.
    }
  }

  function scheduleReclassify() {
    if (reclassifyTimer) clearTimeout(reclassifyTimer);
    reclassifyTimer = setTimeout(() => {
      reclassifyTimer = null;
      if (!activeTool) return;
      reclassify();
      scheduleReclassify();
    }, RECLASSIFY_INTERVAL_MS);
  }

  return {
    pushInput(chunk: string) {
      // Any input to the PTY (real keystroke OR xterm-emitted CSI like
      // focus-in/out) marks a recent-input timestamp so pushOutput can
      // skip the echo bytes that immediately follow.
      if (activeTool) lastUserInputAt = Date.now();
      // CSI sequences start with ESC and are not user keystrokes - skip
      // character-level processing entirely.
      if (chunk.length > 0 && chunk.charCodeAt(0) === 0x1b) return;

      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        const isEnter = ch === "\r" || ch === "\n";
        if (!activeTool) {
          // Accumulating a shell command line. Activate on Enter if it
          // matches a known AI CLI invocation.
          if (isEnter) {
            const tool = matchTool(cmdBuffer);
            cmdBuffer = "";
            if (tool) activateTool(tool);
          } else if (code >= 0x20 && code !== 0x7f) {
            if (cmdBuffer.length < COMMAND_BUFFER_MAX) cmdBuffer += ch;
          } else if (ch === "\x7f" || ch === "\b") {
            cmdBuffer = cmdBuffer.slice(0, -1);
          } else if (ch === "\x15" || ch === "\x03") {
            cmdBuffer = "";
          } else if (ch === "\x17") {
            cmdBuffer = cmdBuffer.replace(/\s*\S+\s*$/, "");
          }
        } else {
          // Inside the tool TUI. A "printable text + Enter" combo is a
          // real submission - flip the chip to working optimistically so
          // the user sees feedback before bytes start flowing back.
          if (isEnter) {
            if (pendingPrintable) {
              if (!userSubmittedAtLeastOnce) userSubmittedAtLeastOnce = true;
              lastWorkingAt = Date.now() + SUBMIT_OPTIMISTIC_EXTRA_MS;
              hasSeenWorking = true;
              // Drop the recent-output buffer so any blocking pattern
              // cached from the just-answered prompt ("do you want to
              // proceed?", numbered menu, etc.) doesn't keep re-firing
              // blocking through the next ~3s while the AI starts
              // responding to *this* submit.
              recentOutput = [];
              recentOutputChars = 0;
              // Same reason for blocking-hold: the prompt was just
              // answered, so any pending blocking emit is stale.
              lastBlockingAt = 0;
              reclassify();
            }
            pendingPrintable = false;
          } else if (code >= 0x20 && code !== 0x7f) {
            pendingPrintable = true;
          }
        }
      }
    },
    pushOutput(chunk: Uint8Array | string) {
      if (!activeTool) return;
      const n = typeof chunk === "string" ? chunk.length : chunk.byteLength;
      // Decode to text for the recent-output buffer (used as the fallback
      // source for blocking-pattern matching when the xterm viewport is
      // lagging behind - see RECENT_OUTPUT_WINDOW_MS doc). The decoder is
      // stateful (`stream: true`) so a multi-byte codepoint split across
      // PTY chunks is reassembled correctly across calls.
      const text = typeof chunk === "string" ? chunk : textDecoder.decode(chunk, { stream: true });
      const now = Date.now();
      if (text) {
        const clean = stripAnsi(text);
        if (clean) {
          recentOutput.push({ t: now, text: clean });
          recentOutputChars += clean.length;
          pruneRecentOutput(now);
        }
      }
      // Echo-window: PTY output close behind a user input event is the
      // TUI redrawing, not AI streaming. Skip those samples so typing a
      // long prompt doesn't push the rate over the streaming threshold.
      if (now - lastUserInputAt > ECHO_SUPPRESS_MS) {
        outputSamples.push({ t: now, n });
      }
      reclassify();
    },
    reset() {
      cmdBuffer = "";
      if (activeTool) clearTool();
    },
    notifyShellPrompt() {
      // Shell printed a new prompt. If a tool was active, the CLI
      // returned control to the shell - drop the active tool so the
      // badge disappears. No-op when nothing was active (every shell
      // also emits OSC 133;A for its very first prompt at startup).
      if (activeTool) clearTool();
    },
    dispose() {
      disposed = true;
      if (reclassifyTimer) {
        clearTimeout(reclassifyTimer);
        reclassifyTimer = null;
      }
    },
  };
}
