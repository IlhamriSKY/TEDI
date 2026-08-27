/**
 * Self-check for the clipboard READ path (`readClipboardText`).
 * Run: `npx tsx scripts/terminal/clipboard-read-verify.ts`.
 *
 * Paste was dead on Linux (#10) because `navigator.clipboard.readText()` rejects
 * there: wry only enables WebKitGTK's `javascript_can_access_clipboard` (which
 * also flips WebCore's `DOMPasteAllowed`, the read gate) when the webview is
 * built with `clipboard: true`, and Tauri defaults that to false with no
 * tauri.conf.json knob for a config-declared window. Reads therefore go through
 * the `clipboard_read_text` Rust command instead.
 *
 * Nothing else ties that path's three files together - a command name that
 * matches nothing, or a command that is never registered, fails only at runtime
 * and only on a real paste. So:
 *  1. COMMAND NAME: the invoked name is the one Rust exposes.
 *  2. REGISTERED: the command is in `generate_handler!`, and reads do not depend
 *     on the webview clipboard flag Tauri leaves off.
 *  3. NO WEBVIEW READS: nothing in src/ reads the clipboard via `navigator`
 *     again (that is the regression that brings the Linux bug back).
 *  4. RESOLVES, NEVER REJECTS: a failed read yields "" so paste sites need no
 *     per-site catch (an empty/image-only clipboard is not an error).
 */
/// <reference types="node" />
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const READ_TEXT_CMD = "clipboard_read_text";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

console.log("1. the invoked command is the one Rust exposes");
{
  assert(
    read("src/lib/clipboard.ts").includes(`invoke<string>("${READ_TEXT_CMD}")`),
    `clipboard.ts invokes ${READ_TEXT_CMD}`,
  );
  assert(
    new RegExp(`pub async fn ${READ_TEXT_CMD}\\s*\\(`).test(
      read("src-tauri/src/modules/clipboard.rs"),
    ),
    `clipboard.rs defines ${READ_TEXT_CMD}`,
  );
}

console.log("2. the command is registered and the read does not block the UI thread");
{
  const libRs = read("src-tauri/src/lib.rs");
  assert(
    libRs.includes(`clipboard::${READ_TEXT_CMD},`),
    "lib.rs lists the command in generate_handler!",
  );
  // A clipboard read is a synchronous round trip to whichever process owns the
  // selection; on the webview's UI thread a slow owner freezes the window.
  assert(
    read("src-tauri/src/modules/clipboard.rs").includes("spawn_blocking"),
    "the read runs on a blocking thread, not the UI thread",
  );
}

console.log("3. no clipboard reads through the webview API");
{
  // `readClipboardText`'s own docs name the API it replaces, so skip that file.
  const HELPER = join(ROOT, "src", "lib", "clipboard.ts");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (
        /\.tsx?$/.test(name) &&
        full !== HELPER &&
        /navigator\.clipboard[\s\S]{0,40}?readText/.test(readFileSync(full, "utf8"))
      )
        offenders.push(relative(ROOT, full));
    }
  };
  walk(join(ROOT, "src"));
  assert(
    offenders.length === 0,
    `no navigator.clipboard.readText in src/${offenders.length ? ` (found: ${offenders.join(", ")})` : ""}`,
  );
}

console.log('4. resolves to text, and to "" instead of rejecting');
{
  // Stand-in for the Tauri IPC bridge `@tauri-apps/api/core` calls into.
  const calls: string[] = [];
  let respond: () => Promise<unknown> = async () => "";
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (cmd: string) => {
        calls.push(cmd);
        return respond();
      },
    },
  };
  const { readClipboardText } = await import("../../src/lib/clipboard");

  respond = async () => "hello\nworld";
  assert((await readClipboardText()) === "hello\nworld", "returns the clipboard text verbatim");
  assert(calls[0] === READ_TEXT_CMD, `invoked ${READ_TEXT_CMD}`);

  // arboard errors on an empty or image-only clipboard; that must not surface as
  // an unhandled rejection at a paste site.
  respond = async () => {
    throw new Error("clipboard is empty");
  };
  const warn = console.warn;
  console.warn = () => {}; // the helper logs the failure; keep the run's output readable
  const onFailure = await readClipboardText();
  console.warn = warn;
  assert(onFailure === "", "a failed read resolves to the empty string");
}

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failed > 0) throw new Error(`clipboard-read-verify: ${failed} check(s) failed`);
console.log("\nclipboard-read-verify: all checks passed");
