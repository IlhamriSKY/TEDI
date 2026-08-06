import { invoke, Channel } from "@tauri-apps/api/core";

/** First-connect host-key confirmation request from the backend. */
export type SshHostKeyPrompt = { promptId: string; fingerprint: string; host: string };

export type SshEvent =
  | { type: "connected"; fingerprint: string }
  | { type: "jumpConnected"; connectionId: string; fingerprint: string }
  | { type: "hostKeyPrompt"; promptId: string; fingerprint: string; host: string }
  | { type: "data"; data: string }
  | { type: "stderr"; data: string }
  | { type: "exit"; code: number }
  | { type: "error"; message: string };

export type SshHandlers = {
  onConnected?: (fingerprint: string) => void;
  /** A jump host in the ProxyJump chain authenticated. `connectionId` is the
   *  saved connection the hop came from, so the caller pins its fingerprint. */
  onJumpConnected?: (connectionId: string, fingerprint: string) => void;
  /** First-connect host-key confirmation. Show the fingerprint and call
   *  `confirmHostKey(promptId, accept)`; the handshake is paused (no
   *  credentials sent) until then. */
  onHostKeyPrompt?: (prompt: SshHostKeyPrompt) => void;
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
  onError?: (message: string) => void;
};

/** One hop in a ProxyJump chain, resolved from a saved connection + its
 *  keychain secrets. Passed to `openSsh` in connect order (entry host first). */
export type SshJumpHop = {
  connectionId: string;
  host: string;
  port: number;
  user: string;
  useAgent?: boolean;
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
  expectedFingerprint?: string;
};

export type SshOpenInput = {
  host: string;
  port: number;
  user: string;
  /** Authenticate through the local ssh-agent. The private key stays in the
   *  agent; only signatures cross the wire, so no secret is read or stored. */
  useAgent?: boolean;
  password?: string;
  privateKey?: string;
  privateKeyPassphrase?: string;
  /** SHA256 fingerprint from a previous connect. If set and the server key differs, the backend returns a `host key mismatch` error. */
  expectedFingerprint?: string;
  /** ProxyJump chain in connect order (entry host first). Empty/absent = direct. */
  jumps?: SshJumpHop[];
  cols: number;
  rows: number;
};

/** One key held by the local ssh-agent, as `ssh-add -l` would list it. */
export type SshAgentKey = {
  algorithm: string;
  comment: string;
  fingerprint: string;
};

/** Keys the local ssh-agent is holding. Rejects with a message naming what to
 *  start (`ssh-agent` service / `SSH_AUTH_SOCK`) when no agent answers. */
export function listSshAgentKeys(): Promise<SshAgentKey[]> {
  return invoke<SshAgentKey[]>("ssh_agent_keys");
}

/** Prefix used by the Rust side for host-key-mismatch errors. Callers check for this to offer a "trust new key" prompt instead of auto-reconnecting. */
export const HOST_KEY_MISMATCH_PREFIX = "ssh: host key mismatch:";

export function isHostKeyMismatchError(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.startsWith(HOST_KEY_MISMATCH_PREFIX);
}

/** Answer a first-connect host-key prompt. `accept = true` lets the paused
 *  handshake proceed (and pins the fingerprint on success); `false` aborts the
 *  connect before any credential is sent. */
export function confirmHostKey(promptId: string, accept: boolean): Promise<void> {
  return invoke("ssh_confirm_host_key", { promptId, accept });
}

/**
 * Start an `ssh -L` local forward on a live session: bind `127.0.0.1:localPort`
 * and tunnel it to `remoteHost:remotePort` as resolved from the server.
 * `localPort` 0 picks a free port. Resolves with the port actually bound.
 * Forwards close with the session, so there is no counterpart teardown call.
 */
export function openSshForward(
  id: number,
  localPort: number,
  remoteHost: string,
  remotePort: number,
): Promise<number> {
  return invoke<number>("ssh_forward_open", { id, localPort, remoteHost, remotePort });
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
      case "jumpConnected":
        handlers.onJumpConnected?.(event.connectionId, event.fingerprint);
        break;
      case "hostKeyPrompt":
        handlers.onHostKeyPrompt?.({
          promptId: event.promptId,
          fingerprint: event.fingerprint,
          host: event.host,
        });
        break;
      case "data":
        handlers.onData(decodeBase64(event.data));
        break;
      case "stderr":
        // Surface stderr inline. The server PTY usually merges both streams already.
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
      useAgent: input.useAgent ?? false,
      password: input.password ?? null,
      privateKey: input.privateKey ?? null,
      privateKeyPassphrase: input.privateKeyPassphrase ?? null,
      expectedFingerprint: input.expectedFingerprint ?? null,
      jumps: (input.jumps ?? []).map((j) => ({
        connectionId: j.connectionId,
        host: j.host,
        port: j.port,
        user: j.user,
        useAgent: j.useAgent ?? false,
        password: j.password ?? null,
        privateKey: j.privateKey ?? null,
        privateKeyPassphrase: j.privateKeyPassphrase ?? null,
        expectedFingerprint: j.expectedFingerprint ?? null,
      })),
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
