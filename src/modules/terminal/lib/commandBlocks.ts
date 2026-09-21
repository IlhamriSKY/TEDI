/**
 * Per-command bookkeeping on top of OSC 133: where each command's prompt sits,
 * how it exited and how long it ran.
 *
 * Every shell integration TEDI injects already reports the exit code as
 * `133;D;<code>`. This turns that into a mark in the overview ruler (red for a
 * failure), a jump between prompts, and the text a failed command printed, which
 * is what "Ask AI" sends.
 *
 * An empty Enter must not count as a command: pwsh and bash both emit D again
 * for it carrying the PREVIOUS status, so a failure followed by Enter would be
 * reported twice. The first keystroke after a prompt marks where the input
 * starts; if the line from there is blank when D arrives, nothing ran. A
 * command injected without a keystroke (an agent writing to the pty) has no such
 * mark and is taken at its word.
 */
import type { IBufferLine, IDecoration, IMarker, Terminal } from "@xterm/xterm";

export type FinishedCommand = {
  exitCode: number;
  durationMs: number;
  /** The command line as typed, when the input start is known. */
  command: string | null;
  /** The prompt line it ran from. Disposed once scrolled out of the buffer. */
  prompt: IMarker;
  /** The line the NEXT prompt starts on, i.e. just past its output. */
  end: IMarker;
};

/** Exit codes that mean "you interrupted it", not "it failed". */
const INTERRUPTED = new Set([130, -1073741510, 3221225786]);

export function isFailure(exitCode: number): boolean {
  return exitCode !== 0 && !INTERRUPTED.has(exitCode);
}

const MAX_HISTORY = 200;
/** How long the prompt a jump landed on stays highlighted. */
const FLASH_MS = 900;
const FAILED_COLOR = "#f14c4c";
const OK_COLOR = "#3fb950";

export type CommandTracker = {
  /** OSC 133;A. */
  promptStart(): void;
  /** Any keystroke. Marks where the input begins on the current prompt. */
  noteInput(): void;
  /** OSC 133;C, or the Enter that stands in for it on pwsh. */
  commandStart(): void;
  /** OSC 133;D. Null when nothing ran since the prompt. */
  commandEnd(exitCode: number | null): FinishedCommand | null;
  /** Scroll so the previous (-1) or next (+1) command's prompt is on top. */
  scrollToCommand(dir: -1 | 1): void;
  dispose(): void;
};

function lineText(line: IBufferLine | undefined, from = 0): string {
  return line ? line.translateToString(true, from) : "";
}

export function createCommandTracker(term: Terminal): CommandTracker {
  let prompt: IMarker | null = null;
  let input: { marker: IMarker; x: number } | null = null;
  let startedAt = 0;
  const history: { cmd: FinishedCommand; deco: IDecoration | undefined }[] = [];
  // Where the last jump landed. Near the bottom `scrollToLine` clamps and the
  // viewport does not move, so the next jump has to start from here, not from
  // the viewport. Only trusted while the viewport is still where we left it.
  let nav: { line: number; viewportY: number } | null = null;

  const isAlt = () => term.buffer.active.type === "alternate";

  const dropInput = () => {
    input?.marker.dispose();
    input = null;
  };

  // The typed command: from the input mark to the end of its line, plus any
  // soft-wrapped continuation. Null when no keystroke marked where input began.
  const readCommand = (): string | null => {
    if (!input || input.marker.isDisposed) return null;
    const buf = term.buffer.active;
    let y = input.marker.line;
    let out = lineText(buf.getLine(y), input.x);
    while (buf.getLine(y + 1)?.isWrapped) out += lineText(buf.getLine(++y));
    return out.trim();
  };

  return {
    promptStart() {
      if (isAlt()) return;
      // A prompt nothing ran from is dropped rather than kept as a jump target
      // (one that did run was handed to `history` and nulled in `commandEnd`).
      prompt?.dispose();
      dropInput();
      startedAt = 0;
      prompt = term.registerMarker(0) ?? null;
    },

    noteInput() {
      if (input || !prompt || startedAt || isAlt()) return;
      const marker = term.registerMarker(0);
      if (marker) input = { marker, x: term.buffer.active.cursorX };
    },

    commandStart() {
      if (!startedAt) startedAt = Date.now();
    },

    commandEnd(exitCode) {
      const began = startedAt;
      startedAt = 0;
      const from = prompt;
      if (!from || from.isDisposed || !began || exitCode === null || isAlt()) return null;
      const command = readCommand();
      dropInput();
      if (command === "") return null;
      const end = term.registerMarker(0);
      if (!end) return null;
      prompt = null;
      const cmd: FinishedCommand = {
        exitCode,
        durationMs: Date.now() - began,
        command,
        prompt: from,
        end,
      };
      const failed = isFailure(exitCode);
      const deco = term.registerDecoration({
        marker: from,
        overviewRulerOptions: { color: failed ? FAILED_COLOR : OK_COLOR, position: "left" },
      });
      // A failed prompt also gets a bar in the pane's left gutter, where the eye
      // lands when scrolling back through a log.
      if (failed) deco?.onRender((el) => el.classList.add("tedi-cmd-failed"));
      history.push({ cmd, deco });
      if (history.length > MAX_HISTORY) {
        const old = history.shift();
        old?.deco?.dispose();
        old?.cmd.prompt.dispose();
        old?.cmd.end.dispose();
      }
      return cmd;
    },

    scrollToCommand(dir) {
      const buf = term.buffer.active;
      const current = prompt && !prompt.isDisposed ? prompt.line : Number.POSITIVE_INFINITY;
      const lines = history.map((h) => h.cmd.prompt.line).filter((l) => l >= 0 && l < current);
      const ref =
        nav && nav.viewportY === buf.viewportY
          ? nav.line
          : dir < 0 && buf.viewportY >= buf.baseY
            ? current
            : buf.viewportY;
      const target = dir < 0 ? lines.filter((l) => l < ref).at(-1) : lines.find((l) => l > ref);
      if (target === undefined) {
        if (dir > 0) {
          nav = null;
          term.scrollToBottom();
        }
        return;
      }
      term.scrollToLine(target);
      nav = { line: target, viewportY: term.buffer.active.viewportY };
      // A prompt already on the last screen cannot be scrolled to the top, so
      // without a mark the key looks dead for the first few presses.
      const marker = history.find((h) => h.cmd.prompt.line === target)?.cmd.prompt;
      const flash = marker && term.registerDecoration({ marker, width: term.cols, layer: "top" });
      if (flash) {
        flash.onRender((el) => el.classList.add("tedi-cmd-flash"));
        setTimeout(() => flash.dispose(), FLASH_MS);
      }
    },

    dispose() {
      for (const h of history) h.deco?.dispose();
      history.length = 0;
      dropInput();
      prompt = null;
    },
  };
}

/**
 * What a finished command printed, as plain text: its prompt line (so the
 * command is in it even when the input start was unknown) through the line
 * before the next prompt. Keeps the TAIL when it is long, since a build or a
 * test run puts the error at the bottom.
 */
export function readCommandOutput(term: Terminal, cmd: FinishedCommand, maxChars = 12_000): string {
  const buf = term.buffer.active;
  const from = cmd.prompt.line;
  const to = cmd.end.line;
  if (from < 0 || to < from) return "";
  const lines: string[] = [];
  for (let y = from; y < to; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  const text = lines.join("\n").replace(/\s+$/, "");
  return text.length > maxChars ? `…${text.slice(text.length - maxChars)}` : text;
}
