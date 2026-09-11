/**
 * The per-repository setup command a new worktree runs before its agent.
 *
 * A fresh worktree shares the repository's history and nothing else: no
 * `node_modules`, no `vendor`, no `.env`. Every one of those is gitignored, so
 * a worktree is checked out without them and the first thing anyone does in one
 * is run the project's install. Remembering that string per repository is the
 * whole of this file.
 *
 * Deliberately NOT a copy of the main checkout's ignored files. Copying
 * `node_modules` is slow, and the native binaries inside it are built against
 * an absolute path, so the copy is broken in ways that surface much later than
 * the copy. Running the project's own install command is the thing the project
 * already supports.
 *
 * No zustand store: this is read once when the create dialog opens and written
 * once when it is submitted, so a subscription would have nothing to notify.
 */
import { LazyStore } from "@tauri-apps/plugin-store";
import { toForwardSlash } from "@/lib/path";

const STORE_PATH = "tedi-worktrees.json";
const KEY = "setupCommands";

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

/** Repo root -> command. Cached so reopening the dialog is not a disk read. */
let cache: Record<string, string> | null = null;

async function all(): Promise<Record<string, string>> {
  if (cache) return cache;
  try {
    cache = (await store.get<Record<string, string>>(KEY)) ?? {};
  } catch {
    // An unreadable store means "no setup command saved yet", which is the
    // same as a repository nobody has set one for. Never a reason to block
    // creating a worktree.
    cache = {};
  }
  return cache;
}

/** The saved setup command for `repoRoot`, or "" when there is none. */
export async function getSetupCommand(repoRoot: string): Promise<string> {
  return (await all())[toForwardSlash(repoRoot)] ?? "";
}

/** Save (or, given an empty string, forget) the setup command for `repoRoot`. */
export async function setSetupCommand(repoRoot: string, command: string): Promise<void> {
  const map = { ...(await all()) };
  const key = toForwardSlash(repoRoot);
  const value = command.trim();
  if (value) map[key] = value;
  else delete map[key];
  cache = map;
  try {
    await store.set(KEY, map);
    await store.save();
  } catch (err) {
    // The command still applies to the worktree being created right now; only
    // the memory of it is lost.
    console.error("worktreeSetup: failed to persist the setup command", err);
  }
}

/**
 * The single command line a new worktree's terminal runs.
 *
 * Chained with `&&` rather than typed as two commands, for two reasons: there
 * is no reliable "the install finished" signal to wait on before typing the
 * second one, and `&&` is also the correct semantics - an agent started on a
 * tree whose install failed would spend its first turn rediscovering that.
 *
 * Returns null when there is nothing to run, so a caller can leave the shell
 * at its prompt rather than typing an empty line into it.
 */
export function worktreeLaunchLine(setup: string, agentCommand: string): string | null {
  const s = setup.trim();
  const a = agentCommand.trim();
  if (s && a) return `${s} && ${a}`;
  return s || a || null;
}
