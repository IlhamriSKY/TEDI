/**
 * An extension's `ctx` must go inert once its context is disposed. Extensions
 * keep `ctx` in closures (intervals, late promises), and a live one let a
 * disabled extension put its status item and listeners straight back.
 * Run: `npx tsx scripts/ext/ext-ctx-inert-verify.ts`.
 */
import { inert } from "../../src/modules/extensions/inert";

let failed = 0;
function check(ok: boolean, label: string): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}

let disposed = false;
const calls: string[] = [];
const ctx = inert(
  {
    id: "a.b",
    paths: { home: "/h" },
    statusBar: {
      setItem(id: string) {
        calls.push(id);
        return this === ctx.statusBar ? "wrapped-this" : "own-this";
      },
    },
    has: () => true,
  },
  () => disposed,
);

check(ctx.id === "a.b" && ctx.paths.home === "/h", "plain values pass through");
check(ctx.has() === true, "a live context answers");
check(ctx.statusBar.setItem("x") === "own-this", "methods keep their own `this`");
check(calls.length === 1, "a live context reaches the host");
disposed = true;
const dead = ctx.statusBar.setItem("y") as unknown as {
  (): void;
  setValue(v: string): void;
  then(cb: (v: unknown) => void): unknown;
};
check(calls.length === 1, "a disposed context never reaches the host");

// Whatever the live method returned, dead extension code keeps running against
// the result without throwing.
let threw = false;
try {
  dead(); // a disposer
  dead.setValue("x"); // a handle method
  void `${String(dead)}`; // interpolation must not throw on the Proxy
} catch {
  threw = true;
}
check(!threw, "calling, chaining and printing the result does not throw");

let ranCallback = false;
dead.then(() => (ranCallback = true));
const outcome = await Promise.race([
  (async () => {
    try {
      await dead;
      return "resolved";
    } catch {
      return "rejected";
    }
  })(),
  new Promise((r) => setTimeout(() => r("hung"), 50)),
]);
check(!ranCallback, "a success callback never runs on a dead result");
check(outcome === "rejected", `awaiting a dead result rejects instead of hanging (${outcome})`);

if (failed > 0) {
  console.error(`\n${failed} failing`);
  process.exit(1);
}
console.log("\next-ctx-inert-verify: OK");
