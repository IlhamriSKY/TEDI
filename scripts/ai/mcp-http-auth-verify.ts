/**
 * Self-check for MCP servers reached over HTTP (`ai/lib/mcpAuth.ts`,
 * `ai/lib/mcpClient.ts`).
 * Run: `npx tsx scripts/ai/mcp-http-auth-verify.ts`.
 *
 * Three things fail silently if they drift: a sign-in callback whose `state`
 * is not checked (a code from someone else's attempt would be accepted), header
 * lines that lose part of a token with a colon in it, and credentials leaking
 * into the plain config file instead of the keychain.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { codeFromCallback, headerLines, parseHeaderLines } from "../../src/modules/ai/lib/mcpAuth";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}
function throws(label: string, fn: () => unknown, match: RegExp): void {
  try {
    fn();
    console.error(`  FAIL: ${label} did not throw`);
    failed++;
  } catch (e) {
    check(label, match.test(String(e)), true);
  }
}

console.log("[the sign-in callback]");
check("code with the right state", codeFromCallback("/callback?code=abc&state=s1", "s1"), "abc");
throws(
  "a different state is refused",
  () => codeFromCallback("/callback?code=abc&state=zz", "s1"),
  /did not match/,
);
throws(
  "a refusal is reported",
  () => codeFromCallback("/callback?error=access_denied", "s1"),
  /refused: access_denied/,
);
throws("no code", () => codeFromCallback("/callback?state=s1", "s1"), /no authorization code/);

console.log("\n[header lines]");
const h = parseHeaderLines("Authorization: Bearer a:b:c\n# comment\n\nX-Team : web \nbroken line");
check("value keeps its own colons", h.Authorization, "Bearer a:b:c");
check("names and values trimmed", h["X-Team"], "web");
check("junk lines skipped", Object.keys(h).length, 2);
check("round trip", parseHeaderLines(headerLines(h)), h);

console.log("\n[credentials stay out of the config file]");
const src = (p: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${p}`, import.meta.url)), "utf8");
const config = src("modules/ai/lib/mcpConfig.ts");
const shape = config.slice(
  config.indexOf("export type McpServerConfig"),
  config.indexOf("};", config.indexOf("export type McpServerConfig")),
);
check(
  "McpServerConfig declares no headers or tokens",
  /headers|token/i.test(shape.replace(/\/\*[\s\S]*?\*\//g, "")),
  false,
);
const card = src("settings/sections/components/McpServersCard.tsx");
check("Settings writes headers through the keychain helper", card.includes("setMcpHeaders("), true);
check("removing a server clears its credentials", card.includes("clearMcpAuth(name)"), true);
const client = src("modules/ai/lib/mcpClient.ts");
check(
  "an edited credential changes the connection fingerprint",
  /configFingerprint[\s\S]{0,160}authRev/.test(client),
  true,
);
check("remote requests go through the Rust proxy", client.includes("fetch: proxyOnlyFetch"), true);
check(
  "only Settings may open a sign-in",
  /new McpClient\(config, cwd, undefined, true\)/.test(client),
  true,
);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall MCP HTTP auth checks passed");
