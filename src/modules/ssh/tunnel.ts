/**
 * Headless SSH port forwards, for callers that want a TCP tunnel rather than a
 * terminal: reaching a database that only a bastion host can see.
 *
 * SECURITY: credentials never leave this module. The caller names a SAVED SSH
 * connection by id and gets back a loopback port; the password / private key
 * come from the OS keychain exactly the way the terminal's own connect reads
 * them. That is what lets an extension (SQL Explorer) tunnel to a private
 * database without ever handling the key.
 *
 * A connection with no pinned server key is REFUSED, mirroring
 * `openSshConnection`: a first connect needs a human to verify the host key,
 * and nothing here can show that dialog.
 */

import { openSsh, openSshForward, type SshJumpHop, type SshSession } from "./bridge";
import { getConnectionSecrets, listConnections, resolveJumpHops } from "./connections";

export type SshForward = {
  /** Runtime SSH session id, as used by `ssh_list_sessions` / `ssh_close`. */
  sessionId: number;
  /** Loopback port the caller should connect to. */
  localPort: number;
};

/** Live sessions opened by this module, keyed by saved-connection id, so
 *  several forwards over one bastion share a single SSH session. */
const sessions = new Map<string, { session: SshSession; refs: number }>();
/** Forwards already open on a session, keyed by `connId|host|port`, so a
 *  reconnect to the same database reuses its port instead of binding another. */
const forwards = new Map<string, SshForward>();

function forwardKey(connectionId: string, remoteHost: string, remotePort: number): string {
  return `${connectionId}|${remoteHost}|${remotePort}`;
}

/** Open (or reuse) the SSH session for a saved connection. */
async function sessionFor(connectionId: string): Promise<SshSession> {
  const live = sessions.get(connectionId);
  if (live) {
    live.refs += 1;
    return live.session;
  }

  const list = await listConnections();
  const conn = list.find((c) => c.id === connectionId);
  if (!conn) throw new Error(`ssh: connection "${connectionId}" not found`);
  if (!conn.lastFingerprint) {
    throw new Error(
      `ssh: "${conn.name || conn.host}" has no verified host key yet. Open it once as an SSH tab and accept the fingerprint, then try again.`,
    );
  }
  const secrets = await getConnectionSecrets(connectionId);
  const jumps: SshJumpHop[] = await resolveJumpHops(conn.proxyJumpId, conn.id, list);

  const session = await openSsh(
    {
      host: conn.host,
      port: conn.port,
      user: conn.user,
      password: conn.authMode === "password" ? (secrets.password ?? "") : undefined,
      privateKey: conn.authMode === "key" ? (secrets.privateKey ?? "") : undefined,
      privateKeyPassphrase:
        conn.authMode === "key" ? (secrets.keyPassphrase ?? undefined) : undefined,
      // Always pinned here: an unpinned connection was rejected above, so a
      // changed host key fails the handshake instead of prompting.
      expectedFingerprint: conn.lastFingerprint,
      jumps,
      // A shell is opened alongside the forward because that is the shape of
      // `ssh_open`; nothing reads from it, so the size is arbitrary.
      cols: 80,
      rows: 24,
    },
    {
      onData: () => {},
      onExit: () => dropSession(connectionId),
      onError: () => dropSession(connectionId),
    },
  );
  sessions.set(connectionId, { session, refs: 1 });
  return session;
}

/** Forget a session that died, so the next request opens a fresh one. */
function dropSession(connectionId: string): void {
  sessions.delete(connectionId);
  for (const key of [...forwards.keys()]) {
    if (key.startsWith(`${connectionId}|`)) forwards.delete(key);
  }
}

/**
 * Tunnel `remoteHost:remotePort` (as resolved from the SSH server) to a
 * loopback port. Repeat calls for the same target reuse the existing forward.
 */
export async function openForwardForConnection(
  connectionId: string,
  remoteHost: string,
  remotePort: number,
): Promise<SshForward> {
  const host = remoteHost.trim();
  if (!host) throw new Error("ssh: port forward needs a remote host");
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) {
    throw new Error("ssh: port forward needs a valid remote port");
  }
  const key = forwardKey(connectionId, host, remotePort);
  const existing = forwards.get(key);
  if (existing) return existing;

  const session = await sessionFor(connectionId);
  try {
    const localPort = await openSshForward(session.id, 0, host, remotePort);
    const forward: SshForward = { sessionId: session.id, localPort };
    forwards.set(key, forward);
    return forward;
  } catch (e) {
    // The session may still be fine (a refused target, say), so only give up
    // our own reference rather than tearing it down for other forwards.
    releaseSession(connectionId);
    throw e;
  }
}

/** Drop one reference to a connection's session, closing it when the last
 *  forward goes away. Forwards themselves close with the session. */
function releaseSession(connectionId: string): void {
  const live = sessions.get(connectionId);
  if (!live) return;
  live.refs -= 1;
  if (live.refs > 0) return;
  sessions.delete(connectionId);
  void live.session.close().catch(() => {});
}

/** Close the tunnel a caller opened. Safe to call for an unknown target. */
export async function closeForwardForConnection(
  connectionId: string,
  remoteHost: string,
  remotePort: number,
): Promise<void> {
  const key = forwardKey(connectionId, remoteHost.trim(), remotePort);
  if (!forwards.delete(key)) return;
  releaseSession(connectionId);
}
