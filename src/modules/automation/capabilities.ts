/**
 * Capabilities that are one `invoke` away, registered at module scope so they answer from the moment
 * the window is up.
 *
 * `devtools` is answered in Rust before it reaches this realm when a call comes over the socket. It is
 * registered here for TEDI's own agent, which is already in this realm and has no socket to use.
 */
import { invoke } from "@tauri-apps/api/core";
import { registerBridge } from "./bridge";

registerBridge({
  devtools: (method: string, params: unknown) =>
    invoke("automation_devtools", { method, params: params ?? {} }),
  lsp: (args: unknown) => invoke("lsp_query", { args }),
  skills: async (name: string | null, root: string | null) =>
    (await import("@/modules/ai/lib/fileDefinitions")).skillCapability(name, root),
});
