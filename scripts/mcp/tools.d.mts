/**
 * Types for `tools.mjs`, which is plain JS on purpose.
 *
 * The table has to be importable by BOTH `server.mjs` (which ships as a bundle
 * resource with no `node_modules` and no TypeScript) and the app bundle. Plain
 * `.mjs` is the only format both can load, so the types live here instead.
 */

/** A JSON Schema fragment, only as deep as a tool argument ever needs. */
export type ToolSchemaProp = {
  type?: "string" | "number" | "boolean" | "object" | "array";
  enum?: readonly string[];
  description?: string;
  items?: ToolSchemaProp;
  properties?: Record<string, ToolSchemaProp>;
  additionalProperties?: boolean;
};

export type ToolSchema = {
  type: "object";
  properties?: Record<string, ToolSchemaProp>;
  required?: readonly string[];
};

/**
 * MCP tool annotations, as of the 2025-11-25 / 2026-07-28 schema.
 *
 * Only the two hints that change what a client DOES are modelled. The spec's
 * defaults are pessimistic - an unannotated tool reads as `destructiveHint:
 * true, openWorldHint: true` - so a pure read like `state` looked exactly as
 * dangerous as `eval_js` to every client that gates on them, and TEDI's own
 * agent had to raise an approval card for a snapshot. `idempotentHint` and
 * `openWorldHint` are omitted deliberately: nothing in the ecosystem acts on
 * them, and this table is loaded into every request of every connected CLI.
 */
export type ToolAnnotations = {
  /** No side effects at all. Lets a client auto-approve. */
  readOnlyHint?: boolean;
  /** Mutates, but reversibly and without destroying anything. */
  destructiveHint?: boolean;
};

export type ToolDef = {
  /** Which pack switch governs this tool. See `src/modules/mcpInstall/packs.ts`. */
  pack: "tedi" | "settings" | "browser" | "ai" | "misc";
  description: string;
  schema: ToolSchema;
  annotations?: ToolAnnotations;
  /**
   * `action` values TEDI's OWN agent may run without an approval card.
   *
   * Not an annotation, and deliberately not sent to anyone. `readOnlyHint` is a
   * per-TOOL claim, but the tools that fold a whole surface behind one `action`
   * enum - `browser`, `pane` - are read-only for some values and not others, so
   * the honest annotation for them is "not read-only" and every call would then
   * raise a card, including reading a page the agent just opened.
   *
   * This is client policy about TEDI's own in-process server, which is why it is
   * only ever read for `config.builtin` (`tools/mcp.ts`). A third-party server
   * cannot set it: the field never crosses the protocol, it is looked up in this
   * table by name.
   */
  auto?: readonly string[];
};

export declare const TOOL_DEFS: Record<string, ToolDef>;
export declare const TOOL_NAMES: string[];
export declare function toolsInPack(pack: ToolDef["pack"]): string[];
/** Null when `args` satisfies the tool's schema, else a sentence saying why not. */
export declare function validateArgs(name: string, args: unknown): string | null;
/** An extension tool result read as an image/audio payload, or null when it is
 *  ordinary data. See the implementation for why the shape is this narrow. */
export declare function extToolMedia(
  result: unknown,
): { mimeType: string; data: string; text: string } | null;
