/**
 * The extension loader's activation queue (`extensions/activationQueue.ts`).
 *
 * Three failures it exists to prevent, each of which shipped silently:
 *   - a disable that lands mid-load must stop the load from registering;
 *   - a reload must not run its activation in PARALLEL with the revoked one,
 *     whose teardown removes registrations by key and would blank the new one;
 *   - two activations of one id at once must not both run.
 * Run: `npx tsx scripts/ext/ext-activation-queue-verify.ts`.
 */
import { createActivationQueue } from "../../src/modules/extensions/activationQueue";

let failed = 0;
function check(ok: boolean, label: string): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// A concurrent second activation of the same id is ignored.
{
  const q = createActivationQueue();
  const gate = deferred();
  let calls = 0;
  const a = q.run("x", async () => {
    calls++;
    await gate.promise;
  });
  const b = q.run("x", async () => {
    calls++;
  });
  gate.resolve();
  await Promise.all([a, b]);
  check(calls === 1, "two activations at once run the module once");
  check(!q.pending("x"), "nothing is pending once it finished");
}

// A revoke mid-load is seen by the run, and a replacement waits for it.
{
  const q = createActivationQueue();
  const gate = deferred();
  const order: string[] = [];
  let staleSawRevoke = false;
  const a = q.run("x", async (token) => {
    order.push("A start");
    await gate.promise;
    staleSawRevoke = !q.isCurrent("x", token);
    order.push("A teardown");
  });
  await tick();
  q.revoke("x"); // the user disabled it while it loaded
  check(!q.pending("x"), "a revoked activation no longer counts as pending");
  const b = q.run("x", async (token) => {
    order.push("B start");
    check(q.isCurrent("x", token), "the replacement is the current run");
  });
  await tick();
  check(!order.includes("B start"), "the replacement does not start while the revoked run is live");
  gate.resolve();
  await Promise.all([a, b]);
  check(staleSawRevoke, "the revoked run learns it was revoked, so it undoes itself");
  check(
    order.join(",") === "A start,A teardown,B start",
    `revoked run finishes before the replacement starts (${order.join(" > ")})`,
  );
}

// Revoked while waiting behind another run: never starts at all.
{
  const q = createActivationQueue();
  const gate = deferred();
  let bRan = false;
  const a = q.run("x", () => gate.promise);
  q.revoke("x");
  const b = q.run("x", async () => {
    bRan = true;
  });
  q.revoke("x"); // disabled again before its turn
  gate.resolve();
  await Promise.all([a, b]);
  check(!bRan, "a run revoked while queued never activates");
}

// Disable then Enable fast: the re-activation waits for the ACTIVE extension's
// teardown, which clears its registrations by key.
{
  const q = createActivationQueue();
  const gate = deferred();
  const order: string[] = [];
  const teardown = q.after("x", async () => {
    order.push("teardown start");
    await gate.promise; // a slow module deactivate(), e.g. stopping a sidecar
    order.push("teardown end");
  });
  const enable = q.run("x", async () => {
    order.push("activate");
  });
  await tick();
  check(!order.includes("activate"), "a re-enable does not start while teardown runs");
  gate.resolve();
  await Promise.all([teardown, enable]);
  check(
    order.join(",") === "teardown start,teardown end,activate",
    `teardown finishes before the re-enable registers (${order.join(" > ")})`,
  );
}

// An activate() that never settles must not wedge the id: after the wait bound
// the next run goes ahead (and hot reload, which awaits it, keeps working).
{
  const q = createActivationQueue(30);
  void q.run("x", () => new Promise<void>(() => {})); // hangs forever
  q.revoke("x"); // the author saved a fix, so hot reload revoked it
  let ran = false;
  const outcome = await Promise.race([
    q
      .run("x", async () => {
        ran = true;
      })
      .then(() => "done"),
    new Promise((r) => setTimeout(() => r("wedged"), 500)),
  ]);
  check(ran && outcome === "done", `a hung activation does not wedge the next one (${outcome})`);
}

// A teardown that throws does not block the re-enable behind it.
{
  const q = createActivationQueue();
  const teardown = q.after("x", async () => {
    throw new Error("module deactivate() threw");
  });
  let ran = false;
  await Promise.all([
    teardown.catch(() => {}),
    q.run("x", async () => {
      ran = true;
    }),
  ]);
  check(ran, "a re-enable still runs after a teardown that threw");
}

// A failing run neither wedges the id nor leaks the rejection into the next.
{
  const q = createActivationQueue();
  const a = q.run("x", async () => {
    throw new Error("activate threw");
  });
  let threw = false;
  await a.catch(() => (threw = true));
  let next = false;
  await q.run("x", async () => {
    next = true;
  });
  check(threw, "the caller still sees the failure");
  check(next, "a later activation of the same id still runs");
}

// Ids are independent.
{
  const q = createActivationQueue();
  const gate = deferred();
  let other = false;
  const a = q.run("x", () => gate.promise);
  await q.run("y", async () => {
    other = true;
  });
  check(other, "a slow activation does not hold up another extension");
  gate.resolve();
  await a;
}

if (failed > 0) {
  console.error(`\n${failed} failing`);
  process.exit(1);
}
console.log("\next-activation-queue-verify: OK");
