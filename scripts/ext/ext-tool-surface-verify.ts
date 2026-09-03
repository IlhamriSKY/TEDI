/**
 * An extension's AI tools must reach BOTH agents, with the same schema.
 * Run: `npx tsx scripts/ext/ext-tool-surface-verify.ts`.
 *
 * TEDI has two callers for one tool and they take different routes to it:
 *
 *   in-app agent  -> `aiToolsRegistry` -> `buildExtensionTools` -> the AI SDK
 *   outside CLI   -> `listExtensions()` -> socket -> `scripts/mcp/server.mjs`
 *                    -> advertised as `ext_<name>`
 *
 * The first reads the registry directly and cannot lose anything. The second
 * serialises across a process boundary, and that is where a tool arrives
 * DEGRADED rather than missing: if `listExtensions()` drops `parameters`, the
 * out-of-process server has no schema to advertise and falls back to an open
 * object. The tool is then listed, callable and unusable - a model cannot know
 * an `action` enum exists, let alone which values are legal, so it guesses.
 * Nothing throws, and a test that only asks "is the tool there" sees nothing.
 *
 * WHY THE HOST HALF IS CHECKED AS SOURCE. Importing `extensions/store.ts` or
 * `ai/tools/extensions.ts` pulls the tab store and `@xterm/xterm` behind it,
 * which does not load outside a browser. The two hops are single expressions,
 * so reading them proves which shape travels.
 *
 * The extension half IS executed: `tedi.browser` is the tool with the widest
 * action enum, so it is the one that would suffer most from an open-object
 * fallback, and its enum can be checked against the runner that serves it.
 */
import { readFileSync } from "node:fs";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
}

const src = (p: string): string => readFileSync(p, "utf8");

console.log("\nthe host carries a tool's declared schema across both hops");
{
  // Hop 1, in-app: the registry entry's own `parameters` becomes the AI SDK
  // input schema, with an empty object only when the extension declared none.
  check(
    "buildExtensionTools uses item.parameters",
    /item\.parameters && typeof item\.parameters === "object"/.test(
      src("src/modules/ai/tools/extensions.ts"),
    ),
    true,
  );

  // Hop 2, across the bridge. THE POINT OF THIS FILE: drop this and every
  // out-of-process caller sees an anonymous bag instead of the enum.
  check(
    "listExtensions emits parameters",
    /list\.push\(\{ name: item\.name, description: item\.description, parameters: item\.parameters \}\)/.test(
      src("src/modules/extensions/store.ts"),
    ),
    true,
  );

  const server = src("scripts/mcp/server.mjs");
  check(
    "the MCP server advertises them",
    /inputSchema:\s*\n?\s*t\.parameters && typeof t\.parameters === "object"/.test(server),
    true,
  );
  check(
    "with an open-object fallback for a schema-less tool",
    server.includes("additionalProperties: true"),
    true,
  );
  check(
    "and an `ext_` prefix so one can never shadow a built-in",
    server.includes("name: `ext_${t.name}`"),
    true,
  );
}

console.log("\nan image survives BOTH routes rather than arriving as base64 text");
{
  // One recognizer, imported by the renderer and the stdio server alike, so the
  // two cannot disagree about what counts as an image.
  const { extToolMedia } = (await import("@mcp/tools.mjs")) as unknown as {
    extToolMedia: (r: unknown) => { mimeType: string; data: string; text: string } | null;
  };
  check("a media payload is recognised", extToolMedia({ mimeType: "image/jpeg", data: "AA" }), {
    mimeType: "image/jpeg",
    data: "AA",
    text: "",
  });
  check("an ordinary result is not", extToolMedia({ ok: true }), null);
  // The narrowness is the point: a result holding a hash must not be mistaken
  // for an image and swallowed into a file part the model cannot read.
  check("nor is a non-media mime", extToolMedia({ mimeType: "text/plain", data: "x" }), null);

  const inApp = src("src/modules/ai/tools/extensions.ts");
  check(
    "the in-app agent unpacks it",
    inApp.includes("toModelOutput") && inApp.includes("extToolMedia"),
    true,
  );
  check(
    "and so does the stdio server",
    src("scripts/mcp/server.mjs").includes('type: "image", data: media.data'),
    true,
  );
}

console.log("\nthe browser tool's enum and its runner agree");
{
  const mod = (await import("../../extensions/tedi.browser/src/tools.js")) as unknown as {
    TOOL: { name: string; parameters: { properties: { action: { enum: string[] } } } };
    TOOLS: unknown[];
  };
  const { TOOL, TOOLS } = mod;

  check("one tool, not a split surface", TOOLS.length, 1);
  check("named `browser`", TOOL.name, "browser");

  const declared = [...TOOL.parameters.properties.action.enum].sort();

  // Every `case "x":` in `runTool`'s switch. A declared action with no case is a
  // tool call that always fails; a case with no declared action is unreachable
  // for a model that can only pick from the enum. Both are silent.
  const runner = src("extensions/tedi.browser/src/tools.js");
  const body = runner.slice(runner.indexOf("export async function runTool"));
  const implemented = [...body.matchAll(/^\s{4}case "([a-z_]+)":/gm)].map((m) => m[1]).sort();

  check("every declared action is implemented", declared.filter((a) => !implemented.includes(a)), []);
  check("every implemented action is declared", implemented.filter((a) => !declared.includes(a)), []);
  check("and there are enough of them to be worth one tool", declared.length >= 20, true);
}

if (failures > 0) throw new Error(`ext-tool-surface-verify: ${failures} FAILED`);
console.log("\next-tool-surface-verify: OK\n");
