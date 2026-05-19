import { invoke, Channel } from "@tauri-apps/api/core";

export type SshEvent =
  | { type: "connected"; fingerprint: string }
  | { type: "data"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

export type SshHandlers = {
  onConnected?: (fingerprint: string) => void;
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
  onError?: (message: string) => void;
};

export type SshOpenInput = {
  host: string;
  port: number;
  user: string;
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
  /** SHA256 fingerprint recorded by a previous successful connect. When set,
   *  the backend rejects the handshake with a `host key mismatch` error if
   *  the server presents a different key - guards against silent MITM on
   *  saved connections. */
  expectedFingerprint?: string;
  cols: number;
  rows: number;
};

/** Prefix the Rust side puts on host-key-mismatch errors. Callers detect
 *  this to offer a "trust new key" affordance instead of treating it as a
 *  generic transient failure that should auto-reconnect. */
export const HOST_KEY_MISMATCH_PREFIX = "ssh: host key mismatch:";

export function isHostKeyMismatchError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith(HOST_KEY_MISMATCH_PREFIX);
}

export type SshSession = {
  id: number;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export async function openSsh(input: SshOpenInput, handlers: SshHandlers): Promise<SshSession> {
  const channel = new Channel<SshEvent>();
  channel.onmessage = (event) => {
    switch (event.type) {
      case "connected":
        handlers.onConnected?.(event.fingerprint);
        break;
      case "data":
        handlers.onData(decodeBase64(event.data));
        break;
      case "stderr":
        // Surface stderr inline - server PTY usually multiplexes both
        // streams onto channel 0 anyway, this is just a safety net.
        handlers.onData(decodeBase64(event.data));
        break;
      case "exit":
        handlers.onExit?.(event.code);
        break;
      case "error":
        handlers.onError?.(event.message);
        break;
    }
  };

  const id = await invoke<number>("ssh_open", {
    input: {
      host: input.host,
      port: input.port,
      user: input.user,
      password: input.password ?? null,
      privateKey: input.privateKey ?? null,
      privateKeyPassphrase: input.privateKeyPassphrase ?? null,
      expectedFingerprint: input.expectedFingerprint ?? null,
      cols: input.cols,
      rows: input.rows,
    },
    onEvent: channel,
  });

  return {
    id,
    write: (data) => invoke("ssh_write", { id, data }),
    resize: (cols, rows) => invoke("ssh_resize", { id, cols, rows }),
    close: () => invoke("ssh_close", { id }),
  };
}
