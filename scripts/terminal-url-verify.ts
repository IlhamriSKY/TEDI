/**
 * Self-check for reading a dev server's url out of terminal output.
 * Run: `npx tsx scripts/terminal-url-verify.ts`.
 *
 * This is what lights the open-in-browser pill when a server is started INSIDE
 * TEDI. The failure is silent - no error, the pill simply never appears - and it
 * was live: vite prints its port in bold, and the escape both split the port off
 * the host and glued the colour code's trailing `m` to `http`, so `npm run dev`
 * matched nothing at all. Laravel only worked by luck, printing a `[` between
 * the escape and the url.
 *
 * The two banner cases below are RAW BYTES captured from real servers
 * (`vite 7`, `php artisan serve` on Laravel 12), not hand-written samples, so
 * they carry the exact escapes that broke it.
 */
import { containsSchemeSeparator, findLocalUrl } from "../src/modules/terminal/lib/detectUrl";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

console.log("[captured banners] the exact bytes a real server writes");
// vite: `http://localhost:` then BOLD around the port, then `/`.
const VITE =
  "\x1b[22m\x1b[2m\x1b[0m ms\x1b[22m\n\n  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5199\x1b[22m/\x1b[39m\n";
check("vite (npm run dev)", findLocalUrl(VITE), "http://localhost:5199/");

// Laravel: bold wraps the whole bracketed url, and a full stop follows it.
const ARTISAN =
  "\n  \x1b[37;44m INFO \x1b[39;49m Server running on \x1b[1m[http://127.0.0.1:8199]\x1b[22m.  \n\r\n\x1b[33m  \x1b[39m\x1b[33;1mPress Ctrl+C to stop the server\x1b[39;22m\n";
check("php artisan serve", findLocalUrl(ARTISAN), "http://127.0.0.1:8199");

console.log("\n[other servers] the same shapes, coloured and plain");
check(
  "next dev",
  findLocalUrl("   \x1b[32m▲ Next.js\x1b[0m\n   - Local:  \x1b[36mhttp://localhost:3000\x1b[0m\n"),
  "http://localhost:3000",
);
check(
  "plain, no escapes at all",
  findLocalUrl("Serving on http://localhost:8080\n"),
  "http://localhost:8080",
);
check(
  "a bound-to-everything server",
  findLocalUrl("Listening on \x1b[1mhttp://0.0.0.0:9000\x1b[0m\n"),
  "http://0.0.0.0:9000",
);
check("https", findLocalUrl("\x1b[36mhttps://localhost:8443/\x1b[0m"), "https://localhost:8443/");
check(
  "path survives",
  findLocalUrl("open http://localhost:5173/admin/x"),
  "http://localhost:5173/admin/x",
);

console.log("\n[trailing punctuation] a sentence must not become part of the url");
check("full stop", findLocalUrl("see http://localhost:3000."), "http://localhost:3000");
check("bracket and stop", findLocalUrl("at [http://localhost:3000]."), "http://localhost:3000");
check("comma", findLocalUrl("http://localhost:3000/app, or"), "http://localhost:3000/app");

console.log("\n[nothing to offer] must stay null rather than guess");
check("no url", findLocalUrl("\x1b[32mcompiled successfully\x1b[0m\n"), null);
// A remote host is not reachable from here; SSH tunnels it before the pill.
check("a public host", findLocalUrl("deployed to https://example.com"), null);
check("a LAN address", findLocalUrl("http://192.168.1.20:3000"), null);
check("empty", findLocalUrl(""), null);

console.log("\n[last wins] a restarted server is read at its newest address");
check(
  "second banner beats the first",
  findLocalUrl("http://localhost:3000\n...restarting...\nhttp://localhost:3001\n"),
  "http://localhost:3001",
);

console.log("\n[byte gate] the cheap pre-check before decoding a chunk");
const enc = new TextEncoder();
check("chunk carrying a url", containsSchemeSeparator(enc.encode("go to http://x")), true);
check("ordinary output", containsSchemeSeparator(enc.encode("compiled in 42ms")), false);
check("empty chunk", containsSchemeSeparator(enc.encode("")), false);
// The gate runs on every chunk, so it must not read past the end.
check("a two-byte chunk does not overrun", containsSchemeSeparator(enc.encode(":/")), false);

console.log(failed === 0 ? "\nAll terminal-url checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
