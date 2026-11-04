/** Types for `targets.mjs`, which is plain JS so `tedi mcp install` can run it in Node. */

export type Format = "mcpServers" | "codexToml" | "opencode" | "hermesYaml";

export type Target = {
  id: string;
  name: string;
  /** Global config file, relative to home. */
  file: string;
  /** Project-scoped config file, relative to the open folder. Null when the agent has none. */
  projectFile: string | null;
  /** Paths (relative to home) that prove the agent is installed. Any one will do. */
  probes: string[];
  format: Format;
};

export declare const SERVER_NAME: string;
export declare const TARGETS: Target[];
export declare function entryFor(format: Format, server: string, bundle: string): unknown;
export declare function readsAsInstalled(
  target: Target,
  text: string,
  server: string,
  bundle: string,
): boolean;
export declare function withEntry(
  target: Target,
  text: string,
  server: string,
  bundle: string,
): string;
export declare function withoutEntry(target: Target, text: string): string;
