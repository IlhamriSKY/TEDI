import {
  getConnectionSecrets,
  listConnections,
  markConnected,
  resolveJumpHops,
  type SshConnection,
} from "@/modules/ssh/connections";
import {
  openSsh,
  openSshForward,
  isHostKeyMismatchError,
  type SshJumpHop,
  type SshSession,
} from "@/modules/ssh/bridge";
import { useHostKeyPrompt } from "@/modules/ssh/hostKeyPrompt";
import type { SshStatus } from "@/modules/ssh/status";
import type { PtySession } from "./pty-bridge";
import { sessions, type Session } from "./sessionState";
import { describeError } from "./session-helpers";
import { flushPendingInput, openPtyForSession, syncPtySize } from "./pty-lifecycle";

const RECONNECT_BACKOFF_MS = [1_000, 3_000, 7_000] as const;
const MAX_SSH_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

// On an SSH drop the remote program (vim/htop/tmux) never got to send its
// mode-reset teardown, so xterm.js stays in whatever stateful modes it left on -
// most visibly mouse tracking, which then streams `ESC[<35;col;rowM` motion
// reports into the reconnected shell as garbage (buffered into pendingInput while
// pty is null, then flushed). Feed the DECRST teardown to the LOCAL term so it
// stops generating those events and any leaked alt-screen / scroll-region /
// cursor state is cleared, without wiping scrollback the way term.reset() would.
const TERM_MODE_RESET =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l" + // mouse tracking off (X11 / btn-event / any-motion)
  "\x1b[?1005l\x1b[?1006l\x1b[?1015l" + // mouse encodings off (UTF-8 / SGR / urxvt)
  "\x1b[?1004l" + // focus reporting off
  "\x1b[?2004l" + // bracketed paste off
  "\x1b[?1049l" + // leave alternate screen (restore normal buffer)
  "\x1b[?25h" + // show cursor
  "\x1b[?7h" + // autowrap on
  "\x1b[r" + // reset scroll region (full height)
  "\x1b[0m"; // reset SGR

export function writeSshBanner(s: Session, text: string): void {
  const enc = new TextEncoder();
  s.term.write(enc.encode(text));
}

export function emitSshStatus(s: Session, next: SshStatus): void {
  s.sshStatus = next;
  s.callbacks.onSshStatus?.(next);
}

export function canRetrySsh(status: SshStatus): boolean {
  return (
    (status.kind === "disconnected" && status.canRetry) ||
    (status.kind === "error" && status.canRetry)
  );
}

export async function openSshForSession(
  s: Session,
  sshConnectionId: string,
  cols: number,
  rows: number,
  onData: (bytes: Uint8Array) => void,
  onExit: (code: number) => void,
): Promise<PtySession> {
  // Look up connection metadata at open time so settings changes are picked up on
  // the next reconnect. These pre-flight failures (profile deleted, jump chain
  // broken or cyclic) are the only ones that happen BEFORE the "connecting"
  // status below, so they are reported explicitly: a leaf that throws here would
  // otherwise sit at `idle` forever, which reads as "still coming up" to
  // everything watching - the terminal's Enter-to-retry stays disabled, and a
  // remote editor pane bound to this profile waits on a session that will never
  // arrive instead of offering to reconnect.
  let conn: SshConnection;
  let secrets: Awaited<ReturnType<typeof getConnectionSecrets>>;
  let jumps: SshJumpHop[];
  try {
    const list = await listConnections();
    const found = list.find((c) => c.id === sshConnectionId);
    if (!found) throw new Error(`ssh: connection "${sshConnectionId}" not found`);
    conn = found;
    secrets = await getConnectionSecrets(sshConnectionId);
    // Resolve the ProxyJump chain (if this host tunnels through others). Done at
    // open time so each reconnect re-reads the current chain + jump secrets.
    jumps = await resolveJumpHops(conn.proxyJumpId, conn.id, list);
  } catch (e) {
    emitSshStatus(s, { kind: "error", message: describeError(e), canRetry: true });
    throw e;
  }

  // `sshReconnectAttempts` is bumped by `scheduleSshReconnect`. 0 means first open.
  const attempt = Math.max(1, s.sshReconnectAttempts);
  emitSshStatus(s, { kind: "connecting", attempt });
  writeSshBanner(
    s,
    `\x1b[2m[tedi] connecting to ${conn.user}@${conn.host}:${conn.port}…\x1b[0m\r\n`,
  );

  // Route the first of onExit/onError into the reconnect scheduler; russh can fire both.
  let terminated = false;
  const handleTerminal = (reason: string) => {
    if (terminated) return;
    terminated = true;
    if (s.disposed) return;
    // SSH dropped. Reset the AI CLI detector so its state doesn't ghost into the next reconnect.
    s.aiCliDetector?.reset();
    // Clear terminal modes the dead program left enabled (mouse tracking, alt
    // screen, ...) so they don't leak into the reconnected shell as garbage.
    s.term.write(TERM_MODE_RESET);
    if (s.sshUserClose) {
      emitSshStatus(s, {
        kind: "disconnected",
        reason: "closed by user",
        canRetry: true,
      });
      onExit(0);
      return;
    }
    // Drop the live handle so attachSession/retrySsh treat the leaf as "needs spawn".
    s.pty = null;
    s.ptySpawnedAt = null;
    scheduleSshReconnect(s, reason);
  };

  // Need both russh session id (from openSsh) and server fingerprint (from onConnected).
  // The two events can land in either order, so emit on session id and re-emit when fingerprint arrives.
  let pendingFingerprint: string | null = null;
  let resolvedSessionId: number | null = null;
  const emitConnectedIfReady = () => {
    if (resolvedSessionId === null) return;
    s.sshReconnectAttempts = 0;
    emitSshStatus(s, {
      kind: "connected",
      fingerprint: pendingFingerprint ?? "",
      since: Date.now(),
      sessionId: resolvedSessionId,
    });
  };

  // Track the first-connect host-key prompt so it can be cleaned up if this
  // attempt dies before the user answers it (see the catch below).
  let hostKeyPromptId: string | null = null;
  let sshSession: SshSession;
  try {
    sshSession = await openSsh(
      {
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.authMode === "password" ? (secrets.password ?? "") : undefined,
        privateKey: conn.authMode === "key" ? (secrets.privateKey ?? "") : undefined,
        privateKeyPassphrase:
          conn.authMode === "key" ? (secrets.keyPassphrase ?? undefined) : undefined,
        // Pin against the last recorded fingerprint. First connect is TOFU; later connects fail fast on mismatch.
        expectedFingerprint: conn.lastFingerprint || undefined,
        jumps,
        cols,
        rows,
      },
      {
        // Pin each jump host's fingerprint on its own saved connection as the
        // chain authenticates, so the next connect verifies it fail-fast.
        onJumpConnected: (connectionId, fp) => {
          void markConnected(connectionId, fp).catch(() => {});
        },
        onConnected: (fp) => {
          // Handshake cleared the host-key gate (pinned, or the user trusted it
          // via the dialog, which already dequeued the prompt). Drop our ref so
          // the failure path can never dismiss a prompt that isn't ours.
          hostKeyPromptId = null;
          writeSshBanner(s, `\x1b[2m[tedi] server key ${fp}\x1b[0m\r\n`);
          pendingFingerprint = fp;
          // Fire-and-forget. Timestamp write failure shouldn't break the session.
          void markConnected(sshConnectionId, fp).catch(() => {});
          emitConnectedIfReady();
        },
        // First connect to a new host: pause for the user to verify the server
        // fingerprint before credentials are sent (shown by the global dialog).
        onHostKeyPrompt: (prompt) => {
          hostKeyPromptId = prompt.promptId;
          useHostKeyPrompt.getState().enqueue(prompt);
        },
        onData,
        onExit: (code) => {
          handleTerminal(code === 0 ? "remote closed" : `exit ${code}`);
        },
        onError: (msg) => {
          writeSshBanner(s, `\r\n\x1b[31m[tedi] ssh error: ${msg}\x1b[0m\r\n`);
          handleTerminal(msg);
        },
      },
    );
  } catch (e) {
    // The connect failed before a live session existed: the host-key prompt
    // timed out (120s backend cap) or was rejected, the credentials were wrong,
    // or the transport dropped. ssh_open surfaces all of these as a promise
    // rejection - NOT via onError - so this is the only place that sees them.
    // If a first-connect prompt was emitted and is still sitting in the queue,
    // drop it: the dialog renders only queue[0], so a dead prompt left at the
    // front would shadow every later attempt's prompt (the bug that forced an
    // app restart to recover).
    if (hostKeyPromptId) {
      useHostKeyPrompt.getState().dismiss(hostKeyPromptId);
      hostKeyPromptId = null;
    }
    throw e;
  }

  resolvedSessionId = sshSession.id;
  emitConnectedIfReady();

  // Saved `ssh -L` rules, re-opened on this fresh session (including every
  // reconnect, since the old session's listeners died with it). Each one is
  // fire-and-forget: a local port that is already taken is worth a line in the
  // terminal, not a failed shell.
  for (const f of conn.forwards ?? []) {
    void openSshForward(sshSession.id, f.localPort, f.remoteHost, f.remotePort).then(
      (bound) =>
        writeSshBanner(
          s,
          `\x1b[2m[tedi] forwarding localhost:${bound} -> ${f.remoteHost}:${f.remotePort}\x1b[0m\r\n`,
        ),
      (e) =>
        writeSshBanner(
          s,
          `\x1b[33m[tedi] port forward ${f.localPort} -> ${f.remoteHost}:${f.remotePort} failed: ${describeError(e)}\x1b[0m\r\n`,
        ),
    );
  }

  // Adapter so SSH looks like a PtySession to the rest of the file. SSH
  // sessions are not persisted via daemon UUIDs (`pty_attach` is local
  // PTY only), so `sessionId` is empty - serialize.ts skips ptyId for
  // SSH leaves.
  return {
    id: sshSession.id,
    sessionId: "",
    alive: true,
    write: (data) => sshSession.write(data),
    resize: (cols, rows) => sshSession.resize(cols, rows),
    close: () => sshSession.close(),
  };
}

export function scheduleSshReconnect(s: Session, reason: string): void {
  if (s.disposed || s.sshUserClose) return;
  if (!s.sshConnectionId) return;
  if (s.sshReconnectTimer) {
    clearTimeout(s.sshReconnectTimer);
    s.sshReconnectTimer = null;
  }
  const attempt = s.sshReconnectAttempts + 1;
  if (attempt > MAX_SSH_RECONNECT_ATTEMPTS) {
    s.sshReconnectAttempts = 0;
    emitSshStatus(s, {
      kind: "disconnected",
      reason,
      canRetry: true,
    });
    writeSshBanner(
      s,
      `\r\n\x1b[33m[tedi] disconnected (${reason}). Press Enter or click Retry to reconnect.\x1b[0m\r\n`,
    );
    return;
  }
  s.sshReconnectAttempts = attempt;
  const delay = RECONNECT_BACKOFF_MS[attempt - 1];
  emitSshStatus(s, {
    kind: "reconnecting",
    attempt,
    nextDelayMs: delay,
    reason,
  });
  writeSshBanner(
    s,
    `\r\n\x1b[33m[tedi] connection lost (${reason}); reconnecting in ${Math.round(
      delay / 1000,
    )}s (attempt ${attempt}/${MAX_SSH_RECONNECT_ATTEMPTS})…\x1b[0m\r\n`,
  );
  s.sshReconnectTimer = setTimeout(() => {
    s.sshReconnectTimer = null;
    void runSshReconnect(s);
  }, delay);
}

async function runSshReconnect(s: Session): Promise<void> {
  if (s.disposed || s.sshUserClose) return;
  if (!s.sshConnectionId) return;
  if (s.pty) return; // already alive
  if (s.ptyOpening) return;
  s.ptyOpening = true;
  s.lastPtyError = null;
  s.term.options.disableStdin = false;
  try {
    const pty = await openPtyForSession(s, s.initialCwd);
    s.ptyOpening = false;
    if (s.disposed) {
      void pty.close();
      return;
    }
    s.pty = pty;
    flushPendingInput(s);
    s.ptySpawnedAt = Date.now();
    // Only sync after the ResizeObserver is wired. Pre-fit defaults would push the wrong size.
    if (s.observer) syncPtySize(s);
  } catch (e) {
    s.ptyOpening = false;
    const msg = describeError(e);
    console.error("ssh reconnect failed:", e);
    if (isHostKeyMismatchError(e)) {
      // Fingerprint mismatches can't auto-recover. Park in error so the user can
      // edit the saved connection (clear lastFingerprint) and retry manually.
      s.sshReconnectAttempts = 0;
      writeSshBanner(s, `\r\n\x1b[31m[tedi] ${msg}\x1b[0m\r\n`);
      emitSshStatus(s, { kind: "error", message: msg, canRetry: true });
      return;
    }
    scheduleSshReconnect(s, msg);
  }
}

/** Manually re-arm a disconnected SSH leaf. Resets the attempt counter for a fresh 3-attempt window. */
export async function retrySsh(s: Session): Promise<void> {
  if (s.disposed) return;
  if (!s.sshConnectionId) return;
  if (s.pty) return;
  if (s.ptyOpening) return;
  if (s.sshReconnectTimer) {
    clearTimeout(s.sshReconnectTimer);
    s.sshReconnectTimer = null;
  }
  s.sshReconnectAttempts = 0;
  s.sshUserClose = false;
  s.term.reset();
  s.placeholderShown = false;
  s.term.options.disableStdin = false;
  await runSshReconnect(s);
}

/** User-initiated SSH close. Sets the user-close flag so the exit handler skips auto-reconnect. */
export async function disconnectSsh(leafId: number): Promise<void> {
  const s = sessions.get(leafId);
  if (!s) return;
  if (!s.sshConnectionId) return;
  s.sshUserClose = true;
  if (s.sshReconnectTimer) {
    clearTimeout(s.sshReconnectTimer);
    s.sshReconnectTimer = null;
  }
  const pty = s.pty;
  s.pty = null;
  s.ptySpawnedAt = null;
  if (pty) await pty.close().catch(() => {});
  emitSshStatus(s, {
    kind: "disconnected",
    reason: "closed by user",
    canRetry: true,
  });
  writeSshBanner(
    s,
    `\r\n\x1b[33m[tedi] disconnected. Press Enter or click Reconnect to come back.\x1b[0m\r\n`,
  );
}

/** Status pill "Reconnect" handle. */
export async function reconnectSsh(leafId: number): Promise<void> {
  const s = sessions.get(leafId);
  if (!s) return;
  if (!s.sshConnectionId) return;
  await retrySsh(s);
}
