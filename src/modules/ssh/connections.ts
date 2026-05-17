import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { LazyStore } from "@tauri-apps/plugin-store";

/// Saved SSH hosts live in their own LazyStore so the main settings file
/// doesn't grow unbounded with one record per connection. Secrets
/// (password / key passphrase / private key body) are kept in the OS
/// keychain via the existing secrets_* IPC commands - the store only
/// holds the non-sensitive metadata + flags indicating which secret
/// fields exist.

const STORE_PATH = "tedi-ssh-connections.json";
const STORE_KEY = "connections";

export const SSH_KEYRING_SERVICE = "tedi-ssh";

const PASSWORD_FIELD = "password";
const PRIVATE_KEY_FIELD = "privateKey";
const KEY_PASSPHRASE_FIELD = "keyPassphrase";

export type SshAuthMode = "password" | "key";

export type SshConnection = {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  authMode: SshAuthMode;
  /** True if a password is stored in the keychain for this connection. */
  hasPassword: boolean;
  /** True if a private key body is stored in the keychain. */
  hasPrivateKey: boolean;
  /** True if a passphrase is stored for the private key. */
  hasKeyPassphrase: boolean;
  /** Free-form note shown in the UI. */
  description?: string;
  /** Unix ms of the most recent successful `Connected` handshake. */
  lastConnectedAt?: number;
  /** SHA256 fingerprint of the server key recorded on the last connect. */
  lastFingerprint?: string;
};

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });
const CHANGED_EVENT = "tedi://ssh-connections-changed";

function keyringAccount(id: string, field: string): string {
  return `${id}::${field}`;
}

export async function listConnections(): Promise<SshConnection[]> {
  const raw = await store.get<SshConnection[]>(STORE_KEY);
  return Array.isArray(raw) ? raw : [];
}

async function persist(list: SshConnection[]): Promise<void> {
  await store.set(STORE_KEY, list);
  await store.save();
  await emit(CHANGED_EVENT);
}

export function newConnectionId(): string {
  // Random opaque id - the user-visible name lives in `name`. Keeps the
  // keyring account stable across renames.
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
  // Reflect what's actually stored - flags must agree with the keyring
  // after this call returns so the UI's "configured" pips are accurate.
  const next = { ...conn };
  next.hasPassword = await writeSecret(conn.id, PASSWORD_FIELD, secrets.password);
  next.hasPrivateKey = await writeSecret(conn.id, PRIVATE_KEY_FIELD, secrets.privateKey);
  next.hasKeyPassphrase = await writeSecret(conn.id, KEY_PASSPHRASE_FIELD, secrets.keyPassphrase);

  const list = await listConnections();
  const idx = list.findIndex((c) => c.id === conn.id);
  if (idx >= 0) list[idx] = next;
  else list.push(next);
  await persist(list);
}

export async function deleteConnection(id: string): Promise<void> {
  await Promise.all([
    deleteSecret(id, PASSWORD_FIELD),
    deleteSecret(id, PRIVATE_KEY_FIELD),
    deleteSecret(id, KEY_PASSPHRASE_FIELD),
  ]);
  const list = (await listConnections()).filter((c) => c.id !== id);
  await persist(list);
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
 * Record that a connection completed an SSH handshake. Writes back the
 * timestamp and the server-key fingerprint so the UI can show "last: 2h
 * ago" pips and the user can spot a key rotation across reconnects.
 */
export async function markConnected(id: string, fingerprint: string): Promise<void> {
  const list = await listConnections();
  const idx = list.findIndex((c) => c.id === id);
  if (idx < 0) return;
  list[idx] = {
    ...list[idx],
    lastConnectedAt: Date.now(),
    lastFingerprint: fingerprint || list[idx].lastFingerprint,
  };
  await persist(list);
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

// Returns true if a value is now stored for this field (used to refresh the
// "has password" / "has key" flags on the connection record).
async function writeSecret(
  id: string,
  field: string,
  value: string | null | undefined,
): Promise<boolean> {
  if (value === undefined) {
    // undefined = "no change requested" - read back the existing flag.
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
    // already absent - fine
  }
}
