/**
 * Runs a user-defined external formatter by shelling out via the Rust
 * `fmt_run_external` command.
 *
 * Two modes, chosen by whether any arg contains the `${file}` placeholder:
 *
 *   stdin mode (no placeholder)
 *       The buffer is piped to the program's stdin; stdout is the result.
 *       Works with: gofmt, prettier, `rustfmt --emit stdout`, dprint, biome,
 *       `black -`, `ruff format -`, etc.
 *
 *   temp-file mode (one or more args contain `${file}`)
 *       The buffer is written to a temp file with the original extension,
 *       `${file}` in args is substituted with the temp path, and after
 *       the command exits the temp file is read back as the result.
 *       Works with: in-place formatters like `php-cs-fixer fix --quiet`,
 *       `clang-format -i`, `rustfmt`, `shfmt -w`, etc.
 *
 * The program is spawned directly (no shell wrapper) so quoting in user
 * args is literal.
 */

import { invoke } from "@tauri-apps/api/core";
import type { FsReadResult } from "@/lib/ipc";

type FormatOutput = {
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  truncated: boolean;
};

const TEMP_FILE_TOKEN = "${file}";

function dirOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx === -1 ? "" : norm.slice(0, idx);
}

function extFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot); // includes leading dot, e.g. ".rs"
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function tempFilePath(originalPath: string): Promise<string> {
  const ext = extFromPath(originalPath);
  // Tauri's tempDir would need an extra plugin, so write the temp file beside
  // the original with a hidden prefix instead.
  const dir = dirOf(originalPath);
  const name = `.tedi-fmt-${randomToken()}${ext}`;
  return dir ? `${dir}/${name}` : name;
}

async function writeFile(path: string, content: string): Promise<void> {
  await invoke("fs_write_file", { path, content });
}

async function readFile(path: string): Promise<string> {
  const res = await invoke<FsReadResult>("fs_read_file", { path });
  if (res.kind !== "text") throw new Error(`formatter produced non-text output (${res.kind})`);
  return res.content;
}

async function deleteFile(path: string): Promise<void> {
  try {
    await invoke("fs_delete", { path });
  } catch {
    // Best-effort cleanup. A stale temp file isn't fatal.
  }
}

/** Thrown when the formatter binary can't be launched (not installed / not on
 *  PATH). Format-on-save treats this as "no formatter" and stays silent so a
 *  user with format-on-save enabled isn't nagged for languages whose tool they
 *  don't have; explicit "Format Document" still surfaces it. */
export class FormatterUnavailableError extends Error {
  constructor(public program: string) {
    super(`Formatter "${program}" is not installed or not on PATH.`);
    this.name = "FormatterUnavailableError";
  }
}

/** Invokes the Rust runner, mapping a spawn failure to a typed error so the
 *  caller can distinguish "binary missing" from "formatter ran and errored". */
async function runFormatter(params: {
  program: string;
  args: string[];
  stdin: string | null;
  cwd: string | undefined;
  timeoutSecs: number | undefined;
}): Promise<FormatOutput> {
  try {
    return await invoke<FormatOutput>("fmt_run_external", params);
  } catch (e) {
    const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    if (msg.includes("spawn failed") || msg.includes("empty program")) {
      throw new FormatterUnavailableError(params.program);
    }
    throw e instanceof Error ? e : new Error(msg);
  }
}

export async function formatWithExternal(args: {
  command: string;
  args: string[];
  content: string;
  /** Editor file's absolute path. Used to derive cwd (so the formatter
   *  resolves project config like .prettierrc / rustfmt.toml relative to
   *  the file) and the temp-file extension. */
  filepath: string;
  timeoutSecs?: number;
}): Promise<string> {
  const usesTempFile = args.args.some((a) => a.includes(TEMP_FILE_TOKEN));
  const cwd = dirOf(args.filepath) || undefined;

  if (!usesTempFile) {
    const res = await runFormatter({
      program: args.command,
      args: args.args,
      stdin: args.content,
      cwd,
      timeoutSecs: args.timeoutSecs,
    });
    if (res.timed_out) {
      throw new Error(`formatter timed out after ${args.timeoutSecs ?? 15}s`);
    }
    if (res.exit_code !== 0) {
      throw new Error(
        `${args.command} exited ${res.exit_code ?? "?"}: ${res.stderr.trim() || res.stdout.trim() || "no output"}`,
      );
    }
    if (res.truncated) {
      throw new Error("formatter output exceeded the 8 MiB cap");
    }
    return res.stdout;
  }

  const tempPath = await tempFilePath(args.filepath);
  await writeFile(tempPath, args.content);
  try {
    const substituted = args.args.map((a) => a.replaceAll(TEMP_FILE_TOKEN, tempPath));
    const res = await runFormatter({
      program: args.command,
      args: substituted,
      stdin: null,
      cwd,
      timeoutSecs: args.timeoutSecs,
    });
    if (res.timed_out) throw new Error(`formatter timed out after ${args.timeoutSecs ?? 15}s`);
    if (res.exit_code !== 0) {
      throw new Error(
        `${args.command} exited ${res.exit_code ?? "?"}: ${res.stderr.trim() || res.stdout.trim() || "no output"}`,
      );
    }
    return await readFile(tempPath);
  } finally {
    await deleteFile(tempPath);
  }
}
