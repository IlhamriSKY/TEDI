/**
 * Slash commands defined as markdown files, so a team's prompts live in the
 * repository instead of in one person's Settings.
 *
 *   <workspace>/.tedi/commands/<name>.md   project, checked in
 *   <workspace>/.claude/commands/<name>.md read too, so Claude Code's work as is
 *   ~/.tedi/commands/<name>.md             yours, every project
 *
 * The file body is the prompt. `$ARGUMENTS` is replaced by everything typed
 * after the command and `$1`..`$9` by its words; a body using neither gets the
 * arguments appended. Optional frontmatter: `description` and `argument-hint`
 * (Claude Code's keys). The first definition of a name wins, in the order
 * above, and a built-in command is never shadowed.
 *
 * Read when the `/` picker opens and when a command is sent, not watched: a
 * folder of small files, looked at only when someone reaches for it.
 */
import { homeDir } from "@tauri-apps/api/path";
import { create } from "zustand";
import { native } from "./native";

export type FileCommand = {
  /** What follows the `/`: the file name, lowercased to `[a-z0-9-]`. */
  name: string;
  description: string;
  argHint?: string;
  body: string;
  /** Where it came from, shown in the picker. */
  source: "project" | "user";
};

/** Bigger than any prompt anyone writes by hand; a stray log file is skipped. */
const MAX_BYTES = 64 * 1024;

export function commandNameFromFile(file: string): string | null {
  if (!/\.md$/i.test(file)) return null;
  const name = file
    .slice(0, -3)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name || null;
}

/** Frontmatter keys and the body under it. Only flat `key: value` lines. */
export function parseCommandFile(text: string): {
  description: string;
  argHint?: string;
  body: string;
} {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta: Record<string, string> = {};
  if (m) {
    for (const line of m[1].split("\n")) {
      const kv = line.match(/^([\w-]+)\s*:\s*(.*)$/);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  const body = (m ? src.slice(m[0].length) : src).trim();
  const firstLine =
    body
      .split("\n")
      .find((l) => l.trim())
      ?.replace(/^#+\s*/, "") ?? "";
  return {
    description: meta.description || firstLine.slice(0, 100),
    argHint: meta["argument-hint"] || undefined,
    body,
  };
}

/** The prompt a command sends for `args`. Pure, so a verify can pin it. */
export function expandCommand(body: string, args: string): string {
  const words = args.split(/\s+/).filter(Boolean);
  let used = false;
  const out = body
    .replace(/\$ARGUMENTS/g, () => {
      used = true;
      return args;
    })
    .replace(/\$([1-9])/g, (_, d: string) => {
      used = true;
      return words[Number(d) - 1] ?? "";
    });
  return !used && args ? `${out}\n\n${args}` : out;
}

async function readCommandsDir(dir: string, source: FileCommand["source"]): Promise<FileCommand[]> {
  let entries;
  try {
    entries = await native.readDir(dir);
  } catch {
    return [];
  }
  const out: FileCommand[] = [];
  for (const e of entries) {
    if (e.kind === "dir" || e.size > MAX_BYTES) continue;
    const name = commandNameFromFile(e.name);
    if (!name) continue;
    try {
      const r = await native.readFile(`${dir}/${e.name}`);
      if (r.kind !== "text") continue;
      const parsed = parseCommandFile(r.content);
      if (parsed.body) out.push({ name, source, ...parsed });
    } catch {
      // Unreadable file: skip it, keep the rest.
    }
  }
  return out;
}

let homePromise: Promise<string | null> | null = null;

async function loadCommands(workspaceRoot: string | null, reserved: Set<string>) {
  const home = await (homePromise ??= homeDir()
    .then((h) => h.replace(/\\/g, "/").replace(/\/+$/, ""))
    .catch(() => null));
  const root = workspaceRoot?.replace(/\\/g, "/").replace(/\/+$/, "") ?? null;
  const lists = await Promise.all([
    root ? readCommandsDir(`${root}/.tedi/commands`, "project") : [],
    root ? readCommandsDir(`${root}/.claude/commands`, "project") : [],
    home ? readCommandsDir(`${home}/.tedi/commands`, "user") : [],
  ]);
  const seen = new Set(reserved);
  const out: FileCommand[] = [];
  for (const c of lists.flat()) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

type FileCommandsState = {
  commands: FileCommand[];
  /** Re-read the folders for `workspaceRoot`. Built-in names in `reserved` are skipped. */
  refresh: (workspaceRoot: string | null, reserved: Set<string>) => Promise<FileCommand[]>;
};

export const useFileCommands = create<FileCommandsState>((set) => ({
  commands: [],
  refresh: async (workspaceRoot, reserved) => {
    const commands = await loadCommands(workspaceRoot, reserved);
    set({ commands });
    return commands;
  },
}));
