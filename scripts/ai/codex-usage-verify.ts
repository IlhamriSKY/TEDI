/**
 * Self-check for the ChatGPT-account plan-usage capture.
 * Run: `npx tsx scripts/ai/codex-usage-verify.ts`.
 *
 * WHY IT EXISTS: the AI Usage Meter extension read Codex usage ONLY from the
 * Codex CLI's `~/.codex/sessions/**\/rollout-*.jsonl`. TEDI's ai-native uses the
 * same account against the same backend but writes none of those, so anyone who
 * works in TEDI rather than the CLI watched a frozen number. Measured live on
 * this machine: the meter said "Monthly 0%, as of 19d 22h ago" from a rollout
 * written three weeks earlier, while the account was really at 42%. Clicking
 * the meter's refresh re-read that same dead file, which is the whole reason it
 * never moved.
 *
 * The numbers were already arriving, free, as `x-codex-*` response headers on
 * every turn. `HEADERS` below is the REAL set, copied verbatim from a live
 * response, which is what makes the plan-shape cases here trustworthy rather
 * than invented.
 */
import { parseChatGptUsage } from "../../src/modules/ai/lib/codexUsage";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

/** Verbatim from a live gpt-5.6 response on a ChatGPT "go" plan. */
const HEADERS: Record<string, string> = {
  "x-codex-active-limit": "premium",
  "x-codex-credits-balance": "",
  "x-codex-credits-has-credits": "False",
  "x-codex-credits-unlimited": "False",
  "x-codex-plan-type": "go",
  "x-codex-primary-over-secondary-limit-percent": "0",
  "x-codex-primary-reset-after-seconds": "1438058",
  "x-codex-primary-reset-at": "1790961519",
  "x-codex-primary-used-percent": "42",
  "x-codex-primary-window-minutes": "43200",
  "x-codex-secondary-reset-after-seconds": "0",
  "x-codex-secondary-reset-at": "",
  "x-codex-secondary-used-percent": "0",
  "x-codex-secondary-window-minutes": "0",
  "x-codex-turn-state": "gAAAAABqqfYFNSBRKt4rFXZTifompIGgu-SECRET-LOOKING-BLOB",
  "cf-ray": "irrelevant",
  date: "irrelevant",
};

console.log("[parse] the real header set from a live ChatGPT-account response");
const u = parseChatGptUsage(HEADERS)!;
check("a reading is produced", !!u);
check("the percentage is the live one, not the CLI's stale 0", u.primary?.usedPercent === 42);
check("the 30-day window is reported as such", u.primary?.windowMinutes === 43200);
check("plan type is carried", u.planType === "go");
check("so is the active limit", u.activeLimit === "premium");
check(
  "reset time is epoch SECONDS promoted to ms",
  u.primary?.resetsAt === 1790961519 * 1000,
  u.primary?.resetsAt,
);

console.log("\n[plan shape] a zero-length window is 'not applicable', not 'resets now'");
// The Go plan really does send secondary 0%/0min. Reporting it would draw a
// second, permanently-0% bar under the real one.
check("the 0-minute secondary window is dropped", u.secondary === null);

console.log("\n[secrets] only numbers and plan names reach the file an extension reads");
const serialized = JSON.stringify(u);
check("the encrypted turn-state blob is NOT carried", !serialized.includes("gAAAAAB"));
check("no stray header is copied through", !serialized.includes("cf-ray"));

console.log("\n[edges]");
check(
  "an empty credits balance is null, not 0",
  parseChatGptUsage(HEADERS)?.credits?.balance === null,
);
check("'False' parses as false, not as a truthy string", u.credits?.hasCredits === false);
check(
  "a response with NO codex headers yields null (so a good file is not overwritten)",
  parseChatGptUsage({ date: "x", "cf-ray": "y" }) === null,
);
check("no headers at all is null", parseChatGptUsage(undefined) === null);
check("a non-object is null", parseChatGptUsage("nope") === null);
check(
  "header names are matched case-insensitively",
  parseChatGptUsage({
    "X-Codex-Primary-Used-Percent": "7",
    "X-Codex-Primary-Window-Minutes": "300",
  })?.primary?.usedPercent === 7,
);
check(
  "a Headers instance works as well as a plain record",
  parseChatGptUsage(new Headers(HEADERS))?.primary?.usedPercent === 42,
);
// Without a reset time there is still a usable percentage; the countdown is
// simply absent rather than the whole window being thrown away.
check(
  "a window with no reset time still reports its percentage",
  parseChatGptUsage({
    "x-codex-primary-used-percent": "3",
    "x-codex-primary-window-minutes": "300",
  })?.primary?.resetsAt === null,
);
// `reset-after-seconds` is the fallback when the absolute stamp is missing.
{
  const rel = parseChatGptUsage({
    "x-codex-primary-used-percent": "3",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-after-seconds": "600",
  })?.primary?.resetsAt;
  check(
    "a relative reset falls back to now + seconds",
    rel != null && rel > Date.now() + 590_000 && rel <= Date.now() + 600_000,
  );
}

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
