/**
 * Self-check for the shared repository watcher (`scm/repoWatch.ts`).
 * Run: `npx tsx scripts/scm/repo-watch-verify.ts` (part of `pnpm verify`).
 *
 * The git views stopped polling `git status` every 2.5 s and refresh on a host
 * watcher instead. Several views look at one repository at once, so:
 *  1. ONE host watch per root, however many views subscribe.
 *  2. A change (and what it moved) reaches every subscriber, and first drops any
 *     in-flight git read,
 *     so the refresh it triggers cannot join a status from before the change.
 *  3. The watch is released only when the LAST subscriber leaves, with its id.
 *  4. A host that will not watch (older build, network path, huge tree on
 *     Linux) reports inactive, which is what keeps the caller on its poll.
 *  5. The command, its argument names and the Channel reach the Rust side the
 *     way Tauri maps them, and both commands are registered.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

type Call = { cmd: string; args: Record<string, unknown> };
const calls: Call[] = [];
const callbacks: ((raw: unknown) => void)[] = [];
let watchResult: () => Promise<unknown> = async () => 7;
let statusResolvers: ((v: unknown) => void)[] = [];
(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    transformCallback: (cb: (raw: unknown) => void) => {
      callbacks.push(cb);
      return callbacks.length;
    },
    unregisterCallback: () => {},
    invoke: (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "git_watch") return watchResult();
      if (cmd === "git_status") return new Promise((r) => statusResolvers.push(r));
      return Promise.resolve(null);
    },
  },
  dispatchEvent: () => true,
};
const count = (cmd: string) => calls.filter((c) => c.cmd === cmd).length;
const tick = () => new Promise((r) => setTimeout(r, 0));

const { watchRepo } = await import("../../src/modules/scm/repoWatch");
const { gitStatus } = await import("../../src/modules/scm/api");
const REPO = "D:/repo";

console.log("1. one host watch per root");
const hits: string[] = [];
const a = watchRepo(REPO, (c) => hits.push(`a:${c.tracked}/${c.ignored}`));
const b = watchRepo(REPO, (c) => hits.push(`b:${c.tracked}/${c.ignored}`));
assert(count("git_watch") === 1, "two subscribers, one git_watch");
assert((await a.active) && (await b.active), "both see the watch as active");
const watchArgs = calls.find((c) => c.cmd === "git_watch")!.args;
assert(watchArgs.root === REPO, "the root is passed as `root`");
assert(
  typeof (watchArgs.onChange as { toJSON?: () => string })?.toJSON === "function" &&
    String((watchArgs.onChange as { toJSON: () => string }).toJSON()).startsWith("__CHANNEL__:"),
  "the Channel is passed as `onChange`",
);

console.log("2. a change reaches everyone and drops in-flight reads");
{
  const poll = gitStatus(REPO);
  const before = count("git_status");
  callbacks[callbacks.length - 1]({ index: 0, message: { tracked: false, ignored: true } });
  assert(hits.join(",") === "a:false/true,b:false/true", "both subscribers get what moved");
  const refresh = gitStatus(REPO);
  assert(count("git_status") === before + 1, "the refresh starts a fresh git_status");
  for (const r of statusResolvers) r({ isRepo: true, root: REPO, changes: [] });
  statusResolvers = [];
  await Promise.all([poll, refresh]);
}

console.log("3. released by the last subscriber only");
a.dispose();
a.dispose();
await tick();
assert(count("git_unwatch") === 0, "one subscriber leaving keeps the watch");
b.dispose();
await tick();
await tick();
const unwatch = calls.find((c) => c.cmd === "git_unwatch");
assert(unwatch?.args.id === 7, "the last one releases it, by id");
const c2 = watchRepo(REPO, () => {});
assert(count("git_watch") === 2, "subscribing again after that watches again");
c2.dispose();
await tick();
await tick();

console.log("4. a host that will not watch reports inactive");
watchResult = async () => {
  throw new Error("network path: keep polling");
};
const d = watchRepo("//server/share/repo", () => {});
assert((await d.active) === false, "active resolves false, so the caller keeps polling");
const unwatchesBefore = count("git_unwatch");
d.dispose();
await tick();
await tick();
assert(
  count("git_unwatch") === unwatchesBefore,
  "nothing to release for a watch that never started",
);

console.log("5. wired to the Rust side");
{
  const rs = readFileSync(join(ROOT, "src-tauri/src/modules/git/watch.rs"), "utf8");
  const lib = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
  assert(
    /pub async fn git_watch\([\s\S]*?root: String,[\s\S]*?on_change: Channel<RepoChange>/.test(rs),
    "git_watch takes `root` and `on_change` (camelCased by Tauri)",
  );
  assert(/pub async fn git_unwatch\([\s\S]*?id: u32/.test(rs), "git_unwatch takes `id`");
  assert(
    lib.includes("git::watch::git_watch") && lib.includes("git::watch::git_unwatch"),
    "both commands are registered",
  );
  const mod = readFileSync(join(ROOT, "src-tauri/src/modules/git/mod.rs"), "utf8");
  assert(/pub mod watch;/.test(mod), "the module is declared");
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed})`}: repo-watch-verify`);
process.exit(failed === 0 ? 0 : 1);
