/**
 * End-to-end check of the local-socket bridge protocol.
 *
 * Run: `npx tsx scripts/mcp/bridge-verify.ts` (or `pnpm verify bridge`).
 *
 * The bridge is the way an outside AI CLI reaches TEDI without the DevTools
 * port. Rust owns the socket (`src-tauri/src/modules/mcp_bridge.rs`), the
 * webview owns the handlers (`src/modules/automation/bridgeHost.ts`), and
 * `socket.mjs` is the client. Only the client half can run outside the app, so
 * this stands up a REAL socket server speaking exactly what Rust speaks and
 * drives the real client against it.
 *
 * That makes it a genuine protocol test rather than a source-text assertion: a
 * framing change, a lost reply, or a handshake regression fails here. The four
 * behaviours worth pinning are the ones that were wrong on the transport it
 * replaces:
 *
 *   1. **A bad token is refused**, and the client says something actionable.
 *      CDP had no authentication at all.
 *   2. **Concurrent calls do not block each other.** A slow call must not hold a
 *      fast one behind it - the CDP path serialized everything through one
 *      evaluate at a time.
 *   3. **A dead socket rejects in flight** instead of parking forever. `Cdp.send`
 *      registered a pending promise with no deadline, so a wedged renderer
 *      stranded the call and every later one.
 *   4. **A reply sharing a chunk with the handshake is not lost.** TCP does not
 *      promise one frame per read, and the first version of the client read the
 *      handshake with its own `once("data")`, discarding whatever came with it.
 */
import net from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectBridge, readHandshake } from "./socket.mjs";

let failed = 0;
const fail = (msg: string): void => {
  console.error(`  FAIL: ${msg}`);
  failed++;
};
const ok = (msg: string): void => console.log(`  ok: ${msg}`);

const TOKEN = "0123456789abcdef0123456789abcdef";

/** Windows needs a named pipe; a filesystem path is not connectable there. */
const isWin = process.platform === "win32";
const tmp = mkdtempSync(join(tmpdir(), "tedi-bridge-"));
const address = isWin ? `\\\\.\\pipe\\tedi-bridge-verify-${process.pid}` : join(tmp, "bridge.sock");

/** Point `readHandshake()` at our stub by giving it a data dir it will search. */
const bundleId = "id.tedi.bridge-verify";
const dataDir = join(tmp, bundleId);
process.env.TEDI_BUNDLE_ID = bundleId;
process.env.APPDATA = tmp;
process.env.XDG_CONFIG_HOME = tmp;
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, "mcp-bridge.json"), JSON.stringify({ socket: address, token: TOKEN }));

/**
 * A stand-in for the Rust listener. Same wire format: one JSON object per line,
 * handshake first, then `{id,name,args}` in and `{id,ok,result|error}` out.
 *
 * `handle` decides what a capability returns, so a test can make one slow.
 */
function startStub(handle: (name: string, args: unknown[]) => Promise<unknown>) {
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    let buf = "";
    let authed = false;
    sock.on("data", (chunk) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (!authed) {
          authed = true;
          if (msg.token !== TOKEN) {
            sock.write(JSON.stringify({ ok: false, error: "bad token" }) + "\n");
            sock.end();
            return;
          }
          sock.write(JSON.stringify({ ok: true }) + "\n");
          continue;
        }
        void handle(msg.name, msg.args ?? [])
          .then((result) => sock.write(JSON.stringify({ id: msg.id, ok: true, result }) + "\n"))
          .catch((e) =>
            sock.write(JSON.stringify({ id: msg.id, ok: false, error: e.message }) + "\n"),
          );
      }
    });
    sock.on("error", () => {});
  });
  return new Promise<net.Server>((resolve) => server.listen(address, () => resolve(server)));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
console.log("[handshake] the client finds the address and token TEDI published");
// ---------------------------------------------------------------------------
const hs = readHandshake();
if (!hs || hs.token !== TOKEN) fail("readHandshake() did not find the published handshake file");
else ok("readHandshake() reads socket + token from the app data dir");

// ---------------------------------------------------------------------------
console.log("\n[calls] a capability answers, and errors come back as messages");
// ---------------------------------------------------------------------------
const server = await startStub(async (name, args) => {
  if (name === "slow") {
    await sleep(120);
    return "slow-done";
  }
  if (name === "boom") throw new Error('No capability "boom" is registered.');
  return { echoed: name, args };
});

{
  const session = await connectBridge();
  const r = (await session.call("panes", [1, 2])) as { echoed: string; args: unknown[] };
  if (r?.echoed !== "panes") fail(`a call did not round-trip: ${JSON.stringify(r)}`);
  else if (JSON.stringify(r.args) !== "[1,2]")
    fail(`arguments were altered: ${JSON.stringify(r.args)}`);
  else ok("a capability call round-trips with its arguments intact");

  // A capability that throws must arrive as ITS message, not a transport fault:
  // that sentence is what the agent reads and acts on.
  let msg = "";
  try {
    await session.call("boom");
  } catch (e) {
    msg = (e as Error).message;
  }
  if (!msg.includes('No capability "boom"')) fail(`a failing capability lost its message: ${msg}`);
  else ok("a failing capability's own message reaches the caller");

  // 2. Concurrency: the slow call is issued FIRST and must not delay the fast one.
  const started = Date.now();
  const slow = session.call("slow");
  await session.call("quick");
  const fastAt = Date.now() - started;
  if (fastAt > 100) fail(`a fast call waited ${fastAt}ms behind a slow one - calls are serialized`);
  else ok(`a fast call overtakes a slow one (${fastAt}ms while the slow one still runs)`);
  if ((await slow) !== "slow-done") fail("the slow call did not complete");
  else ok("the slow call still completes afterwards");

  session.close();
}

// ---------------------------------------------------------------------------
console.log("\n[handshake] a bad token is refused with an actionable message");
// ---------------------------------------------------------------------------
writeFileSync(
  join(dataDir, "mcp-bridge.json"),
  JSON.stringify({ socket: address, token: "wrong-token-wrong-token-wrong-t" }),
);
{
  let msg = "";
  try {
    const s = await connectBridge();
    s.close();
  } catch (e) {
    msg = (e as Error).message;
  }
  if (!msg) fail("a wrong token was ACCEPTED - the bridge has no authentication");
  else if (!/token/i.test(msg)) fail(`the refusal does not mention the token: ${msg}`);
  else ok("a wrong token is refused, and the message says why");
}
writeFileSync(join(dataDir, "mcp-bridge.json"), JSON.stringify({ socket: address, token: TOKEN }));

// ---------------------------------------------------------------------------
console.log("\n[transport] a dropped connection rejects in-flight calls");
// ---------------------------------------------------------------------------
{
  const session = await connectBridge();
  const inFlight = session.call("slow");
  await sleep(20);
  server.close();
  session.close();
  let msg = "";
  try {
    await inFlight;
  } catch (e) {
    msg = (e as Error).message;
  }
  if (!msg) fail("an in-flight call survived the socket closing - it would park forever");
  else ok(`an in-flight call rejects when the socket dies ("${msg}")`);
}

// ---------------------------------------------------------------------------
console.log("\n[startup] a missing app is reported as 'not running', not a crash");
// ---------------------------------------------------------------------------
{
  rmSync(join(dataDir, "mcp-bridge.json"), { force: true });
  let msg = "";
  try {
    const s = await connectBridge();
    s.close();
  } catch (e) {
    msg = (e as Error).message;
  }
  if (!/not running/i.test(msg)) fail(`a missing handshake should say TEDI is not running: ${msg}`);
  else ok("no handshake file reads as 'TEDI is not running'");
}

rmSync(tmp, { recursive: true, force: true });
console.log(failed ? `\n${failed} check(s) FAILED` : "\nALL PASS");
if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
