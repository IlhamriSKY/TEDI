/**
 * Self-check for the SSH jump-chain route behind the status-bar indicator.
 * Run: `npx tsx scripts/ssh-route-verify.ts`.
 *
 * A chained connect used to be invisible: you pick "prod-db", it is actually
 * reached through a bastion, and the only trace was a line of terminal
 * scrollback. The indicator is only worth anything if the ORDER is right (the
 * entry host is dialled first, the target last) and if a failure freezes the
 * chain at the hop that broke - a route that says "all pending" after a failure
 * tells the user nothing, and one that says "all failed" blames hosts that
 * actually authenticated fine.
 *
 * The reference-equality checks are not pedantry: the route is handed to React
 * inside the status object, so a helper that mutated in place would not
 * repaint, and one that always returned a fresh array would repaint the status
 * bar on every duplicate hop event.
 */
import {
  allSshHopsUp,
  buildSshRoute,
  failPendingSshHops,
  markSshHop,
  sshHopDetail,
  sshHopLabel,
  type SshRouteHop,
} from "../src/modules/ssh/status";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}
function ok(label: string, cond: boolean): void {
  if (cond) console.log(`  ok: ${label}`);
  else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

const bastion = { user: "ops", host: "bastion.example.com", port: 22 };
const mid = { user: "ops", host: "10.0.0.9", port: 2222 };
const target = { user: "root", host: "prod-db", port: 22 };
const states = (r: SshRouteHop[] | null) => r?.map((h) => h.state);

console.log("[buildSshRoute] a direct connection has no route to draw");
check("no jumps means null", buildSshRoute([], target), null);

console.log("\n[buildSshRoute] order is CONNECT order: entry host first, target last");
const route = buildSshRoute([bastion, mid], target)!;
check("hosts in dial order", route.map(sshHopLabel), [
  "ops@bastion.example.com",
  "ops@10.0.0.9",
  "root@prod-db",
]);
check(
  "only the last hop is the target",
  route.map((h) => h.isTarget),
  [false, false, true],
);
check("everything starts pending", states(route), ["pending", "pending", "pending"]);
// The hop stores user/host/port; the two formatters are the only place the
// display strings are built, so the pill and the tab card cannot disagree.
check(
  "detail carries the port, label does not",
  [sshHopDetail(route[1]), sshHopLabel(route[1])],
  ["ops@10.0.0.9:2222", "ops@10.0.0.9"],
);
check("a single jump still builds a two-hop chain", buildSshRoute([bastion], target)!.length, 2);

console.log("\n[markSshHop] one hop up, nothing else disturbed");
const afterFirst = markSshHop(route, 0, "up");
check("that hop moves", states(afterFirst), ["up", "pending", "pending"]);
ok("a change returns a NEW array, or React would not repaint", afterFirst !== route);
ok("the untouched hops keep their identity", afterFirst[1] === route[1]);
// A hop can report twice (onJumpConnected then the connected sweep); repainting
// the status bar for a no-op change is waste.
ok(
  "re-marking the same state returns the SAME array",
  markSshHop(afterFirst, 0, "up") === afterFirst,
);
ok("an index past the end is a no-op, not a throw", markSshHop(route, 9, "up") === route);
ok("a negative index is a no-op", markSshHop(route, -1, "up") === route);

console.log("\n[allSshHopsUp] a live shell channel proves the whole chain carried");
check("every hop goes up", states(allSshHopsUp(route)), ["up", "up", "up"]);
check("from a partial chain too", states(allSshHopsUp(afterFirst)), ["up", "up", "up"]);
ok(
  "an already-up chain is returned unchanged",
  (() => {
    const up = allSshHopsUp(route);
    return allSshHopsUp(up) === up;
  })(),
);

console.log("\n[failPendingSshHops] freeze the chain where it actually broke");
// The point of the whole indicator: the bastion authenticated, the target did
// not, so the user can see the problem is the LAST link, not their bastion.
const broke = failPendingSshHops(afterFirst);
check("hops that came up keep 'up'", states(broke), ["up", "failed", "failed"]);
ok("the up hop is not blamed", broke[0].state === "up");
check("a fully pending chain all fails", states(failPendingSshHops(route)), [
  "failed",
  "failed",
  "failed",
]);
ok(
  "nothing pending means the same array back",
  (() => {
    const up = allSshHopsUp(route);
    return failPendingSshHops(up) === up;
  })(),
);
ok(
  "already-failed is stable, so a second drop does not churn",
  failPendingSshHops(broke) === broke,
);

console.log("\n[realistic] bastion -> prod-db, connect then drop at the target");
let live = buildSshRoute([bastion], target)!;
check("both pending at dial", states(live), ["pending", "pending"]);
live = markSshHop(live, 0, "up");
check("bastion authenticates", states(live), ["up", "pending"]);
live = failPendingSshHops(live);
check("target refuses; bastion stays credited", states(live), ["up", "failed"]);
const failedHop = live.find((h) => h.state === "failed");
check(
  "and the indicator can name the failing host",
  failedHop && sshHopDetail(failedHop),
  "root@prod-db:22",
);

console.log(failed === 0 ? "\nAll ssh-route checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
