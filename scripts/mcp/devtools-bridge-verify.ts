/**
 * Self-check for DevTools over the bridge (`mcp_devtools.rs` + `BridgeCdp`).
 * Run: `npx tsx scripts/mcp/devtools-bridge-verify.ts` (part of `pnpm verify`).
 *
 * The six MCP tools that need real input or the compositor used to need the
 * automation port, which took a restart to open and kept renderer flags on that
 * made TEDI heavier. They now go through the local bridge, which TEDI answers by
 * calling the protocol on its own webview in-process. What has to stay true:
 *
 *  1. Rust and JS agree on the misc pack and on every CDP method the driver
 *     sends, or a tool is refused by the allowlist it was never added to.
 *  2. `BridgeCdp` carries a call and the console buffer the way `Cdp` did.
 *  3. The settle wait before the first input is BOUNDED: without the port's
 *     flags a covered window runs no animation frames.
 *  4. The bridge is taken whenever it gives a real answer. Only a TEDI that has
 *     no `devtools` capability falls back to the port, and a refusal (the misc
 *     pack switched off) is never routed around through an open port.
 *  5. Installing MCP no longer turns the port on.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BRIDGE_SETTLE, BridgeCdp } from "./driver.mjs";
import { openDevtools } from "./transport.mjs";
import { TOOL_DEFS } from "./tools.mjs";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

const rust = read("src-tauri/src/modules/mcp_devtools.rs");
const rustList = (name: string): string[] => {
  const m = new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`).exec(rust);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort() : [];
};

console.log("1. Rust and JS agree");
{
  const misc = Object.entries(TOOL_DEFS as Record<string, { pack?: string }>)
    .filter(([, d]) => d.pack === "misc")
    .map(([n]) => n)
    .sort();
  assert(
    misc.length > 0 && misc.join(",") === rustList("MISC_PACK").join(","),
    `the misc pack matches (${misc.join(", ")})`,
  );
  const driver = read("scripts/mcp/driver.mjs");
  // Everything the Driver sends on its own connection. `connect()` also enables
  // Page/Runtime/Log on a PORT connection; the bridge arms those itself.
  const sent = [...driver.matchAll(/this\.cdp\.send\("([A-Za-z]+\.[A-Za-z]+)"/g)].map((m) => m[1]);
  const allowed = rustList("ALLOWED");
  const missing = [...new Set(sent)].filter((m) => !allowed.includes(m));
  assert(
    sent.length > 0 && missing.length === 0,
    `every method the driver sends is allowed${missing.length ? ` (missing: ${missing})` : ""}`,
  );
  assert(
    !allowed.some((m) => /^(Storage|Network|Browser|Target)\./.test(m)),
    "no browser-wide domain is allowed",
  );
}

console.log("2. BridgeCdp carries calls and logs");
{
  const calls: [string, unknown[]][] = [];
  const bridge = {
    call: async (name: string, args: unknown[]) => {
      calls.push([name, args]);
      if (name === "devtoolsLogs") {
        return [
          {
            method: "Runtime.consoleAPICalled",
            params: { type: "log", args: [{ value: "hello" }] },
          },
          { method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "boom" } } },
          { method: "Page.frameNavigated", params: {} },
        ];
      }
      return { result: { value: 42 } };
    },
  };
  const cdp = new BridgeCdp(bridge);
  const out = await cdp.send("Runtime.evaluate", { expression: "1" });
  assert(calls[0][0] === "devtools", "a send is the `devtools` capability");
  assert(
    JSON.stringify(calls[0][1]) === JSON.stringify(["Runtime.evaluate", { expression: "1" }]),
    "with [method, params]",
  );
  assert(
    (out as { result: { value: number } }).result.value === 42,
    "and answers with the protocol's result",
  );
  const logs = await cdp.logs();
  assert(
    logs.length === 2 && logs[0].text === "hello" && logs[1].level === "error",
    "logs are described like the socket client's",
  );
  assert((await cdp.logs("error")).length === 1, "and filter by level");
}

console.log("3. the settle wait is bounded");
{
  let parsed = true;
  try {
    new Function(`return (${BRIDGE_SETTLE});`);
  } catch {
    parsed = false;
  }
  assert(parsed, "it parses as an expression");
  assert(
    /Promise\.race\(/.test(BRIDGE_SETTLE) && /setTimeout\(/.test(BRIDGE_SETTLE),
    "and races the frames against a timer",
  );
}

console.log("4. which way DevTools is reached");
{
  const devtoolsBridge = { call: async () => ({ result: { value: 1 } }) };
  const noCapability = {
    call: async () => {
      throw new Error('No capability "devtools" is registered. Available: panes, state');
    },
  };
  const refusing = {
    call: async () => {
      throw new Error(
        "the misc pack (keys, type_text, click, drag, screenshot, eval_js) is switched off in TEDI's MCP settings",
      );
    },
  };
  let portUsed = 0;
  const connectPort = async () => {
    portUsed++;
    return "port-driver";
  };
  const run = (bridge: unknown, port: number | null, err: Error | null = null) =>
    openDevtools({ getBridge: async () => bridge, bridgeError: () => err, port, connectPort });

  const d = (await run(devtoolsBridge, 9222)) as { cdp: unknown };
  assert(
    d?.cdp instanceof BridgeCdp && portUsed === 0,
    "a capable TEDI is driven through the bridge, even with a port configured",
  );

  assert(
    (await run(noCapability, 9222)) === "port-driver" && portUsed === 1,
    "an older TEDI falls back to the port",
  );

  const oldNoPort = await run(noCapability, null).then(
    () => "",
    (e: Error) => e.message,
  );
  assert(/newer TEDI/.test(oldNoPort), "an older TEDI with no port says to update");

  const refused = await run(refusing, 9222).then(
    () => "",
    (e: Error) => e.message,
  );
  assert(
    /misc pack/.test(refused) && portUsed === 1,
    "a refusal is the answer, never routed around through the port",
  );

  const down = await run(null, null, new Error("TEDI is not running")).then(
    () => "",
    (e: Error) => e.message,
  );
  assert(/not running/.test(down), "no bridge and no port names the bridge's reason");
}

console.log("5. installing MCP leaves the port alone");
{
  const dialog = read("src/modules/mcpInstall/McpInstallButton.tsx");
  const setters = [...dialog.matchAll(/setAutomationPort\(/g)].length;
  assert(setters === 1, "setAutomationPort is called only by the channel switch itself");
  const bridgeRs = read("src-tauri/src/modules/mcp_bridge.rs");
  assert(
    /mcp_devtools::CAPABILITY =>[\s\S]*?mcp_devtools::LOGS_CAPABILITY =>[\s\S]*?_ => call_webview/.test(
      bridgeRs,
    ),
    "the bridge answers both DevTools names in Rust before anything reaches the webview",
  );
}

console.log(`\n${failed === 0 ? "PASS" : `FAIL (${failed})`}: devtools-bridge-verify`);
process.exit(failed === 0 ? 0 : 1);
