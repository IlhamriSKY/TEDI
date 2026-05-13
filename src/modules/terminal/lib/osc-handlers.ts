import type { IMarker, Terminal } from "@xterm/xterm";

export function registerCwdHandler(
  term: Terminal,
  onCwd: (cwd: string) => void,
): () => void {
  const d = term.parser.registerOscHandler(7, (data) => {
    const cwd = parseOsc7(data);
    if (cwd) onCwd(cwd);
    return true;
  });
  return () => d.dispose();
}

export type PromptTracker = {
  getMarker: () => IMarker | null;
  dispose: () => void;
};

export function registerPromptTracker(term: Terminal): PromptTracker {
  let marker: IMarker | null = null;
  const d = term.parser.registerOscHandler(133, (data) => {
    if (data.startsWith("A")) {
      marker?.dispose();
      marker = term.registerMarker(0);
    }
    return true;
  });
  return {
    getMarker: () => (marker && !marker.isDisposed ? marker : null),
    dispose: () => {
      d.dispose();
      marker?.dispose();
      marker = null;
    },
  };
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
  // /C:/Users/foo -> C:/Users/foo so it's a valid Windows path.
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  return path;
}

function parseTediOpen(data: string): TediOpenInput | null {
  // Parse format: "file=/path/to/file"
  const fileMatch = data.match(/file=([^;]+)/);

  if (!fileMatch) return null;

  try {
    return { file: decodeURIComponent(fileMatch[1]) };
  } catch {
    return { file: fileMatch[1] };
  }
}

function parseTediSpawnTab(data: string): TediSpawnTabInput | null {
  // Format: "cwd=/path;cmd=php artisan serve;title=Vite" — all fields optional
  // but at least one must be present. Values are URL-encoded.
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
  }
  if (!out.cwd && !out.cmd && !out.title) return null;
  return out;
}
