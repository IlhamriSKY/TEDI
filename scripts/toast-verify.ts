/**
 * Self-check for the toast/notification surface.
 * Run: `npx tsx scripts/toast-verify.ts`.
 *
 * Both ways this breaks are SILENT, which is why they get a check:
 *   - a new `ToastVariant` with no entry in the `VARIANTS` style map: the card
 *     destructures `undefined` and white-screens the window that fired it,
 *   - a window that can `toast()` but renders no `<Toaster />`: toast listeners
 *     are a per-webview module Set, so the notification is dropped with no
 *     error anywhere (this is exactly how the Settings and float windows lost
 *     every extension-install and format-failure toast).
 * Plus: every variant stays reachable from Settings > General > Notifications,
 * so "check all the notification kinds" stays a click.
 *
 * Source text, not imports: this file is JSX + a path alias + lucide, none of
 * which is worth booting for four structural facts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

const toastSrc = read("src/components/ui/toast.tsx");
const generalSrc = read("src/settings/sections/GeneralSection.tsx");
const cssSrc = read("src/styles/globals.css");

// ---- variants ------------------------------------------------------------
const union = /export type ToastVariant =([^;]+);/.exec(toastSrc)?.[1] ?? "";
const variants = [...union.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
check("ToastVariant union parsed", variants.length >= 5, variants);

for (const v of variants) {
  // Match the entry, not its indentation: prettier reflows this map whenever an
  // entry gets longer, and an indentation-sensitive check fails on the reflow
  // instead of on the thing it is meant to catch.
  check(`variant "${v}" has a style entry`, new RegExp(`\\b${v}:\\s*\\{\\s*Icon:`).test(toastSrc));
}

const previews = /const TOAST_PREVIEWS[\s\S]*?\n\];/.exec(generalSrc)?.[0] ?? "";
check("TOAST_PREVIEWS parsed", previews.length > 0);
for (const v of variants) {
  check(`variant "${v}" is spawnable from Settings`, previews.includes(`variant: "${v}"`));
}

// ---- every toasting webview renders a Toaster -----------------------------
for (const rootFile of [
  "src/app/App.tsx",
  "src/settings/SettingsApp.tsx",
  "src/float/FloatApp.tsx",
  "src/debug/DebugApp.tsx",
]) {
  check(`${rootFile} mounts <Toaster />`, read(rootFile).includes("<Toaster />"));
}

// ---- countdown bar + leave animation -------------------------------------
check(
  "countdown keyframe exists",
  toastSrc.includes("tedi-toast-drain") && cssSrc.includes("@keyframes tedi-toast-drain"),
);

// The card is removed from the list on a timer, so that timer must outlast the
// leave animation - shorter and the toast pops out of existence mid-slide.
const leaveMs = Number(/const LEAVE_MS = (\d+)/.exec(toastSrc)?.[1] ?? 0);
const leaveAnim = Number(
  /leaving\s*\?\s*"[^"]*?duration-(\d+)/.exec(toastSrc.replace(/\s+/g, " "))?.[1] ?? 0,
);
check("leave animation duration parsed", leaveMs > 0 && leaveAnim > 0, { leaveMs, leaveAnim });
check("removal timer outlasts the leave animation", leaveMs >= leaveAnim, { leaveMs, leaveAnim });

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
