/**
 * Export / import saved SSH connections as a single passphrase-encrypted
 * `.tedi-ssh` file, so moving to another machine is one import instead of
 * retyping every host and credential.
 *
 * The credentials live in the OS keychain and CANNOT travel with the store
 * file on their own - a keychain does not move between machines - which is
 * exactly why this exists and why the file is always encrypted: it carries SSH
 * passwords and private keys, so a plaintext export would be a credential leak
 * the moment it touched Downloads or a synced folder. Sealing happens in the
 * host process (`modules/backup.rs`); `crypto.subtle` is not available to the
 * webview because the app origin is plain http.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  getConnectionSecrets,
  listConnections,
  upsertConnection,
  type SshConnection,
} from "./connections";
import {
  BACKUP_KIND,
  BACKUP_VERSION,
  clearDanglingJumps,
  parseBackupFile,
  sanitizeSecrets,
  type BackupSecrets,
  type SealedBlob,
  type SshBackupFile,
} from "./backupFile";

/**
 * Serialize every saved connection plus its keychain secrets into file text.
 * Returns the count alongside it so the caller can say what it wrote without
 * parsing the JSON back out.
 */
export async function buildBackup(passphrase: string): Promise<{ text: string; count: number }> {
  if (!passphrase) throw new Error("A passphrase is required.");
  const connections = await listConnections();
  if (connections.length === 0) throw new Error("There are no saved connections to export.");

  const secrets: BackupSecrets = {};
  for (const c of connections) {
    const s = await getConnectionSecrets(c.id);
    const entry: BackupSecrets[string] = {};
    if (s.password) entry.password = s.password;
    if (s.privateKey) entry.privateKey = s.privateKey;
    if (s.keyPassphrase) entry.keyPassphrase = s.keyPassphrase;
    if (Object.keys(entry).length > 0) secrets[c.id] = entry;
  }

  const sealed = await invoke<SealedBlob>("backup_seal", {
    plaintext: JSON.stringify(secrets),
    passphrase,
  });

  const file: SshBackupFile = {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exportedAt: Date.now(),
    connections,
    secrets: sealed,
  };
  return { text: JSON.stringify(file, null, 2), count: connections.length };
}

export type ImportResult = {
  /** Connections written that did not exist here before. */
  added: number;
  /** Existing ids the backup overwrote. */
  replaced: number;
  /** Entries dropped because they could not be a working connection. */
  skipped: number;
  /** Connections whose credentials did not travel (none were saved for them). */
  withoutSecrets: number;
};

/**
 * Decrypt and merge a backup into the local store. Merging is by connection
 * id, which is stable across renames, so re-importing the same file updates
 * rather than duplicating. Nothing is deleted: a connection that exists here
 * but not in the file is left alone.
 */
export async function applyBackup(text: string, passphrase: string): Promise<ImportResult> {
  if (!passphrase) throw new Error("A passphrase is required.");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  const { file, skipped } = parseBackupFile(raw);

  // Decrypt BEFORE touching the store: a wrong passphrase must leave the
  // existing connections exactly as they were, not half-merged.
  const plain = await invoke<string>("backup_open", {
    blob: file.secrets,
    passphrase,
  });
  let secrets: BackupSecrets;
  try {
    secrets = sanitizeSecrets(JSON.parse(plain));
  } catch {
    throw new Error("The encrypted block did not contain readable credentials.");
  }

  const existing = await listConnections();
  const existingIds = new Set(existing.map((c) => c.id));
  // A jump host may live in the file OR already be saved here; both count as
  // resolvable, so the union is what dangling references are checked against.
  const known = new Set([...existingIds, ...file.connections.map((c) => c.id)]);
  const incoming = clearDanglingJumps(file.connections, known);

  let added = 0;
  let replaced = 0;
  let withoutSecrets = 0;
  for (const conn of incoming) {
    const s = secrets[conn.id];
    if (!s) withoutSecrets++;
    await upsertConnection(conn as SshConnection, {
      // undefined means "leave whatever is already in the keychain", which is
      // the non-destructive choice when re-importing over a host whose
      // credential is already set up here.
      password: s?.password,
      privateKey: s?.privateKey,
      keyPassphrase: s?.keyPassphrase,
    });
    if (existingIds.has(conn.id)) replaced++;
    else added++;
  }

  return { added, replaced, skipped, withoutSecrets };
}
