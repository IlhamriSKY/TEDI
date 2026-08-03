/**
 * Self-check for the Alt-Tab focus restore policy.
 * Run: `npx tsx scripts/focus-restore-verify.ts`.
 *
 * The whole feature is one decision made two frames after the window comes
 * back, and it can be wrong in two opposite, both-annoying ways: not restoring
 * (the caret stays stranded, which is the bug) or restoring too eagerly (it
 * yanks focus out of the pane the user just clicked to raise the window).
 * `userActed` is the guard that separates them, so it is pinned here as an
 * exhaustive truth table - anyone who drops it fails this.
 */
import { shouldRestoreFocus } from "../src/lib/focusRestore";

let failed = 0;
function check(label: string, got: boolean, want: boolean): void {
  if (got === want) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${got}, want ${want}`);
    failed++;
  }
}

console.log("[the bug this fixes] focus went missing while the window was away");
check(
  "caret stranded, nothing touched: restore it",
  shouldRestoreFocus({ userActed: false, stillConnected: true, alreadyFocused: false }),
  true,
);

console.log("\n[the user always wins] a deliberate click or keystroke is never overridden");
check(
  "raised the window by clicking into a pane",
  shouldRestoreFocus({ userActed: true, stillConnected: true, alreadyFocused: false }),
  false,
);
check(
  "user acted AND the old element is gone",
  shouldRestoreFocus({ userActed: true, stillConnected: false, alreadyFocused: false }),
  false,
);
check(
  "user acted even though the old element still holds focus",
  shouldRestoreFocus({ userActed: true, stillConnected: true, alreadyFocused: true }),
  false,
);
check(
  "user acted, element gone, already focused",
  shouldRestoreFocus({ userActed: true, stillConnected: false, alreadyFocused: true }),
  false,
);

console.log("\n[nothing to do] no work when the element left or never lost focus");
check(
  "the remembered element was unmounted (a closed dialog)",
  shouldRestoreFocus({ userActed: false, stillConnected: false, alreadyFocused: false }),
  false,
);
check(
  "the webview already restored it correctly",
  shouldRestoreFocus({ userActed: false, stillConnected: true, alreadyFocused: true }),
  false,
);
check(
  "unmounted but somehow reported focused: still nothing to do",
  shouldRestoreFocus({ userActed: false, stillConnected: false, alreadyFocused: true }),
  false,
);

console.log(
  "\n[exhaustive] exactly one of the eight combinations restores, and it is the stranded one",
);
let restoring = 0;
for (const userActed of [false, true]) {
  for (const stillConnected of [false, true]) {
    for (const alreadyFocused of [false, true]) {
      if (shouldRestoreFocus({ userActed, stillConnected, alreadyFocused })) restoring++;
    }
  }
}
check("only 1 of 8 combinations restores focus", restoring === 1, true);

console.log(failed === 0 ? "\nAll focus-restore checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
