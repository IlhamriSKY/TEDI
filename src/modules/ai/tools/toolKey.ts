/**
 * The model-facing KEY for a tool, derived from its declared name.
 *
 * A leaf on purpose. These three functions used to live in `tools/mcp.ts`, which
 * imports `lib/tediMcpServer` - so the server could not ask what key an
 * extension tool is filed under without closing an import cycle, and the only
 * other option was a second copy of the rules. A second copy is exactly how the
 * key an extension tool is REGISTERED under drifts from the key the picker
 * SWITCHES OFF, which would make the switch a no-op nobody could see.
 *
 * Zero imports. Anything may import this.
 */

/** Sanitize a tool name to the provider-safe charset for use as an AI SDK tool
 *  key (used for MCP tools and extension tools alike). */
export function sanitizeToolName(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^[0-9]/, "_$&")
    .toLowerCase();
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Clamp a tool key to the provider limit (Anthropic/OpenAI cap names at
 *  `^[A-Za-z0-9_-]{1,64}$`; an over-long key 400s the WHOLE request, not just
 *  that tool). Over the cap, truncate and append a short stable hash so two long
 *  keys sharing a 64-char prefix don't collapse to one. Reused by extension
 *  tools, whose names are equally unbounded. */
export function clampToolKey(key: string, max = 64): string {
  if (key.length <= max) return key;
  const hash = fnv1a(key).toString(36).slice(0, 6);
  return `${key.slice(0, max - 1 - hash.length)}_${hash}`;
}

/** The picker key for one extension AI tool. The single definition both
 *  `buildExtensionTools` (which registers it) and the `run_command` handler
 *  (which must refuse it when it is switched off) resolve through. */
export function extensionToolKey(declaredName: string): string {
  return clampToolKey(sanitizeToolName(declaredName));
}
