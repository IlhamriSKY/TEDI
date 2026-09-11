/**
 * MCP protocol conformance for the stdio server (`server.mjs`).
 *
 * The server is DUAL-ERA: the legacy `initialize` handshake (every current AI
 * CLI) AND the modern 2026-07-28 stateless model (`server/discover`, per-request
 * `_meta` version, `resultType`). This spawns the real server and drives raw
 * JSON-RPC down its stdin, because the handshake is wire behaviour a source-text
 * check cannot see, and the whole point is that the legacy path stays
 * byte-identical while the modern one is added on top.
 *
 * Hermetic: a bogus `TEDI_BUNDLE_ID` means no handshake file, so the extension
 * index resolves to empty and `tools/list` answers the core tools without ever
 * reaching a running TEDI. Run: `npx tsx scripts/mcp/conformance-verify.ts`.
 */
/// <reference types="node" />
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ALL_PROTOCOL_VERSIONS, discoverResult } from "./server.mjs";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

/** Send every request, collect replies keyed by id. One process, closed after. */
function roundtrip(requests: object[]): Promise<Map<number, any>> {
  const server = fileURLToPath(new URL("./server.mjs", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], {
      env: { ...process.env, TEDI_BUNDLE_ID: "id.tedi.conformance.nonexistent" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const replies = new Map<number, any>();
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("server did not answer every request in 10s"));
    }, 10_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (typeof msg.id === "number") replies.set(msg.id, msg);
        } catch {
          /* ignore non-JSON */
        }
        if (replies.size >= requests.length) {
          clearTimeout(timer);
          child.kill();
          resolve(replies);
        }
      }
    });
    child.on("error", reject);
    for (const r of requests) child.stdin.write(`${JSON.stringify(r)}\n`);
  });
}

const META = "io.modelcontextprotocol/protocolVersion";
const INFO = "io.modelcontextprotocol/serverInfo";

// --- pure builders (no spawn) ---------------------------------------------
console.log("[versions] modern first, then every legacy revision");
check("2026-07-28 is advertised and preferred", ALL_PROTOCOL_VERSIONS[0] === "2026-07-28");
check(
  "the legacy revisions every current CLI speaks are still there",
  ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].every((v) =>
    ALL_PROTOCOL_VERSIONS.includes(v),
  ),
);

console.log("\n[discover] the DiscoverResult shape the spec requires");
{
  const d = discoverResult();
  check("resultType is complete", d.resultType === "complete");
  check("supportedVersions is the full list", JSON.stringify(d.supportedVersions) === JSON.stringify(ALL_PROTOCOL_VERSIONS));
  check("capabilities.tools.listChanged is declared false", d.capabilities?.tools?.listChanged === false);
  check("identity is under the modern _meta key", d._meta?.[INFO]?.name === "tedi");
}

// --- live wire behaviour ---------------------------------------------------
const replies = await roundtrip([
  // 1. LEGACY initialize.
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "p", version: "0" } },
  },
  // 2. MODERN discovery.
  { jsonrpc: "2.0", id: 2, method: "server/discover", params: { _meta: { [META]: "2026-07-28" } } },
  // 3. MODERN request naming a version we do not speak -> -32022.
  { jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { [META]: "1900-01-01" } } },
  // 4. LEGACY tools/list (no _meta) -> no resultType, byte-compatible.
  { jsonrpc: "2.0", id: 4, method: "tools/list" },
  // 5. MODERN tools/list (with a supported _meta version) -> resultType.
  { jsonrpc: "2.0", id: 5, method: "tools/list", params: { _meta: { [META]: "2026-07-28" } } },
]);

console.log("\n[legacy] the initialize handshake is unchanged");
{
  const r = replies.get(1)?.result;
  check("echoes the client's supported version", r?.protocolVersion === "2025-06-18");
  check("declares tools.listChanged: false", r?.capabilities?.tools?.listChanged === false);
  check("serverInfo carries name + title", r?.serverInfo?.name === "tedi" && r?.serverInfo?.title === "TEDI");
}

console.log("\n[modern] server/discover answers over the wire");
{
  const r = replies.get(2)?.result;
  check("resultType complete + supportedVersions", r?.resultType === "complete" && Array.isArray(r?.supportedVersions));
  check("advertises 2026-07-28", r?.supportedVersions?.includes("2026-07-28"));
}

console.log("\n[modern] an unsupported version is -32022, not a silent downgrade");
{
  const e = replies.get(3)?.error;
  check("code is -32022", e?.code === -32022);
  check("data.supported lists what we speak", Array.isArray(e?.data?.supported) && e.data.supported.includes("2026-07-28"));
  check("data.requested echoes the bad version", e?.data?.requested === "1900-01-01");
}

console.log("\n[resultType] present for modern, ABSENT for legacy (no break)");
{
  const legacy = replies.get(4)?.result;
  const mod = replies.get(5)?.result;
  check("legacy tools/list has NO resultType", legacy && !("resultType" in legacy), Object.keys(legacy ?? {}));
  check("modern tools/list HAS resultType complete", mod?.resultType === "complete");
  check("both still return the same tools", JSON.stringify(legacy?.tools) === JSON.stringify(mod?.tools));
}

if (failed > 0) throw new Error(`${failed} conformance check(s) failed`);
console.log("\nmcp-conformance-verify: all checks passed");
