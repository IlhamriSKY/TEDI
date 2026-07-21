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

/**
 * Hold `blocking` this long after the last approval marker. Cleared by any fresh
 * working hit. A REAL approval prompt stays on screen and re-refreshes this every
 * reclassify tick, so the hold only has to bridge a momentary detection gap (a
 * redraw) - it does NOT need to outlast a long wait. Kept short so a one-off
 * false-positive substring match (Claude prose containing "[y/n]", "continue?",
 * etc.) clears in seconds instead of freezing the badge red for a minute.
 */
const BLOCKING_HOLD_MS = 20_000;

/**
 * Crash-safety window for the OSC 9;4 progress busy signal. The protocol has no
 * auto-clear, so a tool that set "busy" (state 3) and died without sending
 * "clear" (state 0) would otherwise pin the badge to working forever. A genuine
 * turn (however long, incl. subagents) animates its spinner/elapsed timer, so
 * `hasFreshOutput()` stays true throughout; once BOTH the last progress update is
 * older than this AND output has stopped, we stop trusting a stuck "busy". Tool
 * exit is handled earlier/harder by `clearTool` (shell prompt / alt-screen exit).
 * Generous (20s) so a quiet gap in a long turn never trips it. Mirrors Ghostty's
 * ~15s staleness timeout, but combined with output-freshness instead of replacing it.
 */
const PROGRESS_STALE_MS = 20_000;

/**
 * How long to keep trusting a tool's own "busy" flag (OSC 9;4 state 1/3) as
 * *working* after its last progress update, even with no on-screen output, so a
 * long QUIET stretch inside one turn (a Claude subagent that goes silent for a
 * while) never expires the working hold and fires a premature "done". Far longer
 * than PROGRESS_STALE_MS because the tool's own clear (state 0) or the shell
 * prompt (clearTool) is the real turn-end signal; this is only the backstop for
 * a missed clear, so it stays generous but bounded.
 */
const PROGRESS_BUSY_TRUST_MS = 60_000;

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
// Trailing `(?![\w.-])` (NOT `\b`): `\b` counts a trailing `-`/`.` as a word
// boundary, so after `normalizeCommandForMatch` basenames the first token,
// `claude-monitor` / `codex-wrapper.sh` / `goose-linux-amd64` / `claude.ts`
// would falsely match `claude`/`codex`/`goose`. The negative lookahead rejects
// a following letter, digit, `_`, `-`, or `.`, so only the exact tool name (or an explicit
// `-code`/`-cli` variant listed below) activates.
const TOOL_PATTERNS: { tool: AiCliKind; commands: RegExp }[] = [
  { tool: "claude", commands: /^\s*claude(?:-code)?(?![\w.-])/ },
  { tool: "codex", commands: /^\s*codex(?![\w.-])/ },
  { tool: "opencode", commands: /^\s*opencode(?![\w.-])/ },
  { tool: "copilot", commands: /^\s*(?:gh\s+copilot|copilot)(?![\w.-])/ },
  { tool: "pi", commands: /^\s*pi(?![\w.-])/ },
  { tool: "aider", commands: /^\s*aider(?![\w.-])/ },
  { tool: "gemini", commands: /^\s*(?:gemini-cli|gemini)(?![\w.-])/ },
  { tool: "amazon-q", commands: /^\s*(?:q\s+chat|q\s+code|amazon-q)(?![\w.-])/ },
  { tool: "cody", commands: /^\s*cody(?![\w.-])/ },
  { tool: "goose", commands: /^\s*goose(?![\w.-])/ },
  { tool: "cursor", commands: /^\s*cursor-agent(?![\w.-])/ },
  { tool: "ollama", commands: /^\s*ollama\s+run(?![\w.-])/ },
];

/**
 * Normalize a typed command so a tool still activates when launched indirectly:
 * strip a leading package runner (`npx claude`, `bunx opencode`, `pnpm dlx …`)
 * and reduce an absolute/relative path in the first token to its basename
 * (`/usr/local/bin/claude` -> `claude`, `@anthropic-ai/claude-code` ->
 * `claude-code`). Widens activation coverage for indirect launches without
 * touching the per-tool patterns.
 */
function normalizeCommandForMatch(line: string): string {
  let s = line.replace(/^\s+/, "");
  s = s.replace(
    /^(?:sudo\s+)?(?:npx|bunx|pnpm\s+dlx|pnpm\s+exec|yarn\s+dlx|yarn\s+exec|npm\s+exec|deno\s+run)\s+(?:-{1,2}\S+\s+)*/i,
    "",
  );
  const m = s.match(/^(\S+)([\s\S]*)$/);
  if (m) {
    const first = m[1];
    const slash = Math.max(first.lastIndexOf("/"), first.lastIndexOf("\\"));
    if (slash >= 0) s = first.slice(slash + 1) + m[2];
  }
  return s;
}

function matchTool(line: string): AiCliKind | null {
  const norm = normalizeCommandForMatch(line);
  for (const t of TOOL_PATTERNS) {
    if (t.commands.test(norm)) return t.tool;
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

export function isSpinnerLeadChar(ch: string): boolean {
  if (SPINNER_CHARS.has(ch)) return true;
  const code = ch.codePointAt(0) ?? 0;
  return code >= BRAILLE_LO && code <= BRAILLE_HI;
}

/**
 * Tools that prefix their OSC 0/2 window title with a spinner/status glyph while
 * a turn is in progress and drop it when the turn ends. The title is set by the
 * real process, so it reflects the tool's true state even when the on-screen
 * footer looks idle - exactly the subagent case: Claude Code can render an
 * interactive-looking prompt while background sub-agents run, but its title keeps
 * the working glyph throughout. So a leading working glyph is a strong working
 * signal we trust over the screen heuristics. Per-tool (research-verified):
 * Claude Code = cycling Braille spinner / its `✳` brand mark; Codex = animated
 * spinner via OSC 0; Gemini CLI = `✦` Working (`◇` Ready, `✋` Action Required -
 * see TITLE_APPROVAL_TOOLS). Reuses the curated SPINNER_CHARS alphabet (which
 * already includes `✦`; middle-dot excluded) that
 * `terminalTitles.stripLeadingStatusGlyph` strips, so the two stay consistent.
 * NOTE: Claude leaves a STALE title on exit/`/clear`, so titleHit is gated on
 * hasFreshOutput() in reclassify - a stale glyph with no output never fires.
 */
const TITLE_GLYPH_TOOLS: ReadonlySet<AiCliKind> = new Set<AiCliKind>(["claude", "codex", "gemini"]);

/**
 * Tools that put a DISTINCT "waiting for the user" glyph in the title: Gemini's
 * `✋` Action Required. A deterministic blocking signal - and, unlike a working
 * glyph, it must NOT be output-gated (an approval wait produces no output).
 * Bounded by clearTool on CLI exit and by the tool replacing the glyph once the
 * user answers. Claude/Codex have no distinct approval title, so they are absent.
 */
const TITLE_APPROVAL_TOOLS: ReadonlySet<AiCliKind> = new Set<AiCliKind>(["gemini"]);
const TITLE_APPROVAL_CHARS = new Set(Array.from("✋"));

/** First non-whitespace, non-variation-selector char of a title, or "". */
function titleLeadChar(title: string): string {
  for (let i = 0; i < title.length; i++) {
    const ch = title[i];
    const code = title.charCodeAt(i);
    if (ch === " " || ch === "\t") continue;
    if (code >= 0xfe00 && code <= 0xfe0f) continue; // variation selector
    return ch;
  }
  return "";
}

/**
 * True when a window title begins with a spinner lead glyph - i.e. the program
 * is signalling an in-progress turn. Mirrors the leading-glyph scan in
 * `terminalTitles.stripLeadingStatusGlyph`.
 */
export function titleIndicatesWorking(title: string): boolean {
  return isSpinnerLeadChar(titleLeadChar(title));
}

/** True when a window title begins with an "action required" glyph (Gemini `✋`). */
function titleIndicatesApproval(title: string): boolean {
  return TITLE_APPROVAL_CHARS.has(titleLeadChar(title));
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

/**
 * Returns viewport content *below* the TUI input box - the region where tools
 * like Claude Code paint live background-task progress ("N/M agents done")
 * underneath the prompt and footer. Mirrors `contentAbovePromptBox`: returns
 * everything after the last horizontal-rule line (the box's bottom border);
 * falls back to the bottom 30% of lines when no box is drawn. Scanning only
 * this region keeps a historical "agents" mention in the conversation
 * scrollback (above the box) from being mistaken for a live progress line.
 */
function contentBelowPromptBox(content: string): string {
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isBorderLine(lines[i])) return lines.slice(i + 1).join("\n");
  }
  const trim = Math.max(3, Math.floor(lines.length * 0.3));
  return lines.slice(Math.max(0, lines.length - trim)).join("\n");
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
  // Codex CLI approval prompts (source-verified exact phrasing).
  "would you like to run the following command?",
  "would you like to make the following edits?",
  "would you like to grant these permissions?",
  "do you want to approve network access",
  // Gemini CLI approvals. NOTE: Gemini's "(esc to cancel, Ns)" is a WORKING
  // marker (handled in detectWorking), deliberately NOT listed here - which is
  // why bare "esc to cancel" is no longer a blocking substring (it falsely
  // flagged Gemini's spinner as waiting-for-approval).
  "apply this change?",
  "allow execution of",
  // opencode / crush permission gate.
  "permission required",
  // GitHub Copilot CLI.
  "yes, and approve",
];

// Confirmation prefixes. The phrase alone isn't enough since chat content
// can quote them, so we also require "yes" or a cursor `❯` in the same region.
const CONFIRMATION_PREFIXES = ["do you want", "would you like", "are you sure"] as const;

// How far past the confirmation phrase to look for the "yes"/cursor that turns
// it into a real prompt. A genuine confirmation puts the option right there
// (same or next few lines, possibly across a short command/diff preview); a
// conversational "What would you like to do?" does not - and the AI CLI's
// always-present input-box cursor (❯) sits many lines below, so an UNBOUNDED
// search wrongly flagged every such message as blocking. Scoping the window
// fixes that false positive; the markers below are specific enough (an empty
// input cursor never matches) that a few extra lines stay safe.
const CONFIRMATION_ANSWER_WINDOW = 400;

// An explicit yes/no choice near a confirmation phrase: a selection cursor on
// a Yes/No option (`❯ Yes`, `▶ 1. No`) or a `(y)`/`(n)`/`y/n`/`yes/no` gate.
// A bare "yes" or the always-present input-box cursor is NOT enough - that is
// what made conversational "What would you like to do?" read as blocking.
const CHOICE_CURSOR_RE = /[❯▶]\s*(?:\d+[.)]\s*)?(?:yes|no)\b/i;
const YES_NO_GATE_RE = /\(\s*y\s*\)|\(\s*n\s*\)|\by\s*\/\s*n\b|\byes\s*\/\s*no\b/i;

function hasConfirmationPrompt(content: string, lowerContent: string): boolean {
  // The LAST occurrence: a live prompt is the most recent output, while an
  // earlier conversational "would you like..." can sit higher in the scrollback
  // and would otherwise shadow the real prompt below it (first-match-only miss).
  let pos = -1;
  for (const prefix of CONFIRMATION_PREFIXES) {
    const at = lowerContent.lastIndexOf(prefix);
    if (at > pos) pos = at;
  }
  if (pos < 0) return false;
  const window = content.slice(pos, pos + CONFIRMATION_ANSWER_WINDOW);
  return CHOICE_CURSOR_RE.test(window) || YES_NO_GATE_RE.test(window);
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

// Background-agent / workflow progress line, e.g. "26/43 agents done" or
// "1/6 agents". Claude Code (and similar tools) hand control back to an
// interactive prompt while a background workflow runs, so the spinner +
// "esc to interrupt" hints above the input box are gone even though agents are
// still working. This line renders *below* the input box, so detectWorking
// (above-box only) never sees it.
//
// The fraction is captured so we can tell in-progress (done < total, still
// working) from complete (done === total, the line that lingers on screen
// after the run finishes). Only the in-progress form is a working signal -
// a finished "43/43 agents done" must NOT pin the badge to "working", which
// is what previously required a fresh-output gate as a crude staleness proxy.
const BACKGROUND_AGENTS_RE = /\b(\d+)\s*\/\s*(\d+)\s+agents?\b/gi;

/** True when any "N/M agents" fraction in `text` is still in progress (N < M). */
function hasInProgressBackgroundAgents(text: string): boolean {
  for (const m of text.matchAll(BACKGROUND_AGENTS_RE)) {
    const done = Number(m[1]);
    const total = Number(m[2]);
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0 && done < total) {
      return true;
    }
  }
  return false;
}

// Live token counter like "↓ 279 tokens". Near-universal during streaming.
const TOKEN_COUNTER_RE = /[↓↑⬇⬆]\s*\d[\d.,]*\s*(?:k|m)?\s*tokens?/i;
// Gemini CLI loading indicator: "(esc to cancel, 12s)". The parenthesized form
// (with or without the elapsed-seconds timer) marks ACTIVE generation, not a
// wait - so it is a working signal and must never be read as blocking. This is
// why bare "esc to cancel" was removed from BLOCKED_SUBSTRINGS.
const GEMINI_WORKING_RE = /\(\s*esc to cancel\b/i;
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
  // Gemini's "(esc to cancel, Ns)" loading line is active generation, not a wait.
  if (GEMINI_WORKING_RE.test(above)) return true;
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
  /**
   * Tool to pre-activate at creation, bypassing the type-a-command gate. Set
   * on workspace restore so a still-running agent (reattached PTY) resumes
   * being classified immediately instead of staying dark until the user runs a
   * new command. Self-correcting: the first reclassify tick clears it if the
   * cursor is at a shell prompt (the agent had already exited).
   */
  initialTool?: AiCliKind;
};

export type AiCliDetector = {
  /** xterm `onData` payloads: keystrokes and xterm-to-PTY CSIs. */
  pushInput: (chunk: string) => void;
  /** PTY output bytes. Drives the streaming-rate fallback. */
  pushOutput: (chunk: Uint8Array | string) => void;
  /**
   * xterm `onTitleChange` payloads (OSC 0/2 window title). Drives the
   * title-glyph working signal for {@link TITLE_GLYPH_TOOLS}.
   */
  pushTitle: (title: string) => void;
  /**
   * OSC 9;4 progress updates from the byte stream (state: 0 clear, 1 value,
   * 2 error, 3 indeterminate/busy, 4 paused). The most reliable per-turn
   * busy/idle oracle for tools that emit it (Claude Code).
   */
  pushProgress: (state: number, progress: number | null) => void;
  /** Drop the active tool. */
  reset: () => void;
  /**
   * Mark a finished ("done") terminal as attended-to (the user focused it),
   * decaying the held "done" back to idle. Also called internally on typing.
   */
  acknowledge: () => void;
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
  // "done" state machine. `turnInProgress` = a genuine turn is running (a real
  // submit or a working signal), so a mere startup settle never counts. On the
  // working->quiet edge it flips to a held `pendingDone` (finished, awaiting
  // attention) until the user attends (`doneAcknowledged` via focus/typing),
  // then it decays to idle. A fresh turn clears the ack so the next finish
  // shows done again.
  let turnInProgress = false;
  let pendingDone = false;
  let doneAcknowledged = false;
  /** Latest OSC 0/2 title carries a leading spinner glyph (see TITLE_GLYPH_TOOLS). */
  let lastTitleIsWorking = false;
  /** Latest title carries a distinct "action required" glyph (see TITLE_APPROVAL_TOOLS). */
  let lastTitleIsApproval = false;
  /** Last OSC 9;4 progress state was busy (1=value / 3=indeterminate). */
  let progressWorking = false;
  /** Wall-clock ms of the last OSC 9;4 progress update. See PROGRESS_STALE_MS. */
  let lastProgressAt = 0;

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
    turnInProgress = false;
    pendingDone = false;
    doneAcknowledged = false;
    lastTitleIsWorking = false;
    lastTitleIsApproval = false;
    progressWorking = false;
    lastProgressAt = 0;
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

  /**
   * The user has attended to a finished ("done") terminal (focused it or typed
   * in it). Clear the held done so it decays to idle now, and remember the ack
   * so reclassify doesn't immediately re-raise it. A new turn resets the ack.
   */
  function acknowledgeDone() {
    if (!activeTool) return;
    if (!pendingDone && lastEmittedState !== "done") return;
    pendingDone = false;
    doneAcknowledged = true;
    emit("idle");
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

      // Title-glyph signal: the tool's own OSC 0/2 title still carries a working
      // glyph (see TITLE_GLYPH_TOOLS). This is the process speaking, so it beats
      // the screen heuristics - it is what lets us keep "working" through a
      // subagent run, where the footer reads as idle (explicitIdle) yet the title
      // keeps its glyph. Gated on hasFreshOutput() so a title the tool forgot to
      // reset on exit can't pin the badge to "working" forever: real work always
      // animates its spinner/elapsed timer, so fresh bytes are present throughout;
      // once output truly stops, the glyph decays out within the working hold.
      const titleHit =
        TITLE_GLYPH_TOOLS.has(activeTool) && lastTitleIsWorking && hasFreshOutput();

      // OSC 9;4 progress signal: the STRONGEST, most deterministic working oracle.
      // The tool itself reports "busy" (state 1/3) until it reports "clear" (0),
      // so this is the one signal that survives the subagent case even when the
      // footer reads idle AND output goes quiet. NOT gated on hasFreshOutput (that
      // is the whole point - quiet background subagents). Bounded only by the
      // crash-safety window: trust a busy state while it is fresh OR output is
      // still flowing; see PROGRESS_STALE_MS. Cleared deterministically by state 0
      // and by clearTool on CLI exit.
      const progressHit =
        progressWorking && (now - lastProgressAt < PROGRESS_STALE_MS || hasFreshOutput());

      // Background agents/workflows render their "N/M agents done" progress
      // below the input box while the main prompt stays interactive, so
      // detectWorking (above-box only) can't see them. We scan the below-box
      // region of the viewport (plus the recent PTY output as a hidden-pane
      // fallback) and treat only an *in-progress* fraction (N < M) as working.
      //
      // This is intentionally NOT gated on hasFreshOutput(): a workflow's
      // progress can update only once per completed agent - minutes apart -
      // which is far longer than the sub-second fresh-output window, so gating
      // on it dropped the signal during the quiet gaps and fired a premature
      // "finished". The N < M check (not freshness) is what now rules out a
      // completed "M/M agents done" line lingering on screen.
      let bgAgentsHit = hasInProgressBackgroundAgents(contentBelowPromptBox(content));
      if (!bgAgentsHit && recentOutput.length > 0) {
        bgAgentsHit = hasInProgressBackgroundAgents(getRecentOutput());
      }

      // Blocking is checked against both the viewport and the recent PTY
      // output. The output buffer is the fallback when the pane is hidden
      // and xterm's write queue lags. Skip the fallback while the AI is
      // producing output, so a just-answered prompt cached in the buffer
      // doesn't refire blocking.
      let blockingHit = detectBlocking(content, lower);
      // Gemini's "✋ Action Required" title is a deterministic approval signal -
      // it holds even when no approval text is on screen and no output flows
      // (the AI is idle waiting for the user), so it is NOT output-gated.
      if (!blockingHit && lastTitleIsApproval) blockingHit = true;
      if (!blockingHit && !workingHit && !rateHit && recentOutput.length > 0) {
        const recent = getRecentOutput();
        if (recent) {
          blockingHit = detectBlocking(recent, recent.toLowerCase());
        }
      }

      // Veto blocking when the tool is clearly mid-generation: an "esc to
      // interrupt" / "ctrl+c to interrupt" / Gemini "esc to cancel" hint offers
      // to stop the RUNNING generation, which is mutually exclusive with waiting
      // on the user for approval. Without this, a false-positive blocked
      // substring in the streaming output (or a leftover prompt above) paints an
      // actively-working turn red. The Gemini "✋ Action Required" title
      // (lastTitleIsApproval) is a real wait and never shows an interrupt hint,
      // so it is not affected.
      if (blockingHit) {
        const genAbove = contentAbovePromptBox(content);
        const genLower = genAbove.toLowerCase();
        if (
          genLower.includes("esc to interrupt") ||
          genLower.includes("ctrl+c to interrupt") ||
          GEMINI_WORKING_RE.test(genAbove)
        ) {
          blockingHit = false;
        }
      }

      // An in-progress "N/M agents" line outranks an explicit-idle hint: if a
      // background workflow is genuinely still running, a stray search box or
      // toggle hint elsewhere on screen must not flip the badge to idle.
      if (!explicitIdle || bgAgentsHit || titleHit || progressHit) {
        // Blocking takes priority over working. Many CLIs render an approval
        // prompt while still showing a token counter, so both signals can fire
        // together. `workingHit` only clears blocking when blocking is absent;
        // `blockingHit` refreshes last so it wins.
        if (workingHit || rateHit || bgAgentsHit || titleHit || progressHit) {
          lastWorkingAt = now;
          hasSeenWorking = true;
          // Any live working signal means a genuine turn is running, so its end
          // will raise "done". (A mere startup settle produces no such signal.)
          turnInProgress = true;
          if (!blockingHit) lastBlockingAt = 0;
        }
        if (blockingHit && hasSeenWorking) lastBlockingAt = now;
      }

      // The tool still reports busy (OSC 9;4) → trust it as WORKING past the
      // working hold, even through a long quiet stretch, so "done" never fires
      // mid-turn. Its own clear (progressWorking → false) or a shell prompt
      // (clearTool, handled above) is the real turn-end. Bounded by
      // PROGRESS_BUSY_TRUST_MS as a backstop for a missed clear.
      const busyTrusted =
        progressWorking && (hasFreshOutput() || now - lastProgressAt < PROGRESS_BUSY_TRUST_MS);

      if (now - lastBlockingAt < BLOCKING_HOLD_MS) {
        // A fresh approval wait supersedes any pending "done".
        pendingDone = false;
        emit("blocking");
      } else if (now - lastWorkingAt < WORKING_HOLD_MS || busyTrusted) {
        // Within the working hold, OR the tool itself still reports busy.
        // On the edge into working, clear a prior ack so the next finish shows
        // "done" again.
        if (lastEmittedState !== "working") {
          pendingDone = false;
          doneAcknowledged = false;
        }
        emit("working");
      } else {
        // Neither working nor blocking: if a real turn just ended, hold "done"
        // until the user attends; otherwise idle.
        if (lastEmittedState === "working" && turnInProgress) {
          pendingDone = true;
          turnInProgress = false;
        }
        if (pendingDone && !doneAcknowledged) emit("done");
        else emit("idle");
      }
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

  const detector = {
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
              // A real submit starts a genuine turn, so its end raises "done".
              turnInProgress = true;
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
            // Typing into a finished terminal = attending to it: clear "done".
            acknowledgeDone();
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
    pushTitle(title: string) {
      if (!activeTool) return;
      const working = TITLE_GLYPH_TOOLS.has(activeTool) && titleIndicatesWorking(title);
      lastTitleIsWorking = working;
      // Gemini's "✋ Action Required" title (mutually exclusive with its "✦"
      // working glyph) is a deterministic approval signal; reclassify reads it.
      lastTitleIsApproval = TITLE_APPROVAL_TOOLS.has(activeTool) && titleIndicatesApproval(title);
      if (working) {
        // The real process is signalling an in-progress turn. Seed the same
        // optimistic working window a submit does so the badge flips even if the
        // user never typed inside the TUI this session (e.g. `claude -c` resumes
        // straight into work). reclassify() re-confirms via the gated titleHit.
        if (!userSubmittedAtLeastOnce) userSubmittedAtLeastOnce = true;
        hasSeenWorking = true;
        turnInProgress = true;
        lastWorkingAt = Date.now();
      } else if (lastTitleIsApproval) {
        // An approval wait is a real turn boundary too; satisfy the blocking
        // gate's hasSeenWorking precondition even if we never saw a working tick.
        if (!userSubmittedAtLeastOnce) userSubmittedAtLeastOnce = true;
        hasSeenWorking = true;
      }
    },
    pushProgress(state: number, _progress: number | null) {
      lastProgressAt = Date.now();
      // 1 = set value, 3 = indeterminate => busy. 0 = clear, 2 = error,
      // 4 = paused => not busy.
      progressWorking = state === 1 || state === 3;
      if (progressWorking && activeTool) {
        // Deterministic busy from the tool itself. Seed working immediately so
        // the badge flips without waiting for the next reclassify tick, and arm
        // the optimistic window even if the user never typed inside the TUI
        // (e.g. `claude -c` resumes straight into work).
        if (!userSubmittedAtLeastOnce) userSubmittedAtLeastOnce = true;
        hasSeenWorking = true;
        turnInProgress = true;
        lastWorkingAt = Date.now();
      }
    },
    reset() {
      cmdBuffer = "";
      if (activeTool) clearTool();
    },
    acknowledge() {
      acknowledgeDone();
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
  } satisfies AiCliDetector;

  // Restore path: resume classifying a reattached, still-running agent. Emits
  // `idle` for now and lets the normal signals (OSC 9;4 / title / viewport /
  // streaming-rate) upgrade it to working/blocking; a shell-prompt tick clears
  // a stale one. `userSubmittedAtLeastOnce` is forced so the viewport + rate
  // branches (gated on it) can run WITHOUT a keystroke this session - otherwise
  // a resumed streaming-only agent (no OSC 9;4 / title glyph: aider, opencode,
  // cody, goose, cursor) would sit at "idle" until the user typed. reclassify's
  // cursorAtShell / alt-exit checks run BEFORE that gate, so a dead reattach
  // (fresh shell prompt) still clears to idle instead of false-flagging.
  if (opts.initialTool) {
    activateTool(opts.initialTool);
    userSubmittedAtLeastOnce = true;
  }

  return detector;
}
