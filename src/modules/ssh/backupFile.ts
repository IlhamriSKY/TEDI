/**
 * Shape and validation for the `.tedi-ssh` connection backup.
 *
 * An import is a TRUST BOUNDARY: the file came off a USB stick or a chat, and
 * whatever survives this module is written straight into the connections store
 * and later dialled. So every field is re-checked here rather than trusted -
 * a bad port would be sent to `TcpStream::connect`, a bad `proxyJumpId` would
 * make every connect fail with "a jump host in the chain no longer exists",
 * and a non-array `forwards` would bind nothing while looking configured.
 *
 * Kept free of Tauri imports (the `SshConnection` import is type-only, so it
 * is erased at compile time) so `scripts/ssh-backup-verify.ts` can exercise
 * the parser under plain node.
 */
import type { SshConnection, SshAuthMode, SshPortForward } from "./connections";

export const BACKUP_KIND = "tedi-ssh-connections";
export const BACKUP_VERSION = 1;
export const BACKUP_EXTENSION = "tedi-ssh";

/** Encrypted payload produced by the Rust `backup_seal` command. */
export type SealedBlob = {
  kdf: string;
  iterations: number;
  salt: string;
  nonce: string;
  ciphertext: string;
};

/** Plaintext inside `SealedBlob`, keyed by connection id. */
export type BackupSecrets = Record<
  string,
  { password?: string; privateKey?: string; keyPassphrase?: string }
>;

export type SshBackupFile = {
  kind: typeof BACKUP_KIND;
  version: number;
  exportedAt: number;
  connections: SshConnection[];
  secrets: SealedBlob;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A port is only usable if it is a whole number in range; 0 is not valid to dial. */
function port(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535 ? v : null;
}

function sanitizeForwards(v: unknown): SshPortForward[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: SshPortForward[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    // A local port of 0 is meaningful here (bind an ephemeral port), unlike a
    // remote port, so it is allowed through as its own case.
    const localRaw = raw.localPort;
    const local =
      typeof localRaw === "number" &&
      Number.isInteger(localRaw) &&
      localRaw >= 0 &&
      localRaw <= 65535
        ? localRaw
        : null;
    const remotePort = port(raw.remotePort);
    const remoteHost = str(raw.remoteHost).trim();
    if (local === null || remotePort === null || !remoteHost) continue;
    out.push({ localPort: local, remoteHost, remotePort });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Validate one record. Returns null when the entry could not be a working
 * connection, so the caller can skip it and report the count instead of
 * importing something that fails at dial time.
 */
export function sanitizeConnection(raw: unknown): SshConnection | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id).trim();
  const host = str(raw.host).trim();
  const p = port(raw.port);
  if (!id || !host || p === null) return null;

  const authMode: SshAuthMode =
    raw.authMode === "key" || raw.authMode === "agent" ? raw.authMode : "password";
  const description = str(raw.description).trim();
  const proxyJumpId = str(raw.proxyJumpId).trim();
  const lastFingerprint = str(raw.lastFingerprint).trim();
  const lastConnectedAt = raw.lastConnectedAt;
  const forwards = sanitizeForwards(raw.forwards);

  return {
    id,
    // A blank name would render an unclickable row, so fall back to the host.
    name: str(raw.name).trim() || host,
    host,
    port: p,
    user: str(raw.user).trim(),
    authMode,
    // Recomputed by upsertConnection from what actually lands in the keychain;
    // never trusted from the file, or the UI pips would lie.
    hasPassword: false,
    hasPrivateKey: false,
    hasKeyPassphrase: false,
    ...(description ? { description } : {}),
    ...(typeof lastConnectedAt === "number" && Number.isFinite(lastConnectedAt)
      ? { lastConnectedAt }
      : {}),
    // Kept deliberately: it is the pinned host key. Carrying it over means the
    // new machine keeps the same TOFU anchor instead of blindly accepting
    // whatever answers on the first connect.
    ...(lastFingerprint ? { lastFingerprint } : {}),
    ...(proxyJumpId ? { proxyJumpId } : {}),
    ...(forwards ? { forwards } : {}),
  };
}

function sanitizeSealed(raw: unknown): SealedBlob | null {
  if (!isRecord(raw)) return null;
  const kdf = str(raw.kdf);
  const salt = str(raw.salt);
  const nonce = str(raw.nonce);
  const ciphertext = str(raw.ciphertext);
  const iterations = raw.iterations;
  if (!kdf || !salt || !nonce || !ciphertext) return null;
  if (typeof iterations !== "number" || !Number.isInteger(iterations) || iterations < 1)
    return null;
  return { kdf, iterations, salt, nonce, ciphertext };
}

/**
 * Drop `proxyJumpId` references that point at nothing. `known` is every id that
 * will exist after the import (the file's own ids plus what is already saved).
 * A dangling jump id is not cosmetic: `resolveJumpHops` throws on it, so every
 * connect through that host would fail with a message about a host the user
 * never knowingly deleted.
 */
export function clearDanglingJumps(list: SshConnection[], known: Set<string>): SshConnection[] {
  return list.map((c) =>
    c.proxyJumpId && !known.has(c.proxyJumpId) ? { ...c, proxyJumpId: undefined } : c,
  );
}

/**
 * Parse and validate a backup file. Throws with a user-facing message when the
 * file is not a TEDI SSH backup at all; skips individual bad entries instead of
 * failing the whole import, and reports how many were skipped.
 */
export function parseBackupFile(raw: unknown): { file: SshBackupFile; skipped: number } {
  if (!isRecord(raw)) throw new Error("Not a TEDI SSH backup file.");
  if (raw.kind !== BACKUP_KIND) throw new Error("Not a TEDI SSH backup file.");
  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error("Backup file has no usable version.");
  }
  if (version > BACKUP_VERSION) {
    throw new Error(
      `This backup was written by a newer TEDI (format v${version}); this build reads up to v${BACKUP_VERSION}.`,
    );
  }
  if (!Array.isArray(raw.connections)) throw new Error("Backup file has no connections list.");

  const secrets = sanitizeSealed(raw.secrets);
  if (!secrets) throw new Error("Backup file is missing its encrypted credentials block.");

  const connections: SshConnection[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of raw.connections) {
    const conn = sanitizeConnection(entry);
    // A duplicate id would import twice and the second would silently win.
    if (!conn || seen.has(conn.id)) {
      skipped++;
      continue;
    }
    seen.add(conn.id);
    connections.push(conn);
  }

  const exportedAt = typeof raw.exportedAt === "number" ? raw.exportedAt : 0;
  return { file: { kind: BACKUP_KIND, version, exportedAt, connections, secrets }, skipped };
}

/** Validate the decrypted secrets payload before any of it reaches the keychain. */
export function sanitizeSecrets(raw: unknown): BackupSecrets {
  if (!isRecord(raw)) return {};
  const out: BackupSecrets = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!isRecord(v)) continue;
    const entry: BackupSecrets[string] = {};
    if (typeof v.password === "string" && v.password) entry.password = v.password;
    if (typeof v.privateKey === "string" && v.privateKey) entry.privateKey = v.privateKey;
    if (typeof v.keyPassphrase === "string" && v.keyPassphrase) {
      entry.keyPassphrase = v.keyPassphrase;
    }
    if (Object.keys(entry).length > 0) out[id] = entry;
  }
  return out;
}
