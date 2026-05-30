import type { AiCliKind, AiCliState, AiCliStatus } from "./aiCliStatus";

/**
 * AI CLI state detector. Classifies what the running AI tool is doing by
 * reading the live xterm viewport. Inspired by https://github.com/ogulcancelik/herdr.
 * Reading the screen avoids false-working from stale spinner glyphs in scrollback.
 *
 * Activation: when the user types a known tool name at the shell prompt and
 * hits Enter, the detector switches into that tool's active mode.
 *
 * Auto-clear: leaving xterm's alternate screen drops the active tool.
 */

const COMMAND_BUFFER_MAX = 512;

/** Poll cadence for screen reclassification. */
const RECLASSIFY_INTERVAL_MS = 250;

/** Hold `working` for this long after the last positive signal. Bridges gaps between token chunks. */
const WORKING_HOLD_MS = 2_500;

/**
 * Extra window after a user submits, seeded into `lastWorkingAt`. Covers
 * model warm-up before the first detectable byte. Total optimistic window
 * is this + `WORKING_HOLD_MS`.
 */
const SUBMIT_OPTIMISTIC_EXTRA_MS = 5_000;

/** Hold `blocking` this long after the last approval marker. Cleared by any fresh working hit. */
const BLOCKING_HOLD_MS = 60_000;

/**
 * Streaming-rate fallback for tools without spinner activity (e.g. opencode).
 * Requires both >= STREAMING_MIN_CHUNKS chunks and >= STREAMING_MIN_BYTES
 * within RATE_WINDOW_MS. Tuned so cursor blinks (1-2 chunks/s) and idle
 * animations (2-4 chunks/s) don't trip the threshold; real streaming runs 6+.
 */
const RATE_WINDOW_MS = 1_500;
const STREAMING_MIN_CHUNKS = 4;
const STREAMING_MIN_BYTES = 40;

/**
 * Ignore PTY output arriving within this many ms of user input. That output
 * is the TUI echoing the keystroke, not the AI generating, and would otherwise
 * trip the streaming threshold.
 */
const ECHO_SUPPRESS_MS = 250;

/**
 * Sliding window of decoded PTY output. Xterm's write queue can lag when the
 * pane is hidden, but PTY bytes still flow through `pushOutput`, so we mirror
 * them here and pattern-match directly. Cleared on every Enter-submit.
 */
const RECENT_OUTPUT_WINDOW_MS = 3_000;

/** Char cap on the recent-output buffer. */
const RECENT_OUTPUT_MAX_CHARS = 32_768;

/** Strips ANSI CSI and OSC so substring matching isn't broken by styling. */
const ANSI_RE = /\x1b\[[\d;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

/**
 * Tool activation patterns. Matched against the typed command before it
 * reaches the shell, so they work identically on every platform.
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

/**
 * Pull the command portion out of a shell-prompt line. Used when `cmdBuffer`
 * is empty on Enter (history recall, paste-then-Enter, Tab+Enter completion).
 */
function extractCommandFromPromptLine(line: string): string {
  // Trim trailing whitespace so the regex doesn't have to.
  const trimmed = line.replace(/\s+$/, "");
  // Last shell-prompt marker in the line. Space is required so `foo$bar` in a path doesn't fire.
  const m = trimmed.match(/[\$#%>]\s+(.*)$/);
  if (m) return m[1];
  return trimmed;
}

/** Last non-empty line of the viewport. */
function lastNonEmptyLine(content: string): string {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.replace(/\s+/g, "").length > 0) return line;
  }
  return "";
}

/**
 * Cursor-line shell PS1 detection. Cursor position is the most reliable
 * "where is the user now" signal across alt-screen and inline CLIs. Matches
 * anywhere in the line so a typed-but-unsent `[user@host ~]$ cd /var` still
 * counts as "back at shell".
 */
const SHELL_PROMPT_LINE_PATTERNS: RegExp[] = [
  // `]$` or `]#` bracketed bash (red hat, fedora, arch). Trailing space optional.
  /\][\$#](?:\s|$)/,
  // `user@host:path$` debian/ubuntu.
  /[\w.-]+@[\w.-]+:[^\s]*[\$#](?:\s|$)/,
  // zsh trailing `%` (default macOS). Requires non-empty content before `%`.
  /^\s*\S.*\s%(?:\s|$)/,
  // PowerShell `PS C:\path>` or `PS /usr/local>`.
  /^\s*PS\s+\S.*>\s?$/i,
  // Windows cmd `C:\path>`.
  /^\s*[A-Za-z]:\\[^>]*>\s?$/i,
];

export function cursorLineLooksLikeShellPrompt(line: string): boolean {
  if (!line || line.replace(/\s+/g, "").length === 0) return false;
  for (const re of SHELL_PROMPT_LINE_PATTERNS) {
    if (re.test(line)) return true;
  }
  return false;
}


// Spinner glyph alphabet. Combined with the herdr "+ space + ellipsis +
// alphanumeric" pattern to avoid false matches on stray glyphs in chat history.
// Middle-dot `·` is excluded; it's used as a regular separator in paths.
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

/** Detect a line like "Pondering... (35s)" with spinner glyph + space + ellipsis + alphanumeric. */
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

// Horizontal box-drawing chars delimiting a TUI input box. Different tools pick different glyphs.
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
 * Returns viewport content above the TUI input box. Finds the last two
 * horizontal-rule lines and returns content above the second; falls back
 * to dropping the bottom 30% of lines.
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

// "AI is waiting for the user" markers, matched case-insensitively against
// the full viewport. Only include phrases that unambiguously mean "waiting on
// a user decision"; generic keyboard hints belong in idle state.
const BLOCKED_SUBSTRINGS: readonly string[] = [
  // Claude Code: explicit confirmation prompts only.
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
  // Aider's parenthesized choices like "(Y)es / (N)o". Lowercase match after ANSI strip.
  "(y)es",
  "(n)o",
  "(d)on't",
  // "esc to cancel" is a wait state (approval, file picker). Distinct from
  // "esc to interrupt" which marks active generation.
  "esc to cancel",
];

// Confirmation prefixes. The phrase alone isn't enough since chat content
// can quote them, so we also require "yes" or a cursor `❯` in the same region.
const CONFIRMATION_PREFIXES = ["do you want", "would you like", "are you sure"] as const;

function hasConfirmationPrompt(content: string, lowerContent: string): boolean {
  let pos = -1;
  for (const prefix of CONFIRMATION_PREFIXES) {
    pos = lowerContent.indexOf(prefix);
    if (pos >= 0) break;
  }
  if (pos < 0) return false;
  const afterLower = lowerContent.slice(pos);
  if (afterLower.includes("yes")) return true;
  return content.slice(pos).includes("❯");
}

// Cursor glyphs marking the highlighted option in a selection prompt.
// `>` and `)` excluded; they appear too often in regular text.
const SELECTION_CURSOR_CHARS = ["❯", "▶"] as const;

// Numbered menu option after the cursor like `1. Yes`. Strict `\d+\.\s` to avoid filename false positives.
const NUMBERED_OPTION_RE = /^\s*\d+\.\s+\S/;

function hasSelectionPrompt(content: string): boolean {
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    let cursorLen = 0;
    for (const c of SELECTION_CURSOR_CHARS) {
      if (line.startsWith(c)) {
        cursorLen = c.length;
        break;
      }
    }
    if (cursorLen === 0) continue;
    if (NUMBERED_OPTION_RE.test(line.slice(cursorLen))) return true;
  }
  return false;
}

function detectBlocking(content: string, lowerContent: string): boolean {
  for (const s of BLOCKED_SUBSTRINGS) {
    if (lowerContent.includes(s)) return true;
  }
  if (hasConfirmationPrompt(content, lowerContent)) return true;
  // Numbered menu with a cursor pointer always blocks. Covers picker prompts.
  if (hasSelectionPrompt(content)) return true;
  return false;
}

// Background-agent / workflow progress line, e.g. "26/43 agents done". Claude
// Code (and similar tools) hand control back to an interactive prompt while a
// background workflow runs, so the spinner + "esc to interrupt" hints above the
// input box are gone even though agents are still working. This line renders
// *below* the input box, so detectWorking (above-box only) never sees it.
const BACKGROUND_AGENTS_RE = /\b\d+\/\d+\s+agents?\s+done\b/i;

// Live token counter like "↓ 279 tokens". Near-universal during streaming.
const TOKEN_COUNTER_RE = /[↓↑⬇⬆]\s*\d[\d.,]*\s*(?:k|m)?\s*tokens?/i;
// Status verb plus ellipsis or "(". Covers "Thinking..." without needing the spinner glyph.
const STATUS_VERB_RE =
  /\b(?:thinking|generating|loading|processing|streaming|working|reading|writing|editing|analyzing|reviewing|searching|running|executing|fetching|downloading|uploading|building|compiling|installing|planning|coding|exploring|inspecting|considering|reasoning|brainstorming|drafting|refining|finalizing|calling|invoking|querying|computing)(?:[.…]{1,3}|\s*\()/i;

/**
 * Classifies "AI is working" from the viewport in two tiers.
 * Strong signals (interrupt hints, animated spinner line) are trusted alone.
 * Weak signals (token counters, "Thinking...") also appear in scrollback, so
 * they only count when paired with `hasFreshOutput`.
 */
function detectWorking(content: string, hasFreshOutput: boolean): boolean {
  const above = contentAbovePromptBox(content);
  const aboveLower = above.toLowerCase();
  if (aboveLower.includes("esc to interrupt")) return true;
  if (aboveLower.includes("ctrl+c to interrupt")) return true;
  // "esc to cancel" is a wait state, not working. See BLOCKED_SUBSTRINGS.
  if (hasSpinnerActivity(above)) return true;
  if (!hasFreshOutput) return false;
  if (TOKEN_COUNTER_RE.test(above)) return true;
  return STATUS_VERB_RE.test(above);
}

function detectExplicitIdle(content: string, lowerContent: string): boolean {
  if (content.includes("⌕ Search…")) return true;
  return lowerContent.includes("ctrl+r to toggle");
}

export type AiCliDetectorOptions = {
  /** Fires when classified state or active tool changes. */
  onStatus: (status: AiCliStatus) => void;
  /** Visible xterm viewport content, newline-joined. */
  readBuffer: () => string;
  /** True when xterm's active buffer is the alternate screen. */
  isAltScreen: () => boolean;
  /** Current cursor line content. Most reliable signal for "where the user is now". */
  readCursorLine: () => string;
};

export type AiCliDetector = {
  /** xterm `onData` payloads: keystrokes and xterm-to-PTY CSIs. */
  pushInput: (chunk: string) => void;
  /** PTY output bytes. Drives the streaming-rate fallback. */
  pushOutput: (chunk: Uint8Array | string) => void;
  /** Drop the active tool. */
  reset: () => void;
  /**
   * Wired to OSC 133;A. A new shell prompt while a tool is active means
   * the CLI exited. Covers tools that don't use the alt screen.
   */
  notifyShellPrompt: () => void;
  /** Free internal timers. Called on host session dispose. */
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
  /** Rolling buffer of decoded, ANSI-stripped PTY output. See RECENT_OUTPUT_WINDOW_MS. */
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

  // Wrap host callbacks so a throw can't tear down the detector loop.
  function safeOnStatus(status: AiCliStatus) {
    try {
      opts.onStatus(status);
    } catch {
      // ignore
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
  function safeReadCursorLine(): string {
    try {
      return opts.readCursorLine();
    } catch {
      return "";
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
    // Memory guard. Drop oldest chunks until under the char cap, but keep at least one entry.
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

  function pruneOutputSamples(now: number) {
    while (outputSamples.length > 0 && now - outputSamples[0].t > RATE_WINDOW_MS) {
      outputSamples.shift();
    }
  }

  function isStreamingOutput(): boolean {
    pruneOutputSamples(Date.now());
    if (outputSamples.length < STREAMING_MIN_CHUNKS) return false;
    let total = 0;
    for (const s of outputSamples) total += s.n;
    return total >= STREAMING_MIN_BYTES;
  }

  /**
   * True when any PTY sample sits inside RATE_WINDOW_MS. Qualifies weak
   * working signals so stale scrollback stats don't pin the badge. Less
   * strict than `isStreamingOutput`.
   */
  function hasFreshOutput(): boolean {
    pruneOutputSamples(Date.now());
    return outputSamples.length > 0;
  }

  function reclassify() {
    if (!activeTool) return;
    try {
      // Cursor position drives classification. Two clear-tool rules:
      //   1. Cursor on a shell PS1 -> CLI exited.
      //   2. Alt-screen toggled back to normal after we saw alt-screen -> CLI exited.
      //   Rule 2 fires earlier than rule 1 for older alt-screen CLIs.
      const isAlt = safeIsAltScreen();
      const content = safeReadBuffer();
      const cursorLine = safeReadCursorLine();
      const cursorAtShell = cursorLineLooksLikeShellPrompt(cursorLine);

      if (isAlt) {
        sawAltScreen = true;
      } else if (sawAltScreen) {
        // Saw alt-screen, no longer present. CLI exited via `\x1b[?1049l`.
        clearTool();
        return;
      }
      if (cursorAtShell) {
        // Cursor on a shell PS1. AI CLIs paint input on `>`/`❯` lines or
        // inside box-drawn frames, none of which match SHELL_PROMPT_LINE_PATTERNS.
        clearTool();
        return;
      }
      if (!userSubmittedAtLeastOnce) {
        emit("idle");
        return;
      }
      const lower = content.toLowerCase();
      const now = Date.now();
      pruneRecentOutput(now);

      const workingHit = detectWorking(content, hasFreshOutput());
      const explicitIdle = detectExplicitIdle(content, lower);
      // Rate-based fallback fires only when the cursor is inside the CLI.
      // Restores working detection for inline tools (claude v2.1+, opencode).
      const rateHit = isStreamingOutput();

      // Background agents/workflows render their "N/M agents done" progress
      // below the input box while the main prompt stays interactive, so
      // detectWorking (above-box only) can't see them. Match the viewport and
      // the recent PTY output (pane may be hidden), gated on fresh output so a
      // stale completed line still in scrollback can't pin the badge to working.
      let bgAgentsHit = false;
      if (hasFreshOutput()) {
        bgAgentsHit =
          BACKGROUND_AGENTS_RE.test(content) ||
          (recentOutput.length > 0 && BACKGROUND_AGENTS_RE.test(getRecentOutput()));
      }

      // Blocking is checked against both the viewport and the recent PTY
      // output. The output buffer is the fallback when the pane is hidden
      // and xterm's write queue lags. Skip the fallback while the AI is
      // producing output, so a just-answered prompt cached in the buffer
      // doesn't refire blocking.
      let blockingHit = detectBlocking(content, lower);
      if (!blockingHit && !workingHit && !rateHit && recentOutput.length > 0) {
        const recent = getRecentOutput();
        if (recent) {
          blockingHit = detectBlocking(recent, recent.toLowerCase());
        }
      }

      if (!explicitIdle) {
        // Blocking takes priority over working. Many CLIs render an approval
        // prompt while still showing "esc to cancel" or a token counter, so
        // both signals can fire together. `workingHit` only clears blocking
        // when blocking is absent; `blockingHit` refreshes last so it wins.
        if (workingHit || rateHit || bgAgentsHit) {
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
      // Swallow parse errors. Stay in current state.
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
      // Any PTY input timestamps lastUserInputAt so pushOutput can skip echo bytes.
      if (activeTool) lastUserInputAt = Date.now();
      // ESC prefix means CSI, not a keystroke. Skip char-level processing.
      if (chunk.length > 0 && chunk.charCodeAt(0) === 0x1b) return;

      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        const isEnter = ch === "\r" || ch === "\n";
        if (!activeTool) {
          // Accumulating a shell command. Activate on Enter if it matches a known CLI.
          if (isEnter) {
            let cmd = cmdBuffer;
            cmdBuffer = "";
            if (!cmd) {
              // History recall, shell-completion accept, or paste-then-Enter.
              // `cmdBuffer` is empty; pull the command from the prompt line.
              cmd = extractCommandFromPromptLine(lastNonEmptyLine(safeReadBuffer()));
            }
            const tool = matchTool(cmd);
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
          // Inside the TUI. Printable text + Enter is a submission; flip the
          // chip to working optimistically. Stale-tool cases are caught by
          // `reclassify`'s shell-prompt check before the next emit().
          if (isEnter) {
            if (pendingPrintable) {
              if (!userSubmittedAtLeastOnce) userSubmittedAtLeastOnce = true;
              lastWorkingAt = Date.now() + SUBMIT_OPTIMISTIC_EXTRA_MS;
              hasSeenWorking = true;
              // Drop the recent-output buffer so a just-answered prompt
              // doesn't refire blocking while the AI responds.
              recentOutput = [];
              recentOutputChars = 0;
              // Clear blocking hold for the same reason.
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
      // Decode to text for the recent-output buffer (fallback when viewport lags).
      // `stream: true` reassembles multi-byte codepoints across chunks.
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
      // Skip samples within the echo window so typing doesn't trip the streaming threshold.
      if (now - lastUserInputAt > ECHO_SUPPRESS_MS) {
        outputSamples.push({ t: now, n });
      }
      // Reclassification is timer-driven (250ms) rather than per-chunk.
      // A noisy dev server can emit dozens of chunks per second.
    },
    reset() {
      cmdBuffer = "";
      if (activeTool) clearTool();
    },
    notifyShellPrompt() {
      // New shell prompt while a tool is active means the CLI exited.
      // No-op otherwise; shells also emit OSC 133;A for their first prompt.
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
