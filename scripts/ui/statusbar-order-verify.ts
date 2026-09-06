/**
 * Status-bar placement for extension items.
 *
 * The bar sorts by extension id, which put every readout wherever the alphabet
 * happened to land it: `tedi.ai-usage` (two usage meters), then `tedi.browser`
 * and `tedi.discord-rich-presence` (state icons), then `tedi.process-monitor`
 * (a memory meter). Three things you scan, split by two things you glance at.
 * `orderStatusItems` now ranks readouts ahead of lights, per EXTENSION so an
 * extension's own items never get separated.
 *
 * Worth a check because the failure is a wrong ORDER: nothing type-checks it,
 * no test renders the bar, and the only other way to notice is to look at the
 * status bar and count.
 *
 * Run: `npx tsx scripts/ui/statusbar-order-verify.ts`.
 */
import { orderStatusItems, type StatusItem } from "../../src/modules/extensions/registries";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) return;
  console.error(`  FAIL ${label}\n    expected ${b}\n    got      ${a}`);
  failures++;
}

const item = (id: string, extra: Partial<StatusItem> = {}): StatusItem => ({
  id,
  icon: "lucide:Activity",
  tooltip: id,
  ...extra,
});

/** The real fleet: two AI usage meters, a browser tab count (label, no bar), a
 *  Discord presence light, a memory meter, a remote-access light. */
const FLEET = [
  { extensionId: "tedi.ai-usage", item: item("claude", { label: "8%", progress: 0.08 }) },
  { extensionId: "tedi.ai-usage", item: item("codex", { label: "41%", progress: 0.41 }) },
  { extensionId: "tedi.browser", item: item("browser", { label: "3", kind: "status" as const }) },
  { extensionId: "tedi.discord-rich-presence", item: item("discord", { kind: "status" as const }) },
  { extensionId: "tedi.process-monitor", item: item("procs", { label: "5.3G", progress: 0.16 }) },
  { extensionId: "tedi.remote-access", item: item("remote", { kind: "status" as const }) },
];

const ids = (entries: { extensionId: string; item: StatusItem }[]) =>
  entries.map((e) => `${e.extensionId}:${e.item.id}`);

// A. The readouts sit together, and the memory meter lands beside the AI usage
//    meters instead of behind the browser and Discord icons.
check("readouts group first", ids(orderStatusItems(FLEET, { kind: "status" })), [
  "tedi.ai-usage:claude",
  "tedi.ai-usage:codex",
  "tedi.process-monitor:procs",
  "tedi.browser:browser",
  "tedi.discord-rich-presence:discord",
  "tedi.remote-access:remote",
]);

// B. A meter that loses its bar (a provider signed out, a first sample still
//    running) must not jump across the bar and split its own extension.
const halfDark = FLEET.map((e) =>
  e.item.id === "codex" ? { ...e, item: item("codex", { kind: "status" as const }) } : e,
);
check("an extension's items stay together", ids(orderStatusItems(halfDark, { kind: "status" })), [
  "tedi.ai-usage:claude",
  "tedi.ai-usage:codex",
  "tedi.process-monitor:procs",
  "tedi.browser:browser",
  "tedi.discord-rich-presence:discord",
  "tedi.remote-access:remote",
]);

// C. An extension with no meter at all keeps alphabetical order among the
//    lights, so placement stays deterministic.
const noMeters = FLEET.filter((e) => e.item.progress === undefined);
check("lights stay alphabetical", ids(orderStatusItems(noMeters, { kind: "status" })), [
  "tedi.browser:browser",
  "tedi.discord-rich-presence:discord",
  "tedi.remote-access:remote",
]);

// D. The compact bar still keeps exactly the metered items, in the same order.
check("compact keeps meters only", ids(orderStatusItems(FLEET, { metersOnly: true })), [
  "tedi.ai-usage:claude",
  "tedi.ai-usage:codex",
  "tedi.process-monitor:procs",
]);

// E. Actions are a separate group and are unaffected by the readout rank.
const withAction = [
  ...FLEET,
  { extensionId: "tedi.screenshot", item: item("shot", { onClick: () => {} }) },
];
check("actions are their own group", ids(orderStatusItems(withAction, { kind: "action" })), [
  "tedi.screenshot:shot",
]);

// F. Ordering must not mutate the registry's array (it is a cached snapshot;
//    `useSyncExternalStore` compares it by identity).
const before = ids(FLEET);
orderStatusItems(FLEET, { kind: "status" });
check("input array is untouched", ids(FLEET), before);

// `throw` rather than `process.exit`, like every sibling check: it fails the
// run without pulling node's globals into a browser-typed project.
if (failures > 0) throw new Error(`${failures} check(s) FAILED`);
console.log("statusbar-order-verify: ok (6 checks)");
