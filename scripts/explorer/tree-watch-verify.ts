/**
 * Self-check for the Explorer's directory watcher (`explorer/lib/treeWatch.ts`
 * plus the `useFileTree` wiring and `fs/watch.rs` behind it).
 * Run: `npx tsx scripts/explorer/tree-watch-verify.ts` (part of `pnpm verify`).
 *
 * The file tree used to re-read its root and every expanded directory every
 * four seconds. It now refreshes on a host watcher, so:
 *  1. ONE host watch per root, however many trees subscribe, and every
 *     subscriber hears about a change.
 *  2. The watch is released only when the LAST subscriber leaves, with its id.
 *  3. A host that will not watch reports inactive, and the poll is what keeps
 *     the tree live (that is the fallback, not a failure).
 *  4. `useFileTree` re-reads ONLY directories it has loaded, and only while the
 *     window is actually being looked at.
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
(globalThis as { window?: unknown }).window = {
  __TAURI_INTERNALS__: {
    transformCallback: (cb: (raw: unknown) => void) => {
      callbacks.push(cb);
      return callbacks.length;
    },
    unregisterCallback: () => {},
    invoke: (cmd: string, args: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "fs_watch") return watchResult();
      return Promise.resolve(null);
    },
  },
  dispatchEvent: () => true,
};
const count = (cmd: string) => calls.filter((c) => c.cmd === cmd).length;
const tick = () => new Promise((r) => setTimeout(r, 0));

const { watchTree } = await import("../../src/modules/explorer/lib/treeWatch");
const REPO = "D:/repo";

console.log("1. one host watch per root, heard by every subscriber");
const dirsA: string[] = [];
const dirsB: string[] = [];
const a = watchTree(REPO, (c) => dirsA.push(c.dirs.join("|")));
const b = watchTree(REPO, (c) => dirsB.push(c.dirs.join("|")));
assert(count("fs_watch") === 1, "two trees, one fs_watch");
assert((await a.active) && (await b.active), "both see the watch as active");
const watchArgs = calls.find((c) => c.cmd === "fs_watch")!.args;
assert(watchArgs.root === REPO, "the root is passed as `root`");
assert(
  typeof (watchArgs.onChange as { toJSON?: () => string })?.toJSON === "function" &&
    String((watchArgs.onChange as { toJSON: () => string }).toJSON()).startsWith("__CHANNEL__:"),
  "the Channel is passed as `onChange`",
);
// The raw shape Tauri sends a Channel: an index (for ordering) and the payload.
callbacks[callbacks.length - 1]({ index: 0, message: { dirs: [`${REPO}/src`], rescan: false } });
assert(
  dirsA.join(",") === `${REPO}/src` && dirsB.join(",") === `${REPO}/src`,
  "both subscribers get the directories that changed",
);

console.log("1b. Tauri's Channel framing is what the handler sees");
{
  // A Channel message arrives wrapped in `{ index, message }`, and only the
  // NEXT index is delivered: an out-of-order one is parked until its turn. A
  // payload sent unwrapped (or with the wrong index) reaches nobody at all,
  // which looks exactly like "the watcher never fires".
  callbacks[callbacks.length - 1]({ index: 2, message: { dirs: [`${REPO}/late`], rescan: false } });
  assert(dirsA.join(",") === `${REPO}/src`, "nothing is delivered out of order");
  callbacks[callbacks.length - 1]({ index: 1, message: { dirs: [`${REPO}/src`], rescan: true } });
  assert(
    dirsA.join(",") === `${REPO}/src,${REPO}/src,${REPO}/late`,
    "and the parked one lands as soon as its index comes up",
  );
}

console.log("2. released by the last subscriber only");
a.dispose();
a.dispose();
await tick();
assert(count("fs_unwatch") === 0, "one subscriber leaving keeps the watch");
b.dispose();
await tick();
await tick();
const unwatch = calls.find((c) => c.cmd === "fs_unwatch");
assert(unwatch?.args.id === 7, "the last one releases it, by id");
const c2 = watchTree(REPO, () => {});
assert(count("fs_watch") === 2, "subscribing again after that watches again");
c2.dispose();
await tick();
await tick();

console.log("3. a host that will not watch reports inactive");
watchResult = async () => {
  throw new Error("network path: keep polling");
};
const d = watchTree("//server/share/repo", () => {});
assert((await d.active) === false, "active resolves false, so the caller keeps polling");
const unwatchesBefore = count("fs_unwatch");
d.dispose();
await tick();
await tick();
assert(
  count("fs_unwatch") === unwatchesBefore,
  "nothing to release for a watch that never started",
);

console.log("4. useFileTree refreshes only what it has loaded");
{
  const src = readFileSync(join(ROOT, "src/modules/explorer/lib/useFileTree.ts"), "utf8");
  assert(
    /import \{ watchTree, type FsChange \} from "\.\/treeWatch"/.test(src),
    "the tree uses the shared watcher",
  );
  assert(
    /if \(fetchGen\.current\.has\(dir\) \|\| nodesRef\.current\[dir\]\)/.test(src),
    "only a directory this tree has loaded is re-read",
  );
  assert(
    /void fetchChildrenRef\.current\(dir, \{ silent: true \}\)/.test(src),
    "and it is a SILENT re-read, so the spinner and the scroll position stay put",
  );
  assert(
    /change\.rescan \|\| change\.dirs\.length === 0[\s\S]{0,80}refreshAllLoadedRef\.current\(\)/.test(
      src,
    ),
    "a rescan re-reads every loaded directory",
  );
  assert(
    /document\.visibilityState !== "visible" \|\| !document\.hasFocus\(\)\) return;/.test(src),
    "a backgrounded window takes the refresh when it returns, via the poll",
  );
  assert(
    /watching \? SAFETY_REFRESH_MS : AUTO_REFRESH_MS/.test(src),
    "a live watch drops the poll to the safety cadence, and a refused watch does not",
  );
  assert(
    /}, \[rootPath\]\);/.test(src) &&
      /eslint-disable-next-line react-hooks\/exhaustive-deps/.test(src),
    "the watch is keyed on the root only, so a listing cannot tear it down",
  );
}

console.log("5. wired to the Rust side");
{
  const rs = readFileSync(join(ROOT, "src-tauri/src/modules/fs/watch.rs"), "utf8");
  const lib = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
  assert(
    /pub async fn fs_watch\([\s\S]*?root: String,[\s\S]*?on_change: Channel<FsChange>/.test(rs),
    "fs_watch takes `root` and `on_change` (camelCased by Tauri)",
  );
  assert(/pub async fn fs_unwatch\([\s\S]*?id: u32/.test(rs), "fs_unwatch takes `id`");
  assert(
    lib.includes("fs::watch::fs_watch") && lib.includes("fs::watch::fs_unwatch"),
    "both commands are registered",
  );
  const mod = readFileSync(join(ROOT, "src-tauri/src/modules/fs/mod.rs"), "utf8");
  assert(/pub mod watch;/.test(mod), "the module is declared");
  const tree = readFileSync(join(ROOT, "src-tauri/src/modules/fs/tree.rs"), "utf8");
  assert(!/fs_watch/.test(tree), "the tree module itself is untouched");
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed})`}: tree-watch-verify`);
process.exit(failed === 0 ? 0 : 1);
