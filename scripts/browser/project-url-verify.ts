/**
 * Self-check for reading a project's own url out of its config.
 * Run: `npx tsx scripts/browser/project-url-verify.ts`.
 *
 * The input is a config file from a cloned repo, so it is untrusted - and with
 * auto-open on it is acted on without a click. `safeLocalUrl` is the whole
 * boundary, so both halves are pinned here: a real local address survives, and
 * anything that would leave this machine is refused.
 */
import {
  parseHostsFile,
  portFromPackageJson,
  portFromViteConfig,
  safeLocalUrl,
  urlFromConfig,
  urlFromEnv,
} from "../../src/modules/browser/lib/projectUrl";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

console.log("[safeLocalUrl] addresses on this machine are kept");
check("loopback name", safeLocalUrl("http://localhost:8000"), "http://localhost:8000/");
check("loopback literal", safeLocalUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000/");
check("ipv6 loopback", safeLocalUrl("http://[::1]:5173/"), "http://[::1]:5173/");
// A Herd / Valet style vhost needs no lookup: `.test` cannot be registered
// publicly, so it can only ever resolve through this machine.
check("reserved vhost tld", safeLocalUrl("http://myapp.test"), "http://myapp.test/");
check("nested vhost label", safeLocalUrl("https://api.myapp.test/v1"), "https://api.myapp.test/v1");
check(
  "rfc 6761 localhost tld",
  safeLocalUrl("http://app.localhost:9000"),
  "http://app.localhost:9000/",
);
check("path survives", safeLocalUrl("http://localhost:8000/admin"), "http://localhost:8000/admin");
check(
  "query and fragment survive",
  safeLocalUrl("http://localhost:8000/app?t=1#/x"),
  "http://localhost:8000/app?t=1#/x",
);
// The browser cannot navigate to the wildcard bind, but a server on it is
// reachable over loopback like any other.
check("0.0.0.0 becomes loopback", safeLocalUrl("http://0.0.0.0:8080/"), "http://127.0.0.1:8080/");
check(
  "surrounding whitespace",
  safeLocalUrl("  http://localhost:8000  "),
  "http://localhost:8000/",
);

console.log("\n[safeLocalUrl] anything that would leave this machine is refused");
check("public host", safeLocalUrl("https://example.com"), null);
check("bare ip", safeLocalUrl("http://93.184.216.34:8000"), null);
// The dangerous near-miss: a host that merely CONTAINS a local name.
check("localhost as a subdomain of a real host", safeLocalUrl("http://localhost.evil.com"), null);
check("vhost tld as a prefix, not a suffix", safeLocalUrl("http://test.evil.com"), null);
check("lan address", safeLocalUrl("http://192.168.1.50:8080"), null);
check("cloud metadata address", safeLocalUrl("http://169.254.169.254/"), null);
check("non-http scheme", safeLocalUrl("file:///etc/passwd"), null);
check("javascript scheme", safeLocalUrl("javascript:alert(1)"), null);
check("not a url", safeLocalUrl("localhost:8000"), null);
check("empty", safeLocalUrl(""), null);
// Credentials would be sent to whatever answers on that port and would then sit
// in the address bar; the pill only needs the address.
check(
  "credentials are stripped",
  safeLocalUrl("http://user:secret@localhost:8000/"),
  "http://localhost:8000/",
);

// Verbatim from a Laragon machine's hosts file, ad-block-style null routes and
// the commented-out default line included.
const HOSTS = `# Copyright (c) 1993-2009 Microsoft Corp.
#	127.0.0.1       localhost
127.0.0.1 kubernetes.docker.internal
127.0.0.1      siaska-new.dev       #laragon magic!
127.0.0.1      awesome-indonesia.dev #laragon magic!
::1            ipv6app.dev
0.0.0.0        ads.tracker.example
192.168.1.9    nas.lan
`;
const hosts = parseHostsFile(HOSTS);

console.log("\n[parseHostsFile] what this machine actually points at itself");
check("laragon vhost", hosts.has("siaska-new.dev"), true);
check("ipv6 loopback mapping", hosts.has("ipv6app.dev"), true);
check("plain 127.0.0.1 entry", hosts.has("kubernetes.docker.internal"), true);
// A commented line is not a mapping - and on Windows the default `localhost`
// line ships commented out, so this is the live case, not a hypothetical.
check("commented-out line", hosts.has("localhost"), false);
// Ad-block lists null-route domains to 0.0.0.0; that address is not reachable
// and collecting it would hand the pill a host for no reason.
check("null-routed domain", hosts.has("ads.tracker.example"), false);
check("lan address is not loopback", hosts.has("nas.lan"), false);

console.log("\n[safeLocalUrl] a hosts entry is what makes a registrable TLD local");
// Laragon's default TLD is `.dev`, which is real and public. Suffix rules
// cannot separate the user's project from a stranger's domain; the hosts file
// can, and it is local config rather than anything that came with a repo.
check(
  "laragon .dev vhost with an entry",
  safeLocalUrl("https://siaska-new.dev", hosts),
  "https://siaska-new.dev/",
);
check("the same TLD without an entry", safeLocalUrl("https://attacker.dev", hosts), null);
check("no hosts file at all still refuses it", safeLocalUrl("https://siaska-new.dev"), null);
check(
  "public host is not rescued by a hosts set",
  safeLocalUrl("https://example.com", hosts),
  null,
);
check(
  "case is not significant",
  safeLocalUrl("https://SIASKA-NEW.dev", hosts),
  "https://siaska-new.dev/",
);

console.log("\n[urlFromEnv] APP_URL, the line a laravel / laragon project already has");
check(
  "plain",
  urlFromEnv("APP_NAME=Tedi\nAPP_URL=http://tedi.test\nDB_HOST=127.0.0.1"),
  "http://tedi.test",
);
check("double quoted", urlFromEnv('APP_URL="http://tedi.test"'), "http://tedi.test");
check("single quoted", urlFromEnv("APP_URL='http://tedi.test'"), "http://tedi.test");
check("trailing comment", urlFromEnv("APP_URL=http://tedi.test # local vhost"), "http://tedi.test");
check("export prefix", urlFromEnv("export APP_URL=http://tedi.test"), "http://tedi.test");
check("indented", urlFromEnv("  APP_URL=http://tedi.test"), "http://tedi.test");
check("with a port", urlFromEnv("APP_URL=http://localhost:8000"), "http://localhost:8000");
check("absent", urlFromEnv("APP_NAME=Tedi\nDB_HOST=127.0.0.1"), null);
check("empty value", urlFromEnv("APP_URL="), null);
// A key that merely ENDS in APP_URL is a different variable.
check("similar key is not APP_URL", urlFromEnv("VITE_APP_URL=http://other.test"), null);

console.log("\n[portFromViteConfig] the dev-server port");
check("server block", portFromViteConfig("export default { server: { port: 5173 } }"), 5173);
check("spacing", portFromViteConfig("server:{port:3000}"), 3000);
check("no port pinned", portFromViteConfig("export default { plugins: [react()] }"), null);
check("out of range is not a port", portFromViteConfig("{ port: 70000 }"), null);

console.log("\n[portFromPackageJson] a port pinned in the dev script");
check("--port with a space", portFromPackageJson('{"scripts":{"dev":"vite --port 5174"}}'), 5174);
check("--port=", portFromPackageJson('{"scripts":{"dev":"next dev --port=3001"}}'), 3001);
check("-p short flag", portFromPackageJson('{"scripts":{"dev":"next dev -p 3002"}}'), 3002);
check(
  "PORT= env prefix",
  portFromPackageJson('{"scripts":{"start":"PORT=8080 node server.js"}}'),
  8080,
);
check(
  "falls through dev to start",
  portFromPackageJson('{"scripts":{"dev":"tsc -w","start":"vite --port 4000"}}'),
  4000,
);
// A framework default is not a promise that anything is listening, so an
// unpinned script yields nothing rather than a guess.
check("no port pinned", portFromPackageJson('{"scripts":{"dev":"vite"}}'), null);
check("no scripts", portFromPackageJson('{"name":"x"}'), null);
check("malformed json", portFromPackageJson("{not json"), null);
// `-p` is a flag, not any letter p: this would otherwise read 8 out of "-w 8".
check(
  "a bare number is not a port",
  portFromPackageJson('{"scripts":{"dev":"node --max-old-space-size=8192 x.js"}}'),
  null,
);

console.log("\n[urlFromConfig] what the pane actually calls, filter included");
check("env url", urlFromConfig(".env", "APP_URL=http://tedi.test\n"), "http://tedi.test/");
// The filter runs on config-sourced urls too, not just on hand-typed ones.
check(
  "env url off this machine is dropped",
  urlFromConfig(".env", "APP_URL=https://evil.com"),
  null,
);
// The end-to-end shape of the case this was built for: a Laravel `.env` on a
// Laragon machine, allowed only because the hosts file vouches for the name.
check(
  "laragon project's own .env",
  urlFromConfig(".env", 'APP_NAME=Siaska\nAPP_URL="https://siaska-new.dev"\n', hosts),
  "https://siaska-new.dev/",
);
check(
  "same .env on a machine without that vhost",
  urlFromConfig(".env", 'APP_URL="https://siaska-new.dev"\n'),
  null,
);
check(
  "vite port becomes a loopback url",
  urlFromConfig("vite.config.ts", "export default { server: { port: 5173 } }"),
  "http://localhost:5173/",
);
check(
  "a full path is fine, only the basename decides the parser",
  urlFromConfig("D:/proj/vite.config.js", "server: { port: 4173 }"),
  "http://localhost:4173/",
);
check(
  "package.json port",
  urlFromConfig("package.json", '{"scripts":{"dev":"vite --port 5174"}}'),
  "http://localhost:5174/",
);
check("unknown file", urlFromConfig("README.md", "http://localhost:8000"), null);
// The scan cap must not change the answer for anything of a sane size, and must
// hold for a file that is not.
check(
  "value past the scan cap is not read",
  urlFromConfig(".env", `${"# padding\n".repeat(9000)}APP_URL=http://tedi.test`),
  null,
);

console.log(failed === 0 ? "\nAll project-url checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
