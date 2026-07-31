/**
 * Self-check for store-listing detection in the browser pane's extensions menu.
 * Run: `npx tsx scripts/browser-store-verify.ts`.
 *
 * The menu offers "Install this extension" whenever the pane is looking at a
 * store listing, the way a real browser's "Add to Chrome" button appears. That
 * offer is driven entirely by picking an extension id out of the current URL,
 * and both directions of getting it wrong are silent:
 *
 *  - too eager, and an ordinary page grows an install button that would fetch
 *    whatever a 32-character path segment happened to look like;
 *  - too strict, and the button never appears on a real listing, which reads as
 *    the feature not existing.
 *
 * Neither shows up in a type check, so the id shape, the host allowlist and the
 * real listing URLs are pinned here. The Rust side has its own test for the same
 * ids on the resolver that turns them into a CRX download; this covers the UI
 * half, which is a different function on a different side of the IPC.
 */
/// <reference types="node" />
import { storeExtensionId } from "../src/modules/browser/lib/extensions";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok" : "FAIL"}: ${name}${ok ? "" : ` -> ${detail}`}`);
  if (!ok) failed++;
}

// Real ids, the same ones the Rust resolver test uses.
const UBOL = "ddkjiahejlhfcafbddmgiahcphecmpfh";
const UBO_EDGE = "odfafepnkmbhccpbejgmiehpchacaeak";
const ADBLOCK = "gighmmpiobklfepjocnamgkkbiglidom";

console.log("\nreal store listings are recognised");
for (const [label, url, want] of [
  ["chrome web store", `https://chromewebstore.google.com/detail/ublock-origin-lite/${UBOL}`, UBOL],
  ["legacy webstore", `https://chrome.google.com/webstore/detail/x/${UBOL}?hl=en`, UBOL],
  [
    "edge add-ons",
    `https://microsoftedge.microsoft.com/addons/detail/ublock/${UBO_EDGE}`,
    UBO_EDGE,
  ],
  // The slug carries a percent-encoded em dash. It is longer than an id and
  // contains characters past `p`, so it must not shadow the id after it.
  [
    "percent-encoded slug",
    `https://chromewebstore.google.com/detail/adblock-%E2%80%94-block-ads-acros/${ADBLOCK}`,
    ADBLOCK,
  ],
  ["trailing path", `https://chromewebstore.google.com/detail/x/${UBOL}/reviews`, UBOL],
] as const) {
  const got = storeExtensionId(url);
  check(label, got === want, `got ${got}`);
}

console.log("\nanything else is left alone");
for (const [label, url] of [
  ["the store front page", "https://chromewebstore.google.com/category/extensions"],
  ["a plain website", "https://example.com/"],
  // The whole point of the host allowlist: an arbitrary site must never be able
  // to make the browser offer an install just by shaping its path like an id.
  ["an id-shaped path elsewhere", `https://evil.example.com/${UBOL}`],
  ["a lookalike host", `https://chromewebstore.google.com.evil.tld/detail/x/${UBOL}`],
  ["http, not https", `http://chromewebstore.google.com/detail/x/${UBOL}`],
  ["31 chars", `https://chromewebstore.google.com/detail/x/${"a".repeat(31)}`],
  ["33 chars", `https://chromewebstore.google.com/detail/x/${"a".repeat(33)}`],
  // Ids use a-p only; a hex sha is the same length and would otherwise match.
  [
    "a same-length sha",
    "https://chromewebstore.google.com/detail/x/a9dd2acb1c3d4e5f60718293a4b5c6d7",
  ],
  ["empty", ""],
] as const) {
  const got = storeExtensionId(url);
  check(label, got === null, `got ${got}`);
}

// `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
if (failed > 0) throw new Error(`browser-store-verify: ${failed} check(s) failed`);
console.log("\nbrowser-store-verify: all checks passed");
