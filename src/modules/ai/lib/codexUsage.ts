import { homeDir } from "@tauri-apps/api/path";
import { native } from "./native";

/**
 * Record the ChatGPT-account plan usage the Codex backend reports on EVERY
 * response, where the AI Usage Meter extension can read it.
 *
 * WHY: that extension's only Codex source was the Codex CLI's own
 * `~/.codex/sessions/**\/rollout-*.jsonl`. TEDI's ai-native talks to the same
 * backend with the same account but writes none of those, so anyone who works
 * in TEDI rather than the CLI sees the CLI's last snapshot forever. Measured on
 * this machine: the meter read "Monthly 0%, as of 19d 22h ago" from a rollout
 * written three weeks earlier, while the account was really at 42%. Clicking
 * the meter's refresh re-read the same dead file, which is why it never moved.
 *
 * The numbers cost NOTHING to collect: they ride back as `x-codex-*` headers on
 * a request the turn was already making. No extra call, no polling, no token.
 *
 * Deliberately NOT written here: `x-codex-turn-state` (an opaque encrypted
 * blob) and anything else that is not a plain number or a plan name. This file
 * is read by an extension, so it carries only what a usage meter needs.
 */

/** `~/.tedi/` is the established app-to-extension hand-off directory. */
const DIR_REL = ".tedi";
const FILE_REL = `${DIR_REL}/chatgpt-usage.json`;
const ACTIVITY_FILE_REL = `${DIR_REL}/chatgpt-activity.json`;
const MAX_ACTIVITY_EVENTS = 5_000;

/** Re-stamp an unchanged reading at most this often. The percentage moves
 *  slowly, but the extension compares this file's freshness against the CLI's
 *  rollout snapshot, so a stamp that never advances would lose to a stale
 *  rollout. One write per 10 minutes of active use is the whole cost. */
const RESTAMP_MS = 10 * 60_000;

type UsageWindow = {
  usedPercent: number;
  windowMinutes: number;
  /** Epoch ms, or null when the backend sent no reset time. */
  resetsAt: number | null;
};

export type ChatGptUsage = {
  /** Epoch ms this reading was last seen, NOT when it last changed. */
  capturedAt: number;
  planType: string | null;
  activeLimit: string | null;
  primary: UsageWindow | null;
  secondary: UsageWindow | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: number | null } | null;
};

let dirPromise: Promise<string> | null = null;
let activityWriteQueue: Promise<void> = Promise.resolve();
/** Last payload written, minus `capturedAt`, so a ticking clock alone never
 *  triggers a write. */
let lastFingerprint = "";
let lastWriteAt = 0;

/**
 * Record one completed ChatGPT-account turn for the AI Usage Meter activity
 * heatmap. Codex CLI rollouts are not created by TEDI, so the extension cannot
 * otherwise see prompts sent from ai-native. The queue serializes read/modify/
 * write cycles when two turns finish close together and keeps only enough
 * history for the meter's 12-month grid.
 */
export function recordChatGptActivity(capturedAt = Date.now()): void {
  activityWriteQueue = activityWriteQueue.then(async () => {
    try {
      const home = await (dirPromise ??= homeDir().then((h) => h.replace(/[\\/]+$/, "")));
      await native.createDir(`${home}/${DIR_REL}`).catch(() => {});

      let events: number[] = [];
      const existing = await native.readFile(`${home}/${ACTIVITY_FILE_REL}`).catch(() => null);
      if (existing?.kind === "text" && existing.content) {
        try {
          const parsed: unknown = JSON.parse(existing.content);
          const saved =
            parsed && typeof parsed === "object" && "events" in parsed
              ? (parsed as { events?: unknown }).events
              : null;
          if (Array.isArray(saved)) {
            events = saved.filter(
              (value): value is number => typeof value === "number" && Number.isFinite(value),
            );
          }
        } catch {
          // A malformed activity file is replaced by the next valid event.
        }
      }

      events.push(capturedAt);
      if (events.length > MAX_ACTIVITY_EVENTS) events = events.slice(-MAX_ACTIVITY_EVENTS);
      await native.writeFile(
        `${home}/${ACTIVITY_FILE_REL}`,
        `${JSON.stringify({ version: 1, events }, null, 2)}\n`,
      );
    } catch {
      // Activity is best effort and must never affect the agent turn.
    }
  });
}

/**
 * Parse `x-codex-*` headers and persist them if they are new.
 *
 * Safe to call on every step: it is a no-op unless the reading actually changed
 * or the stamp went stale. Never throws - a usage meter must not be able to
 * break a turn.
 */
export async function recordChatGptUsage(headers: unknown): Promise<void> {
  try {
    const usage = parseChatGptUsage(headers);
    if (!usage) return;
    const { capturedAt: _ignored, ...rest } = usage;
    const fingerprint = JSON.stringify(rest);
    const now = Date.now();
    if (fingerprint === lastFingerprint && now - lastWriteAt < RESTAMP_MS) return;

    const home = await (dirPromise ??= homeDir().then((h) => h.replace(/[\\/]+$/, "")));
    // Create on demand: a fresh machine has no `~/.tedi` until something needs
    // it. Already-exists is the normal case, so the failure is ignored here and
    // the write below is what actually reports a real problem.
    await native.createDir(`${home}/${DIR_REL}`).catch(() => {});
    await native.writeFile(`${home}/${FILE_REL}`, `${JSON.stringify(usage, null, 2)}\n`);
    lastFingerprint = fingerprint;
    lastWriteAt = now;
  } catch {
    // Best effort. A meter is not worth a failed turn.
  }
}

/**
 * Headers -> usage, or null when this response carried none.
 *
 * Exported for the self-check: header parsing is the part with edge cases
 * (a plan that reports no secondary window, a missing reset time), and those
 * are far easier to assert on directly than through a file write.
 */
export function parseChatGptUsage(headers: unknown): ChatGptUsage | null {
  const h = normalize(headers);
  if (!h) return null;
  const primary = readWindow(h, "primary");
  const secondary = readWindow(h, "secondary");
  // No window at all means this response simply did not carry usage; keeping
  // the previous file is better than overwriting it with an empty reading.
  if (!primary && !secondary) return null;
  return {
    capturedAt: Date.now(),
    planType: str(h["x-codex-plan-type"]),
    activeLimit: str(h["x-codex-active-limit"]),
    primary,
    secondary,
    credits: readCredits(h),
  };
}

function readWindow(h: Record<string, string>, which: "primary" | "secondary"): UsageWindow | null {
  const usedPercent = num(h[`x-codex-${which}-used-percent`]);
  const windowMinutes = num(h[`x-codex-${which}-window-minutes`]);
  if (usedPercent == null || windowMinutes == null) return null;
  // A zero-length window is the backend saying this tier does not apply to the
  // plan (the Go plan sends `secondary-used-percent: 0` with `window-minutes:
  // 0`), NOT a window that resets instantly. Reporting it would draw a second
  // meaningless 0% bar under the real one.
  if (windowMinutes <= 0) return null;
  const resetAtSec = num(h[`x-codex-${which}-reset-at`]);
  const afterSec = num(h[`x-codex-${which}-reset-after-seconds`]);
  const resetsAt =
    resetAtSec != null && resetAtSec > 0
      ? resetAtSec * 1000
      : afterSec != null && afterSec > 0
        ? Date.now() + afterSec * 1000
        : null;
  return { usedPercent, windowMinutes, resetsAt };
}

function readCredits(h: Record<string, string>): ChatGptUsage["credits"] {
  const has = h["x-codex-credits-has-credits"];
  if (has == null) return null;
  return {
    hasCredits: /^true$/i.test(has),
    unlimited: /^true$/i.test(h["x-codex-credits-unlimited"] ?? ""),
    balance: num(h["x-codex-credits-balance"]),
  };
}

/** The SDK hands back a plain record, but a `Headers` instance is cheap to
 *  accept too. Names are lower-cased so a casing change upstream cannot make
 *  every lookup silently miss. */
function normalize(headers: unknown): Record<string, string> | null {
  if (!headers) return null;
  const out: Record<string, string> = {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((v, k) => {
      out[k.toLowerCase()] = v;
    });
    return out;
  }
  if (typeof headers !== "object") return null;
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof v === "string") out[k.toLowerCase()] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function num(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: string | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}
