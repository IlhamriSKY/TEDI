/** Types for `handlers.mjs`, which is plain JS for the same reason `tools.mjs` is. */

/** Call an app capability by name. Typed loosely: the bridge is a registry, not an interface. */
export type CapabilityCall = (name: string, ...args: unknown[]) => Promise<unknown>;

export type ToolHandler = (call: CapabilityCall, args: Record<string, unknown>) => Promise<unknown>;

export declare const HANDLERS: Record<string, ToolHandler>;
export declare function narrowed<T>(list: T[], filter: unknown): T[];
export declare function resolveTerminal(call: CapabilityCall, leafId: unknown): Promise<number>;
