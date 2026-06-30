import { Channel, invoke } from "@tauri-apps/api/core";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Tauri-native stdio transport for the MCP SDK.
 *
 * The SDK's own `StdioClientTransport` spawns the server with Node's
 * `child_process` (via `cross-spawn`/`which`), which references the `process`
 * global and throws `ReferenceError: process is not defined` the moment it's
 * loaded in the webview. This transport delegates spawning to the Rust backend
 * (`mcp_spawn`/`mcp_write`/`mcp_kill` in `src-tauri/src/modules/mcp.rs`):
 * stdout arrives as newline-framed JSON-RPC lines over an IPC `Channel`, and
 * `send` writes JSON + "\n" to the child's stdin. Only browser-safe SDK types
 * are imported (no `client/stdio.js`).
 */

/** Payload mirrored from the Rust `McpEvent` enum (serde tag = "type"). */
type McpEvent =
  | { type: "message"; line: string }
  | { type: "stderr"; line: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

export interface TauriStdioParams {
  /** Unique per connection — used as the backend process key. */
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export class TauriStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private started = false;
  private closed = false;
  private stderrTail: string[] = [];

  /** Recent stderr lines (bounded), surfaced when a connect/handshake fails so
   *  the real reason (missing key, bad arg, crash) isn't lost. */
  get lastStderr(): string {
    return this.stderrTail.join("\n");
  }

  constructor(private params: TauriStdioParams) {}

  async start(): Promise<void> {
    if (this.started) {
      throw new Error("TauriStdioTransport already started");
    }
    this.started = true;

    const channel = new Channel<McpEvent>();
    channel.onmessage = (ev) => {
      if (ev.type === "message") {
        let parsed: JSONRPCMessage;
        try {
          parsed = JSON.parse(ev.line) as JSONRPCMessage;
        } catch (e) {
          this.onerror?.(new Error(`MCP: invalid JSON from server: ${(e as Error).message}`));
          return;
        }
        this.onmessage?.(parsed);
      } else if (ev.type === "stderr") {
        this.stderrTail.push(ev.line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      } else if (ev.type === "error") {
        this.onerror?.(new Error(ev.message));
        this.fireClose();
      } else if (ev.type === "exit") {
        this.fireClose();
      }
    };

    await invoke("mcp_spawn", {
      id: this.params.id,
      command: this.params.command,
      args: this.params.args ?? [],
      env: this.params.env ?? null,
      cwd: this.params.cwd ?? null,
      onEvent: channel,
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await invoke("mcp_write", {
      id: this.params.id,
      data: JSON.stringify(message) + "\n",
    });
  }

  async close(): Promise<void> {
    await invoke("mcp_kill", { id: this.params.id });
    this.fireClose();
  }

  private fireClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
