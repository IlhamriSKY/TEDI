import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";
import { useEffect, useState } from "react";
import type { SshJumpHop } from "./bridge";

// Saved SSH hosts live in a separate LazyStore. Secrets (password, key
// passphrase, private key) go in the OS keychain via secrets_* IPC. The
// store only holds metadata and flags marking which secrets exist.

const STORE_PATH = "tedi-ssh-connections.json";
const STORE_KEY = "connections";

export const SSH_KEYRING_SERVICE = "tedi-ssh";

const PASSWORD_FIELD = "password";
const PRIVATE_KEY_FIELD = "privateKey";
const KEY_PASSPHRASE_FIELD = "keyPassphrase";

export type SshAuthMode = "password" | "key";

/**
 * One `ssh -L` rule. `localPort` is bound on 127.0.0.1 when the session
 * connects; every connection to it is tunneled to `remoteHost:remotePort` as
 * resolved from the SERVER, so a host only that machine can reach (a private
 * database, a bind-to-localhost admin UI) becomes reachable locally.
 */
export type SshPortForward = {
  localPort: number;
  remoteHost: string;
  remotePort: number;
};

export type SshConnection = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  authMode: SshAuthMode;
  /** Password stored in keychain. */
  hasPassword: boolean;
  /** Private key stored in keychain. */
  hasPrivateKey: boolean;
  /** Key passphrase stored in keychain. */
  hasKeyPassphrase: boolean;
  /** UI note. */
  description?: string;
  /** Unix ms of last successful handshake. */
  lastConnectedAt?: number;
  /** SHA256 fingerprint from the last connect. */
  lastFingerprint?: string;
  /**
   * ProxyJump / host chaining: id of another saved connection to tunnel
   * through to reach this host (the "jump host"). Chains transitively - the
   * jump host may itself have a `proxyJumpId`. Absent = direct connection.
   */
  proxyJumpId?: string;
  /**
   * Local port forwards (`ssh -L`) opened on every connect to this host and
   * torn down with the session. Absent/empty = no forwarding.
   */
  forwards?: SshPortForward[];
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });
const CHANGED_EVENT = "tedi://ssh-connections-changed";

// Serialize every store mutation through one chain so concurrent callers can't
// interleave a read-modify-write (listConnections -> mutate -> persist) and lose
// an update. The host-chaining feature makes this race real: a chained connect
// fires markConnected once per jump hop plus once for the target, near
// simultaneously - losing a freshly-pinned fingerprint would silently revert
// that host to a TOFU prompt on the next connect.
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueueWrite<T>(op: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(op, op);
  // Keep the chain alive regardless of any single op's success or failure.
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function keyringAccount(id: string, field: string): string {
  return `${id}::${field}`;
}

export async function listConnections(): Promise<SshConnection[]> {
  const raw = await store.get<SshConnection[]>(STORE_KEY);
  return Array.isArray(raw) ? raw : [];
}

async function persist(list: SshConnection[]): Promise<void> {
  await store.set(STORE_KEY, list);
  await Promise.all([store.save(), emit(CHANGED_EVENT)]);
}

export function newConnectionId(): string {
  // Opaque id. Stays stable across renames so keyring accounts don't drift.
  return `c-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export async function upsertConnection(
  conn: SshConnection,
  secrets: {
    password?: string | null;
    privateKey?: string | null;
    keyPassphrase?: string | null;
  },
): Promise<void> {
  return enqueueWrite(async () => {
    // Flags must agree with what's now in the keyring so UI pips stay accurate.
    const next = { ...conn };
    next.hasPassword = await writeSecret(conn.id, PASSWORD_FIELD, secrets.password);
    next.hasPrivateKey = await writeSecret(conn.id, PRIVATE_KEY_FIELD, secrets.privateKey);
    next.hasKeyPassphrase = await writeSecret(conn.id, KEY_PASSPHRASE_FIELD, secrets.keyPassphrase);

    const list = await listConnections();
    const idx = list.findIndex((c) => c.id === conn.id);
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    await persist(list);
  });
}

export async function deleteConnection(id: string): Promise<void> {
  return enqueueWrite(async () => {
    await Promise.all([
      deleteSecret(id, PASSWORD_FIELD),
      deleteSecret(id, PRIVATE_KEY_FIELD),
      deleteSecret(id, KEY_PASSPHRASE_FIELD),
    ]);
    // Cascade-clear any host that used this one as its jump host, so a deleted
    // jump can't leave another connection pointing at a now-missing id (which
    // would fail every connect with "a jump host in the chain no longer exists").
    const list = (await listConnections())
      .filter((c) => c.id !== id)
      .map((c) => (c.proxyJumpId === id ? { ...c, proxyJumpId: undefined } : c));
    await persist(list);
  });
}

export async function getConnectionSecrets(id: string): Promise<{
  password: string | null;
  privateKey: string | null;
  keyPassphrase: string | null;
}> {
  const [password, privateKey, keyPassphrase] = await Promise.all([
    readSecret(id, PASSWORD_FIELD),
    readSecret(id, PRIVATE_KEY_FIELD),
    readSecret(id, KEY_PASSPHRASE_FIELD),
  ]);
  return { password, privateKey, keyPassphrase };
}

export function onConnectionsChanged(cb: () => void): Promise<UnlistenFn> {
  return listen(CHANGED_EVENT, () => cb());
}

/**
 * Saved hosts keyed by id, kept fresh across edits. Every surface that renders
 * an `ssh:<name>` label needs this same map (the tab strip, the pane headers,
 * the Workspaces panel), and each one loading it by hand is how one of them
 * ends up showing a stale host name after a rename.
 */
export function useSshHosts(): Map<string, SshConnection> {
  const [hosts, setHosts] = useState<Map<string, SshConnection>>(() => new Map());
  useEffect(() => {
    const load = () =>
      void listConnections().then((list) => setHosts(new Map(list.map((c) => [c.id, c]))));
    load();
    const unsub = onConnectionsChanged(load);
    return () => {
      void unsub.then((fn) => fn());
    };
  }, []);
  return hosts;
}

/** Marks a successful SSH handshake. Updates the timestamp and server fingerprint. */
export async function markConnected(id: string, fingerprint: string): Promise<void> {
  return enqueueWrite(async () => {
    const list = await listConnections();
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return;
    list[idx] = {
      ...list[idx],
      lastConnectedAt: Date.now(),
      lastFingerprint: fingerprint || list[idx].lastFingerprint,
    };
    await persist(list);
  });
}

/**
 * Clears the saved server fingerprint so the next connect re-pins via TOFU.
 * Use after the user has verified a legitimate server key rotation.
 */
export async function clearFingerprint(id: string): Promise<void> {
  return enqueueWrite(async () => {
    const list = await listConnections();
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], lastFingerprint: undefined };
    await persist(list);
  });
}

/** Hard cap so a malformed/looping chain can't spin forever building hops. */
const MAX_JUMP_HOPS = 16;

/**
 * Walk a ProxyJump chain into the ordered hop list `openSsh.jumps` expects.
 * Starts at `startProxyJumpId` (the target's `proxyJumpId`) and follows each
 * hop's own `proxyJumpId`, reading keychain secrets per hop. Returns hops in
 * CONNECT order: the publicly-reachable entry host first, the hop closest to
 * the target last. Empty when there is no jump host.
 *
 * `selfId` (the target's id) seeds cycle detection, so a host that lists itself
 * - directly or transitively - throws instead of looping. A missing hop (jump
 * connection was deleted) throws too rather than silently dropping a tunnel.
 */
export async function resolveJumpHops(
  startProxyJumpId: string | undefined,
  selfId: string | undefined,
  all: SshConnection[],
): Promise<SshJumpHop[]> {
  if (!startProxyJumpId) return [];
  const byId = new Map(all.map((c) => [c.id, c]));
  const visited = new Set<string>();
  if (selfId) visited.add(selfId);

  // Collect from target outward: [closest-to-target, ..., entry].
  const chain: SshConnection[] = [];
  let cursor: string | undefined = startProxyJumpId;
  while (cursor) {
    if (visited.has(cursor)) throw new Error("ssh: jump host chain has a cycle");
    visited.add(cursor);
    const hop = byId.get(cursor);
    if (!hop) throw new Error("ssh: a jump host in the chain no longer exists");
    chain.push(hop);
    if (chain.length > MAX_JUMP_HOPS) {
      throw new Error(`ssh: jump host chain too long (max ${MAX_JUMP_HOPS})`);
    }
    cursor = hop.proxyJumpId;
  }

  // Connect order is the reverse: dial the entry host first.
  chain.reverse();

  const hops: SshJumpHop[] = [];
  for (const c of chain) {
    const s = await getConnectionSecrets(c.id);
    hops.push({
      connectionId: c.id,
      host: c.host,
      port: c.port,
      user: c.user,
      // Empty/missing secret -> undefined (not "") so the backend's clear
      // "jump host has no password or private key configured" guard fires
      // instead of a confusing "parse private key failed" on an empty string.
      password: c.authMode === "password" ? s.password || undefined : undefined,
      privateKey: c.authMode === "key" ? s.privateKey || undefined : undefined,
      privateKeyPassphrase: c.authMode === "key" ? (s.keyPassphrase ?? undefined) : undefined,
      expectedFingerprint: c.lastFingerprint || undefined,
    });
  }
  return hops;
}

async function readSecret(id: string, field: string): Promise<string | null> {
  try {
    const v = await invoke<string | null>("secrets_get", {
      service: SSH_KEYRING_SERVICE,
      account: keyringAccount(id, field),
    });
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

// Returns true if a value is now stored for this field. Used to refresh the
// hasPassword / hasPrivateKey / hasKeyPassphrase flags.
async function writeSecret(
  id: string,
  field: string,
  value: string | null | undefined,
): Promise<boolean> {
  if (value === undefined) {
    // undefined means no change. Read back the current flag.
    return (await readSecret(id, field)) !== null;
  }
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    await deleteSecret(id, field);
    return false;
  }
  await invoke("secrets_set", {
    service: SSH_KEYRING_SERVICE,
    account: keyringAccount(id, field),
    password: trimmed,
  });
  return true;
}

async function deleteSecret(id: string, field: string): Promise<void> {
  try {
    await invoke("secrets_delete", {
      service: SSH_KEYRING_SERVICE,
      account: keyringAccount(id, field),
    });
  } catch {
    // Already absent.
  }
}
