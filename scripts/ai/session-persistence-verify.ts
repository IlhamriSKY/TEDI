/**
 * Self-check for "an empty chat is not history".
 * Run: `npx tsx scripts/ai/session-persistence-verify.ts`.
 *
 * A new chat is created in memory and only earns a place in the saved sessions
 * list once it has content. Two things break silently:
 *
 *  1. A NEW `saveSessionsList(...)` call site that skips `savedList(...)`. The
 *     in-memory list carries the empty chats too, so any write triggered by an
 *     unrelated session smuggles them onto disk - and the bug only shows on the
 *     next launch, as ghost "New chat" rows.
 *  2. Committing on the derived TITLE instead of on the messages. A first turn
 *     that is attachments-only derives "New chat", so a title-keyed commit
 *     would leave a chat with real content permanently unsaved.
 *
 * Source assertions, not imports: `chatStore` pulls in the Tauri store plugin,
 * which has no shape outside a webview.
 */
import { readFileSync } from "node:fs";

const src = readFileSync(
  new URL("../../src/modules/ai/store/chatStore.ts", import.meta.url),
  "utf8",
);

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

/**
 * Body of a store action, from its opening line to the next top-level `  },`.
 * Anchored on the trailing `=> {` so it lands on the IMPLEMENTATION: each of
 * these names also appears in the `StoreState` type above the store, where the
 * same line ends in `;` and would hand back a slice of the wrong half.
 */
function action(name: string): string {
  const m = new RegExp(`^  ${name}: \\([^)]*\\) => \\{$`, "m").exec(src);
  if (!m) return "";
  const end = src.indexOf("\n  },", m.index);
  const body = end === -1 ? src.slice(m.index) : src.slice(m.index, end);
  // Line comments stripped, so "no `saveSessionsList` here" in a comment cannot
  // read as a call to it.
  return body.replace(/^\s*\/\/.*$/gm, "");
}

check(
  "every action body was located",
  ["newSession", "persistMessages", "deleteSession", "renameSession"].every(
    (n) => action(n).length > 0,
  ),
);

console.log("[ledger] the set and its one filter exist");
check(
  "`unsavedSessions` holds the uncommitted ids",
  src.includes("const unsavedSessions = new Set<string>()"),
);
check("`savedList` is what strips them", /function savedList\(/.test(src));

console.log("\n[writes] every list write goes through the filter");
// `saveSessionsList([])` is the deliberate exception: the stand-in chat that
// replaces the last deleted one is empty, and the list still has to be written
// or the deleted chat returns on restart.
const writes = [...src.matchAll(/saveSessionsList\(([^)]*)/g)]
  .map((m) => m[1].trim())
  .filter((arg) => arg.length > 0 && !arg.startsWith("sessions: SessionMeta"));
check("there is at least one write to check", writes.length > 0, writes);
const raw = writes.filter((arg) => !arg.startsWith("savedList(") && arg !== "[]");
check("no write passes the raw in-memory list", raw.length === 0, { raw, writes });

console.log("\n[newSession] an empty chat never reaches disk");
const created = action("newSession");
check("it registers the id as unsaved", created.includes("unsavedSessions.add(id)"));
check("and writes no sessions list", !created.includes("saveSessionsList"), created);
// The active id is still written: a first message must resume on THIS chat, and
// hydrate already ignores an active id that names no saved session.
check("but still records the active id", created.includes("saveActiveId(id)"));
check(
  "hydrate drops an active id with no saved session",
  /sessions\.some\(\(s\) => s\.id === activeId\)/.test(src),
);

console.log("\n[commit] the first message is what saves the chat");
const persist = action("persistMessages");
check(
  "commit is keyed off the messages, not the derived title",
  /const commit =\s*messages\.length > 0 && unsavedSessions\.delete\(id\)/.test(persist),
  persist.match(/const commit =[^;]*/)?.[0],
);
check("a retitle alone still saves", persist.includes("!commit && !retitled"));

console.log("\n[cleanup] a deleted chat leaves the ledger");
check(
  "deleteSession forgets the id",
  action("deleteSession").includes("unsavedSessions.delete(id)"),
);
check("a rename counts as content", action("renameSession").includes("unsavedSessions.delete(id)"));

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
