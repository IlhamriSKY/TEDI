/**
 * Self-check for multi-turn rewind (`ai/lib/checkpoint.ts`).
 * Run: `npx tsx scripts/ai/checkpoint-rewind-verify.ts`.
 *
 * Rewinding several turns must walk each file back through every state the
 * agent left it in, newest turn first, and land on what was on disk before the
 * chosen prompt. A file the user edited since is left alone, and a turn that
 * fails to restore stops the walk without losing the turns older than it.
 * The filesystem is an in-memory map standing in for the Tauri commands.
 */
import {
  getCheckpoint,
  openCheckpoint,
  recordFileMutation,
  restoreCheckpoints,
  turnsSince,
} from "../../src/modules/ai/lib/checkpoint";
import { native } from "../../src/modules/ai/lib/native";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

const disk = new Map<string, string>();
let failWrites = false;
const n = native as unknown as Record<string, unknown>;
n.readFile = async (p: string) => {
  if (!disk.has(p)) throw new Error("No such file (os error 2)");
  return { kind: "text", content: disk.get(p) };
};
n.writeFile = async (p: string, c: string) => {
  if (failWrites) throw new Error("disk full");
  disk.set(p, c);
};
n.deletePath = async (p: string) => {
  disk.delete(p);
};

/** One agent turn: the prompt is message `baseline`, the edit sets `path` to `to`. */
function turn(session: string, baseline: number, path: string, to: string): void {
  openCheckpoint(session, baseline);
  const before = disk.get(path);
  disk.set(path, to);
  recordFileMutation(
    session,
    path,
    before === undefined
      ? { kind: "create-file", writtenContent: to }
      : { kind: "modify", originalContent: before, writtenContent: to },
  );
}

async function main() {
  console.log("[rewinding three turns of edits to one file]");
  disk.clear();
  disk.set("a.ts", "v0");
  turn("s1", 0, "a.ts", "v1");
  turn("s1", 2, "a.ts", "v2");
  turn("s1", 4, "a.ts", "v3");
  check("turns undone by rewinding to the 2nd prompt", turnsSince("s1", 2), 2);
  check("a prompt with no checkpoint", turnsSince("s1", 3), 0);
  const out = await restoreCheckpoints("s1", turnsSince("s1", 2));
  check("history trims to before the 2nd prompt", out?.baselineMessageCount, 2);
  check("file is back to its state after turn 1", disk.get("a.ts"), "v1");
  check("turn 1 is still rewindable", turnsSince("s1", 0), 1);

  console.log("\n[a file created in a rewound turn is removed]");
  turn("s1", 2, "new.ts", "hello");
  await restoreCheckpoints("s1", 1);
  check("created file gone", disk.has("new.ts"), false);

  console.log("\n[a file the user edited since is left alone]");
  disk.clear();
  disk.set("b.ts", "orig");
  turn("s2", 0, "b.ts", "agent");
  disk.set("b.ts", "mine");
  const kept = await restoreCheckpoints("s2", 1);
  check(
    "reported as skipped",
    kept?.skipped.map((x) => x.reason),
    ["user-modified"],
  );
  check("user's edit survives", disk.get("b.ts"), "mine");

  console.log("\n[a failure stops the walk and keeps what is left]");
  disk.clear();
  disk.set("c.ts", "c0");
  disk.set("d.ts", "d0");
  turn("s3", 0, "c.ts", "c1");
  turn("s3", 2, "d.ts", "d1");
  failWrites = true;
  const partial = await restoreCheckpoints("s3", 2);
  failWrites = false;
  check("nothing undone, nothing trimmed", partial?.baselineMessageCount, null);
  check("the failure is reported", partial?.failures.length, 1);
  check("both turns still there for a retry", turnsSince("s3", 0), 2);

  console.log("\n[a new prompt after a trim drops checkpoints past it]");
  turn("s4", 0, "e.ts", "1");
  turn("s4", 2, "e.ts", "2");
  turn("s4", 2, "e.ts", "3");
  check("the stale turn at 2 was replaced", turnsSince("s4", 0), 2);
  check("the newest is the new turn", getCheckpoint("s4")?.baselineMessageCount, 2);

  console.log("\n[only the last 20 turns are kept]");
  for (let i = 0; i < 25; i++) turn("s5", i * 2, "f.ts", String(i));
  check("oldest turns fall off", turnsSince("s5", 0), 0);
  check("the 20th newest is kept", turnsSince("s5", 10), 20);

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall checkpoint-rewind checks passed");
}

void main();
