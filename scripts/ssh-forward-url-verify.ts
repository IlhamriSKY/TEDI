/**
 * Self-check for the url math behind SSH auto port forwarding.
 * Run: `npx tsx scripts/ssh-forward-url-verify.ts`.
 *
 * A remote `npm run dev` prints `http://localhost:5173`, which means port 5173
 * ON THE SERVER. TEDI tunnels it and offers the local end in the open-in-browser
 * pill, so these two functions decide which port gets tunnelled and which url
 * the user is handed. Both failure modes are silent and bad: read the wrong
 * port and the tunnel points at nothing, rewrite the url wrongly and the pill
 * opens an unrelated service on the developer's own machine.
 *
 * Pinned here: a url with no port still names one (80/443, not "no port", which
 * would tunnel nothing); the path/query/fragment survive the rewrite, since
 * `/#/route` and `?token=…` are what make a dev-server url worth clicking; and
 * `0.0.0.0` rewrites like any other host, because a server bound to it is
 * reachable on the remote's loopback all the same.
 */
import { remotePortOf, toLocalUrl } from "../src/modules/terminal/lib/forwardUrl";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

console.log("[remotePortOf] the port to tunnel, as the SERVER sees it");
check("vite", remotePortOf("http://localhost:5173"), 5173);
check("trailing slash", remotePortOf("http://localhost:5173/"), 5173);
check("127.0.0.1", remotePortOf("http://127.0.0.1:3000"), 3000);
check("0.0.0.0 is a real bind, not a sentinel", remotePortOf("http://0.0.0.0:8080"), 8080);
check("path does not confuse the port", remotePortOf("http://localhost:4321/admin/x"), 4321);
check("port 1", remotePortOf("http://localhost:1"), 1);
check("port 65535", remotePortOf("http://localhost:65535"), 65535);

console.log("\n[remotePortOf] no port still names one - the scheme default");
check("bare http is 80", remotePortOf("http://localhost/"), 80);
check("bare https is 443", remotePortOf("https://localhost/"), 443);
check(
  "https with an explicit port wins over the default",
  remotePortOf("https://localhost:8443"),
  8443,
);

console.log("\n[remotePortOf] anything unusable is null, so no tunnel is attempted");
check("not a url", remotePortOf("localhost:5173"), null);
check("empty", remotePortOf(""), null);
check("junk", remotePortOf("http://"), null);
check("non-http scheme", remotePortOf("ftp://localhost:21"), null);

console.log("\n[toLocalUrl] the url the pill offers: local end of the tunnel, rest untouched");
check(
  "host and port both move",
  toLocalUrl("http://localhost:5173", 49213),
  "http://127.0.0.1:49213/",
);
check(
  "path survives",
  toLocalUrl("http://localhost:5173/admin", 49213),
  "http://127.0.0.1:49213/admin",
);
check(
  "query and fragment survive",
  toLocalUrl("http://localhost:5173/app?token=abc#/route", 5000),
  "http://127.0.0.1:5000/app?token=abc#/route",
);
check("0.0.0.0 rewrites too", toLocalUrl("http://0.0.0.0:8080/", 41000), "http://127.0.0.1:41000/");
// The bound port is the OS's, never the remote's: binding the remote's 5173
// locally would silently tunnel over the developer's own dev server.
check(
  "an ephemeral port replaces the remote's, it is not mirrored",
  toLocalUrl("http://localhost:5173/", 60123),
  "http://127.0.0.1:60123/",
);
check("junk in stays null out", toLocalUrl("not a url", 5000), null);

console.log(
  "\n[round trip] what the pane actually does: read the port, tunnel it, hand back the local url",
);
const printed = "http://localhost:5173/?ts=1#/dash";
const bound = 51000;
check("remote port read for the tunnel", remotePortOf(printed), 5173);
check(
  "local url handed to the pill",
  toLocalUrl(printed, bound),
  "http://127.0.0.1:51000/?ts=1#/dash",
);

console.log(failed === 0 ? "\nAll ssh-forward-url checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
