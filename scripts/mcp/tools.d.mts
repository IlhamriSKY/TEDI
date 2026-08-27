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

export type ToolDef = {
  /** Which pack switch governs this tool. See `src/modules/mcpInstall/packs.ts`. */
  pack: "tedi" | "settings" | "browser" | "ai" | "misc";
  description: string;
  schema: ToolSchema;
};

export declare const TOOL_DEFS: Record<string, ToolDef>;
export declare const TOOL_NAMES: string[];
export declare function toolsInPack(pack: ToolDef["pack"]): string[];
/** Null when `args` satisfies the tool's schema, else a sentence saying why not. */
export declare function validateArgs(name: string, args: unknown): string | null;
