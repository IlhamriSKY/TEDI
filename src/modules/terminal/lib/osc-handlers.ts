import type { Terminal } from "@xterm/xterm";

export function registerCwdHandler(term: Terminal, onCwd: (cwd: string) => void): () => void {
  const d = term.parser.registerOscHandler(7, (data) => {
    const cwd = parseOsc7(data);
    if (cwd) onCwd(cwd);
    return true;
  });
  return () => d.dispose();
}

export type PromptTracker = {
  dispose: () => void;
};

export type PromptTrackerCallbacks = {
  /** Fires on every OSC 133;A (prompt start). The AI CLI detector uses this to clear non-alt-screen tools. */
  onPromptStart?: () => void;
  /** Fires on OSC 133;C (pre-exec) - a foreground command has started. */
  onCommandStart?: () => void;
  /** Fires on OSC 133;D (command-end). */
  onCommandEnd?: () => void;
};

export function registerPromptTracker(
  term: Terminal,
  callbacks: PromptTrackerCallbacks = {},
): PromptTracker {
  const d = term.parser.registerOscHandler(133, (data) => {
    if (data.startsWith("A")) {
      callbacks.onPromptStart?.();
    } else if (data.startsWith("C")) {
      callbacks.onCommandStart?.();
    } else if (data.startsWith("D")) {
      callbacks.onCommandEnd?.();
    }
    return true;
  });
  return {
    dispose: () => {
      d.dispose();
    },
  };
}

/**
 * OSC 9;4 progress / taskbar-progress (ConEmu origin, adopted by Windows
 * Terminal, Ghostty, WezTerm, Kitty, iTerm2 …). Wire form:
 *   ESC ] 9 ; 4 ; <state> [ ; <progress> ] ST   (ST = BEL or ESC \)
 * States: 0 = clear/remove, 1 = set value (0-100), 2 = error, 3 = indeterminate
 * ("busy", ignores value), 4 = paused. Claude Code emits `9;4;3` while a turn is
 * running - including while background sub-agents work, when the on-screen footer
 * looks idle - and `9;4;0` when the whole turn settles, so this is the most
 * reliable per-turn busy/idle oracle we can read straight from the byte stream
 * (Kitty #55614 shows Claude's `ESC]9;4;0;BEL` on exit). The other OSC 9 payload
 * (a bare message) is an iTerm2-style desktop notification, which we leave for a
 * future "needs attention" edge rather than claim here.
 */
export function registerProgressHandler(
  term: Terminal,
  onProgress: (state: number, progress: number | null) => void,
): () => void {
  const d = term.parser.registerOscHandler(9, (data) => {
    // Only the ConEmu progress sub-protocol ("4;<state>…") is ours; decline the
    // rest (iTerm2 notification message) so any other handler/default can run.
    if (!data.startsWith("4;")) return false;
    const parts = data.split(";");
    const state = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(state)) return false;
    const rawProgress = parts.length > 2 ? Number.parseInt(parts[2], 10) : NaN;
    onProgress(state, Number.isFinite(rawProgress) ? rawProgress : null);
    return true;
  });
  return () => d.dispose();
}

export type TediOpenInput = {
  file: string;
};

export function registerTediOpenHandler(
  term: Terminal,
  onTediOpen: (input: TediOpenInput) => void,
): () => void {
  const d = term.parser.registerOscHandler(8888, (data) => {
    const input = parseTediOpen(data);
    if (input) onTediOpen(input);
    return true;
  });
  return () => d.dispose();
}

export type TediSpawnTabInput = {
  cwd?: string;
  cmd?: string;
  title?: string;
  // When set, splits the previously spawned pane instead of opening a new tab.
  // "row" = new pane right; "col" = new pane below.
  split?: "row" | "col";
};

export function registerTediSpawnTabHandler(
  term: Terminal,
  onSpawnTab: (input: TediSpawnTabInput) => void,
): () => void {
  const d = term.parser.registerOscHandler(8889, (data) => {
    const input = parseTediSpawnTab(data);
    if (input) onSpawnTab(input);
    return true;
  });
  return () => d.dispose();
}

function parseOsc7(data: string): string | null {
  const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!m) return null;
  let path = m[1];
  try {
    path = decodeURIComponent(path);
  } catch {}
  // /C:/Users/foo -> C:/Users/foo for a valid Windows path.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

function parseTediOpen(data: string): TediOpenInput | null {
  // Format: "file=/path/to/file"
  const fileMatch = data.match(/file=([^;]+)/);

  if (!fileMatch) return null;

  try {
    return { file: decodeURIComponent(fileMatch[1]) };
  } catch {
    return { file: fileMatch[1] };
  }
}

function parseTediSpawnTab(data: string): TediSpawnTabInput | null {
  // Format: "cwd=/path;cmd=php artisan serve;title=Vite". All fields optional;
  // at least one required. Values are URL-encoded.
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const out: TediSpawnTabInput = {};
  for (const part of data.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const val = decode(part.slice(eq + 1));
    if (key === "cwd") out.cwd = val;
    else if (key === "cmd") out.cmd = val;
    else if (key === "title") out.title = val;
    else if (key === "split" && (val === "row" || val === "col")) out.split = val;
  }
  if (!out.cwd && !out.cmd && !out.title && !out.split) return null;
  return out;
}
