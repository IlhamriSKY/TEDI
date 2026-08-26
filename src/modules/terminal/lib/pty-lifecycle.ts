import { openPty, reattachPty, type PtySession } from "./pty-bridge";
import { sessions, type Session } from "./sessionState";
import {
  MIN_PTY_DIM,
  SPAWN_GRACE_MS,
  SPAWN_TIMEOUT_MS,
  NO_DATA_WATCHDOG_MS,
  REATTACH_REPAINT_CHECK_MS,
  REATTACH_REPAINT_NUDGE_GAP_MS,
  ALT_EXIT_REPAINT_DELAY_MS,
  isDebugPty,
  describeError,
  readTerminalViewport,
} from "./session-helpers";
import { containsSchemeSeparator, findLocalUrl } from "./detectUrl";
import { forwardDetectedUrl, openSshForSession, writeSshBanner } from "./ssh-session";
import { useTerminalTitles } from "./terminalTitles";
import { createWriteMeter } from "./writeMeter";

/**
 * Push xterm dimensions to the live PTY, floored to MIN_PTY_DIM and
 * deduplicated against `lastSentCols/Rows`. Returns true when an IPC resize
 * was issued. Central to every callsite so behavior stays consistent.
 */
export function syncPtySize(s: Session): boolean {
  if (!s.pty || s.disposed) return false;
  const cols = Math.max(MIN_PTY_DIM, s.term.cols);
  const rows = Math.max(MIN_PTY_DIM, s.term.rows);
  if (cols === s.lastSentCols && rows === s.lastSentRows) return false;
  s.lastSentCols = cols;
  s.lastSentRows = rows;
  void s.pty.resize(cols, rows);
  return true;
}

/**
 * Flush terminal-originated bytes buffered while the PTY handle was null.
 * Call immediately after assigning `s.pty`. The critical payload is xterm's
 * reply to a DSR cursor-position query (`ESC[6n`) the shell streams during
 * startup: PSReadLine (and readline/zle) block on that reply before painting
 * the prompt, and the daemon can deliver the query before `invoke("pty_open")`
 * resolves and sets `s.pty`. Without this flush the reply is dropped, the shell
 * hangs, and the pane stays blank.
 */
export function flushPendingInput(s: Session): void {
  if (!s.pty || s.pendingInput.length === 0) return;
  const data = s.pendingInput.join("");
  s.pendingInput = [];
  void s.pty.write(data);
}

export function openPtyForSession(s: Session, cwd: string | undefined): Promise<PtySession> {
  // Capture spawn epoch. Late exit events for a superseded spawn bail before mutating newer state.
  s.ptySpawnEpoch += 1;
  const myEpoch = s.ptySpawnEpoch;

  // Fresh decoder per pty so partial UTF-8 from a prior shell doesn't leak.
  const urlDecoder = new TextDecoder("utf-8", { fatal: false });

  // Auto-opened `ssh -L` tunnels for urls this shell printed, remote port ->
  // in-flight local bound port. Scoped to the spawn on purpose: the forwards
  // die with the SSH session, and a reconnect re-enters here with an empty map.
  const sshUrlForwards = new Map<number, Promise<number>>();

  // Diagnostic counters for the live-PTY-but-empty-pane case. Toggle via TEDI_DEBUG_PTY.
  const debug = isDebugPty();
  let firstByteLogged = false;
  let totalBytes = 0;
  const spawnedAtForLog = performance.now();

  // Keeps a hidden window (Windows lock screen) from queueing PTY output into
  // xterm without bound. See `writeMeter`.
  const writeMeter = createWriteMeter(
    (chunk, done) => s.term.write(chunk, done),
    () => s.disposed || myEpoch !== s.ptySpawnEpoch,
  );

  const onData = (bytes: Uint8Array) => {
    // The Channel data handler can fire after disposeSession() disposed the
    // term, or after a superseded reattach: bail before writing into a
    // disposed or epoch-mismatched shared term.
    if (s.disposed) return;
    if (myEpoch !== s.ptySpawnEpoch) return;
    if (debug && !firstByteLogged) {
      firstByteLogged = true;
      console.info(
        `[tedi-pty] leaf=${s.term.cols}x${s.term.rows} epoch=${myEpoch} first byte after ${Math.round(
          performance.now() - spawnedAtForLog,
        )}ms (${bytes.length}B)`,
      );
    }
    // First bytes from the shell. Disarm the watchdog and record the epoch
    // so `armNoDataWatchdog` won't arm against a shell that already spoke.
    const isFirstByte = s.firstByteEpoch !== myEpoch;
    s.firstByteEpoch = myEpoch;
    if (s.noDataTimer !== null) {
      clearTimeout(s.noDataTimer);
      s.noDataTimer = null;
    }
    // Clear the "starting shell…" placeholder before the shell's first
    // paint so it doesn't linger above the prompt as scrollback. Soft reset
    // (cursor home + erase display) keeps SGR/cursor state owned by the
    // shell's own output.
    if (s.placeholderShown) {
      s.placeholderShown = false;
      s.term.write("\x1b[H\x1b[2J");
    }
    totalBytes += bytes.length;
    writeMeter.push(bytes);
    // Mirror the same bytes to a floating window, if one is open for this leaf.
    s.onOutputTap?.(bytes);
    s.aiCliDetector?.pushOutput(bytes);
    maybeNudgeOnRendererSwitch(s, bytes);
    // Defense-in-depth for the "first byte heals everything" trap: the block
    // above disarmed the no-data watchdog and cleared the placeholder on this
    // first byte. If that byte carried no visible content (an OSC title, a
    // cursor-position reply, bracketed-paste enable) because the real
    // prompt-bearing bytes were lost upstream, the pane would pin blank with
    // every auto-recovery path inert (s.pty is set). Arm a one-shot check that
    // SIGWINCH-nudges the shell to repaint if the viewport is still blank. Inert
    // when the prompt actually paints (the common case). SSH runs its own
    // banner / reconnect flow, so skip it there.
    if (isFirstByte && !s.sshConnectionId) {
      armBlankViewportRepaint(s, myEpoch);
    }
    // A remote `npm run dev` prints `http://localhost:5173`, but that port
    // lives on the REMOTE host, so the pill cannot offer the URL as printed:
    // on this machine it is either dead or, worse, an unrelated local service.
    // Over SSH the address is therefore tunnelled first and the pill fires on
    // the local end of the tunnel.
    if (containsSchemeSeparator(bytes)) {
      const url = findLocalUrl(urlDecoder.decode(bytes, { stream: true }));
      if (url && url !== s.lastDetectedUrl) {
        if (!s.sshConnectionId) {
          s.lastDetectedUrl = url;
          s.lastEmittedUrl = url;
          s.callbacks.onDetectedLocalUrl?.(url);
        } else {
          void forwardDetectedUrl(s, url, sshUrlForwards).then(
            (local) => {
              // Binding the tunnel is async, so re-check what the synchronous
              // path above can take for granted: this pane may have been
              // disposed or respawned while it was in flight.
              if (!local || s.disposed || myEpoch !== s.ptySpawnEpoch) return;
              // Only claim the url once it actually resolved, so a failed
              // tunnel is retried the next time the server prints it rather
              // than being swallowed by the dedupe.
              s.lastDetectedUrl = url;
              s.lastEmittedUrl = local;
              s.callbacks.onDetectedLocalUrl?.(local);
            },
            (e) =>
              writeSshBanner(
                s,
                `\x1b[33m[tedi] could not forward ${url}: ${describeError(e)}\x1b[0m\r\n`,
              ),
          );
        }
      }
    }
  };
  const onExit = (code: number) => {
    if (debug) {
      console.info(
        `[tedi-pty] onExit epoch=${myEpoch} code=${code} totalBytes=${totalBytes} elapsed=${Math.round(performance.now() - spawnedAtForLog)}ms`,
      );
    }
    // Late exit from a replaced pty. Ignore to avoid clobbering newer state.
    if (myEpoch !== s.ptySpawnEpoch) return;

    // Spawn-time crash detection. PTY death within SPAWN_GRACE_MS with non-zero
    // exit means init failed. Hold the leaf with a retry banner instead of closing.
    const spawnedAt = s.ptySpawnedAt;
    const elapsed = spawnedAt !== null ? Date.now() - spawnedAt : Infinity;
    if (
      !s.disposed &&
      !s.sshConnectionId &&
      spawnedAt !== null &&
      elapsed < SPAWN_GRACE_MS &&
      code !== 0
    ) {
      s.pty = null;
      s.ptySpawnedAt = null;
      s.term.options.disableStdin = false;
      const msg = `shell exited with code ${code} ${elapsed}ms after spawn`;
      s.lastPtyError = msg;
      writePtyError(s, msg);
      return;
    }
    // The normal exit path touches the shared term too: skip it once disposed.
    if (s.disposed) return;
    s.term.options.disableStdin = true;
    s.aiCliDetector?.reset();
    if (s.callbacks.onExit) s.callbacks.onExit(code);
    else s.pendingExit = code;
  };

  // Spawn at floored dimensions so a mid-collapse pane doesn't hand the shell a 1x1 viewport.
  const spawnCols = Math.max(MIN_PTY_DIM, s.term.cols);
  const spawnRows = Math.max(MIN_PTY_DIM, s.term.rows);

  if (s.sshConnectionId) {
    return openSshForSession(s, s.sshConnectionId, spawnCols, spawnRows, onData, onExit);
  }

  // Restore path: a saved daemon UUID exists. Try `reattachPty` first. Two
  // ways it can miss, both ending in a fresh spawn at the saved cwd:
  //   1. `reattachPty` rejects - the daemon lost the session entirely
  //      (daemon crash or PC reboot since the workspace was saved).
  //   2. `reattachPty` resolves but `alive === false` - the daemon still
  //      holds the session, but its shell already exited while this GUI was
  //      detached. Reattaching it would only replay frozen scrollback into a
  //      pane that can't take input (the "blank tab that never opens a
  //      terminal" symptom). Discard it and spawn fresh so the tab works.
  // Either way the UUID is consumed - later retries / respawns go through
  // `openPty`. Done in one async fn (not a `.catch` after `.then`) so the
  // fresh-spawn fallback can't be double-fired by the reattach branch.
  const reattachId = s.savedPtyId;
  if (reattachId) {
    s.savedPtyId = undefined;
    return withSpawnTimeout(
      (async (): Promise<PtySession> => {
        let attached: PtySession;
        try {
          attached = await reattachPty(reattachId, spawnCols, spawnRows, { onData, onExit });
        } catch (e) {
          if (isDebugPty()) {
            console.info(
              `[tedi-pty] reattach failed for ${reattachId}, falling back to fresh spawn: ${describeError(e)}`,
            );
          }
          return openPty(spawnCols, spawnRows, { onData, onExit }, cwd);
        }
        if (attached.alive === false) {
          if (isDebugPty()) {
            console.info(
              `[tedi-pty] reattach ${reattachId} resolved dead (shell already exited); respawning fresh`,
            );
          }
          // Tell the daemon to drop the dead session (also reaps its
          // scrollback) and wipe the replayed dead output so the fresh
          // shell paints onto a clean viewport.
          void attached.close().catch(() => {});
          s.term.reset();
          s.placeholderShown = false;
          // The dead session's replayed scrollback already stamped
          // `firstByteEpoch` for this spawn epoch, which would suppress the
          // no-data watchdog for the fresh shell. Clear it so the watchdog
          // can still catch a fresh spawn that stalls during init.
          s.firstByteEpoch = 0;
          return openPty(spawnCols, spawnRows, { onData, onExit }, cwd);
        }
        // Live shell: the daemon replayed its scrollback to reconstruct the
        // screen. That reconstruction can net to a blank viewport (saved tail
        // ended on a screen-clear, the 1 MiB ring was front-trimmed mid-escape,
        // or ConPTY re-rendered at a new size) while the idle shell emits
        // nothing further. Since a byte DID arrive, the no-data watchdog is
        // disarmed and - with `s.pty` set - Enter-to-retry and stuck-recovery
        // are both inert, so the pane would stay blank forever. Arm a one-shot
        // check that nudges the shell to repaint if the viewport is still blank
        // shortly after the replay.
        armBlankViewportRepaint(s, myEpoch);
        return attached;
      })(),
    );
  }

  return withSpawnTimeout(openPty(spawnCols, spawnRows, { onData, onExit }, cwd));
}

/**
 * Rejects with a timeout error if `pty_open` doesn't settle within
 * `SPAWN_TIMEOUT_MS`. Funnels a hung spawn into the retry-banner path. If
 * the promise resolves later, closes the stray PTY so Rust doesn't leak it.
 */
function withSpawnTimeout(p: Promise<PtySession>): Promise<PtySession> {
  return new Promise<PtySession>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`shell did not start within ${Math.round(SPAWN_TIMEOUT_MS / 1000)}s`));
    }, SPAWN_TIMEOUT_MS);
    p.then(
      (pty) => {
        if (settled) {
          void pty.close().catch(() => {});
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(pty);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function writePtyError(s: Session, message: string): void {
  s.term.reset();
  s.placeholderShown = false;
  s.term.options.disableStdin = false;
  s.term.write(
    "\x1b[31m\x1b[1m[tedi] failed to start shell\x1b[0m\r\n" +
      `\x1b[31m${message.replace(/\r?\n/g, "\r\n")}\x1b[0m\r\n\r\n` +
      "\x1b[2mPress Enter to retry, or close the tab.\x1b[0m\r\n",
  );
}

/**
 * Arm the no-data watchdog after a local PTY's open resolves. Fires when
 * the shell produces no output within `NO_DATA_WATCHDOG_MS`. Disarmed by
 * the first `onData`.
 */
export function armNoDataWatchdog(s: Session, epoch: number): void {
  if (s.sshConnectionId) return; // SSH has its own status banner
  // First byte may have arrived before `pty_open` resolved (channel onmessage is
  // wired before the await). Don't arm in that case; the shell is already healthy.
  if (s.firstByteEpoch === epoch) return;
  if (s.noDataTimer !== null) clearTimeout(s.noDataTimer);
  s.noDataTimer = setTimeout(() => {
    s.noDataTimer = null;
    if (s.disposed) return;
    // Bail if a newer spawn has replaced this one.
    if (epoch !== s.ptySpawnEpoch) return;
    // Bail if bytes arrived between timer fire and callback.
    if (!s.pty) return;
    const dyingPty = s.pty;
    s.pty = null;
    s.ptySpawnedAt = null;
    // Close the orphaned PTY so Rust doesn't leak it.
    void dyingPty.close().catch(() => {});
    const msg = `shell did not emit any output within ${Math.round(
      NO_DATA_WATCHDOG_MS / 1000,
    )}s of opening - likely stalled during init`;
    s.lastPtyError = msg;
    console.warn("[tedi-pty] no-data watchdog fired:", msg);
    writePtyError(s, msg);
  }, NO_DATA_WATCHDOG_MS);
}

/**
 * Toggle the PTY row count off by one then restore it after a gap, floored to
 * MIN_PTY_DIM. The two spaced resizes defeat ConPTY's same-size coalescing so
 * the foreground program redraws at the correct current size. Shared by the
 * blank-viewport and alt-exit repaint watchdogs; callers guarantee `s.pty` is
 * live for the current `epoch`.
 */
export function nudgeResizeRoundTrip(s: Session, epoch: number): void {
  if (!s.pty) return;
  const cols = Math.max(MIN_PTY_DIM, s.term.cols);
  const rows = Math.max(MIN_PTY_DIM, s.term.rows);
  const nudgeRows = rows > MIN_PTY_DIM ? rows - 1 : rows + 1;
  void s.pty.resize(cols, nudgeRows);
  s.lastSentCols = cols;
  s.lastSentRows = nudgeRows;
  setTimeout(() => {
    if (s.disposed || epoch !== s.ptySpawnEpoch || !s.pty) return;
    // Re-read the size rather than replaying the one captured above. A tab
    // switch, font-size change or `visible` flip inside this gap re-fits xterm
    // and syncs the PTY directly (not through the ResizeObserver), so restoring
    // the stale numbers would leave the shell wrapping at a width the pane no
    // longer has - with `lastSent*` agreeing, so `syncPtySize` has nothing left
    // to correct and the pane stays garbled until the next pixel-size change.
    const liveCols = Math.max(MIN_PTY_DIM, s.term.cols);
    const liveRows = Math.max(MIN_PTY_DIM, s.term.rows);
    void s.pty.resize(liveCols, liveRows);
    s.lastSentCols = liveCols;
    s.lastSentRows = liveRows;
  }, REATTACH_REPAINT_NUDGE_GAP_MS);
}

/**
 * Arm a one-shot blank-viewport repaint check for the current spawn. A short
 * time after a byte that should have painted, if the normal-screen viewport is
 * still empty while the shell is live, force the shell's line editor
 * (PSReadLine / readline / zle / fish) to repaint its prompt via a SIGWINCH
 * round-trip (toggle the PTY row count). It injects no input, the alt-screen
 * guard skips TUIs, and a healthy spawn (prompt already painted) never trips
 * the blank check - so it is inert except in the broken case.
 *
 * Covers two distinct ways a pane ends up live-but-blank with every recovery
 * path disarmed (the arriving byte cleared the no-data watchdog, and `s.pty`
 * being set makes Enter-to-retry and stuck-recovery no-ops):
 *   1. An `alive` daemon reattach whose raw scrollback replay nets to an empty
 *      screen (saved tail ended on a clear, the 1 MiB ring was front-trimmed
 *      mid-escape, or ConPTY re-rendered at a new size).
 *   2. A fresh spawn whose prompt-bearing bytes were lost upstream (a transient
 *      routing drop) while a later non-visible chunk survived to clear the
 *      placeholder and disarm the watchdog.
 * Guarded by `blankRepaintEpoch` so it arms at most once per spawn even when
 * both the reattach and first-byte call sites fire for the same epoch.
 */
function armBlankViewportRepaint(s: Session, epoch: number): void {
  if (s.blankRepaintEpoch === epoch) return; // already armed for this spawn
  s.blankRepaintEpoch = epoch;
  setTimeout(() => {
    if (s.disposed) return;
    if (epoch !== s.ptySpawnEpoch) return; // superseded by a respawn
    if (!s.pty) return; // torn down or errored before the check ran
    let isAlt = false;
    try {
      isAlt = s.term.buffer.active.type === "alternate";
    } catch {
      return;
    }
    if (isAlt) return; // a foreground TUI owns the screen; never nudge it
    if (readTerminalViewport(s.term).trim() !== "") return; // something painted
    // Blank viewport + live shell: toggle the PTY row count so the shell's line
    // editor (PSReadLine / readline / zle / fish) repaints its prompt. Two
    // spaced resizes so ConPTY can't coalesce them into a net no-op.
    if (isDebugPty()) {
      console.info(
        "[tedi-pty] blank-viewport repaint nudge: viewport empty after first paint, forcing redraw",
      );
    }
    nudgeResizeRoundTrip(s, epoch);
  }, REATTACH_REPAINT_CHECK_MS);
}

/**
 * Full-screen clear detector: CSI 2J / CSI 3J / RIS (ESC c). A TUI emits one of
 * these when it repaints the WHOLE screen. Byte capture of Claude Code 2.1.181
 * proved its `/tui` renderer switch (fullscreen <-> classic) redraws on the
 * NORMAL screen buffer with `ESC[2J` and never touches the alternate screen, so
 * `onBufferChange` cannot catch it. Claude's per-keystroke inline redraws use
 * cursor-up + erase-line (never 2J), so this stays quiet during normal use and
 * fires ~once per renderer switch.
 */
function hasFullScreenClear(bytes: Uint8Array): boolean {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0x1b) continue;
    if (bytes[i + 1] === 0x63) return true; // ESC c (RIS - full reset)
    if (
      bytes[i + 1] === 0x5b && // ESC [
      i + 3 < bytes.length &&
      (bytes[i + 2] === 0x32 || bytes[i + 2] === 0x33) && // 2 | 3
      bytes[i + 3] === 0x4a // J
    ) {
      return true;
    }
  }
  return false;
}

/** Debounce window so a burst of clears in one frame schedules a single nudge. */
const lastRendererNudgeAt = new WeakMap<Session, number>();

/**
 * Repaint nudge for an AI CLI that switches its renderer ON THE NORMAL SCREEN
 * (Claude Code `/tui fullscreen` <-> `/tui default`). No alternate-screen flip
 * happens there, so `onBufferChange` never fires; we key on the full-screen
 * clear in the live PTY output instead. Gated on an active AI CLI so a plain
 * shell `clear` never triggers it. Mirrors a manual window resize (the user's
 * known workaround) via `armAltExitRepaintWatchdog` (re-fit + SIGWINCH) so the
 * relaunched renderer repaints at the correct size and input echo lands back
 * on-screen. NOTE: efficacy of the nudge on the actual corruption is pending a
 * runtime resize-test confirmation before this is released.
 */
// Claude prints a confirmation containing "<mode> renderer" on every /tui
// switch ("Switching back to the classic renderer", "Already using the
// fullscreen renderer", ...). Captured from the real CLI, this text is a far
// more reliable switch signal than the full-screen clear, which the inline
// classic renderer does not always emit.
const RENDERER_SWITCH_RE = /\b(?:classic|fullscreen|default)\s+renderer\b/i;
function outputSignalsRendererSwitch(bytes: Uint8Array): boolean {
  if (hasFullScreenClear(bytes)) return true;
  try {
    return RENDERER_SWITCH_RE.test(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
  } catch {
    return false;
  }
}

function maybeNudgeOnRendererSwitch(s: Session, bytes: Uint8Array): void {
  if (!s.aiCliStatus) return; // only while an AI CLI (claude/codex/...) owns the pane
  if (!outputSignalsRendererSwitch(bytes)) return;
  const now = Date.now();
  if (now - (lastRendererNudgeAt.get(s) ?? 0) < 300) return;
  lastRendererNudgeAt.set(s, now);
  armAltExitRepaintWatchdog(s);
}

/**
 * Repair the pane after a foreground program toggles OUT of the alternate
 * screen (CSI ?1049l) - e.g. quitting vim/htop, or any AI CLI whose fullscreen
 * renderer DOES use the alternate screen. (Claude Code 2.1.181's `/tui` does
 * NOT - see maybeNudgeOnRendererSwitch for that normal-buffer path.)
 *
 * Two verified xterm 6.0.0 facts make this necessary:
 *   1. `BufferSet.activateNormalBuffer` restores only the cursor on a ?1049l
 *      exit; it never resets the normal buffer's DECSTBM scroll region. A region
 *      left dangling makes the relaunched classic renderer paint its prompt box
 *      against the wrong top/bottom margins (the fragmented box + stray rules in
 *      the bug report).
 *   2. A same-size `term.resize` is a no-op (CoreBrowserTerminal.resize
 *      early-returns when cols/rows are unchanged), and TEDI's only repaint
 *      trigger - the ResizeObserver - never fires because the pane's pixel size
 *      did not change. So nothing recovers the pane on its own.
 * The line-editor redraw then lands off-screen / clipped by the bad margins, so
 * input LOOKS dead even though keystrokes are still delivered (onData forwards
 * unconditionally; nothing flips `disableStdin` outside shell exit).
 *
 * Recovery, deferred so the relaunch's first frame has landed: reset the scroll
 * region (DECSC/DECRC wrap it so the cursor + SGR are preserved; a no-op for a
 * plain shell prompt), clear the WebGL glyph atlas, and force a full local
 * repaint. All three are local to the renderer: nothing is written to the PTY
 * and the foreground program is not disturbed.
 *
 * It used to end with a SIGWINCH round-trip (toggle the PTY row count so the
 * program redraws at the "new" size). That was removed in #21: a program that
 * re-anchors its cursor with DSR on resize races the artificial double resize
 * and thrashes its viewport, which is visible as the screen jumping when a
 * modal overlay closes. Replaying a real CLI's bytes through a headless xterm
 * renders clean, so what this repairs is render timing rather than anything in
 * the byte stream, and the atlas clear plus repaint address that directly.
 * `nudgeResizeRoundTrip` is still the right tool in `armBlankViewportRepaint`,
 * where the pane has no content at all and only the program can supply it.
 *
 * Fires only on the alt->normal edge so a TUI being launched (normal->alt) is
 * never disturbed.
 */
export function armAltExitRepaintWatchdog(s: Session): void {
  const epoch = s.ptySpawnEpoch;
  setTimeout(() => {
    if (s.disposed || epoch !== s.ptySpawnEpoch || !s.pty) return;
    let isAlt = false;
    try {
      isAlt = s.term.buffer.active.type === "alternate";
    } catch {
      return;
    }
    if (isAlt) return; // a TUI re-entered the alt screen during the delay
    try {
      // DECSC + DECSTBM-reset + DECRC: reset the scroll region, keep the cursor.
      s.term.write("\x1b7\x1b[r\x1b8");
      // Force the WebGL renderer to re-rasterize glyphs, clearing any stale
      // texture-atlas cells left behind by the renderer-switch redraw.
      s.webglAddon?.clearTextureAtlas();
      s.term.refresh(0, s.term.rows - 1);
    } catch {
      return;
    }
  }, ALT_EXIT_REPAINT_DELAY_MS);
}

/** Retry a PTY spawn. Wired to Enter for recovery. No-op if opening, alive, or disposed. */
export async function retryPty(s: Session): Promise<void> {
  if (s.disposed) return;
  if (s.pty) return;
  if (s.ptyOpening) return;
  s.ptyOpening = true;
  s.lastPtyError = null;
  s.term.reset();
  s.term.options.disableStdin = false;
  s.term.write("\x1b[2m[tedi] retrying…\x1b[0m\r\n");
  // Treat the retrying hint as the new placeholder so the first PTY byte
  // wipes it instead of leaving "retrying…" stuck above the prompt.
  s.placeholderShown = true;
  // Seed to the values openPtyForSession spawns at (floored) so post-spawn syncPtySize no-ops.
  s.lastSentCols = Math.max(MIN_PTY_DIM, s.term.cols);
  s.lastSentRows = Math.max(MIN_PTY_DIM, s.term.rows);
  let myEpoch = 0;
  try {
    const promise = openPtyForSession(s, s.initialCwd);
    // Captured after the synchronous epoch bump so a later recovery won't be overwritten.
    myEpoch = s.ptySpawnEpoch;
    const pty = await promise;
    if (s.disposed) {
      void pty.close().catch(() => {});
      return;
    }
    if (myEpoch !== s.ptySpawnEpoch) {
      void pty.close().catch(() => {});
      return;
    }
    s.ptyOpening = false;
    s.pty = pty;
    flushPendingInput(s);
    s.ptySpawnedAt = Date.now();
    syncPtySize(s);
    armNoDataWatchdog(s, s.ptySpawnEpoch);
  } catch (e) {
    // Drop stale failures. myEpoch === 0 means synchronous throw before counter bump.
    if (myEpoch !== 0 && myEpoch !== s.ptySpawnEpoch) return;
    s.ptyOpening = false;
    const msg = describeError(e);
    s.lastPtyError = msg;
    console.error("retryPty: openPty failed:", e);
    writePtyError(s, msg);
  }
}

export async function respawnSession(leafId: number, cwd?: string): Promise<void> {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.pty?.close();
  s.pty = null;
  s.ptySpawnedAt = null;
  s.term.reset();
  // term.reset() does not re-emit onTitleChange, so a previous program's OSC
  // title (e.g. an AI agent) would linger in the sidebar until the fresh shell
  // happens to set one. Clear it so the row reverts to the plain folder name.
  useTerminalTitles.getState().clearTitle(leafId);
  s.placeholderShown = false;
  s.term.options.disableStdin = false;
  s.lastSentCols = 0;
  s.lastSentRows = 0;
  s.lastDetectedUrl = null;
  s.lastEmittedUrl = null;
  s.pendingExit = null;
  // Hold the flag so attachSession can't open a second PTY mid-await.
  s.ptyOpening = true;
  s.lastPtyError = null;
  let pty: PtySession;
  let myEpoch = 0;
  try {
    const promise = openPtyForSession(s, cwd);
    myEpoch = s.ptySpawnEpoch;
    pty = await promise;
  } catch (e) {
    if (myEpoch !== 0 && myEpoch !== s.ptySpawnEpoch) return;
    s.ptyOpening = false;
    const msg = describeError(e);
    s.lastPtyError = msg;
    console.error("respawnSession: openPty failed:", e);
    writePtyError(s, msg);
    return;
  }
  if (s.disposed) {
    void pty.close().catch(() => {});
    return;
  }
  if (myEpoch !== s.ptySpawnEpoch) {
    void pty.close().catch(() => {});
    return;
  }
  s.ptyOpening = false;
  s.pty = pty;
  flushPendingInput(s);
  s.ptySpawnedAt = Date.now();
  if (s.observer) syncPtySize(s);
  armNoDataWatchdog(s, s.ptySpawnEpoch);
}
