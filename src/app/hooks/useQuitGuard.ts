import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit } from "@tauri-apps/plugin-process";
import { useCallback, useEffect, useRef, useState } from "react";

import { disconnectAllMcpClients } from "@/modules/ai/lib/mcpClient";
import { flushNotes } from "@/modules/editor/lib/notes";
import { killAllDaemonSessions } from "@/modules/terminal/lib/pty-bridge";
import { busyTerminalCount } from "@/modules/terminal/lib/sessionState";

/** Hard cap on the pre-quit workspace flush so a slow/hung write can't wedge the close. */
const FLUSH_TIMEOUT_MS = 1200;
/** Same for the force-quit kill: a daemon round-trip that hangs would otherwise
 *  hold the window open for the client's full 30s request timeout. */
const KILL_TIMEOUT_MS = 2000;

/**
 * Set once the quit is committed (either choice), never cleared - the window is
 * on its way out. Read by `handleLeafExit`: a force quit kills every shell, and
 * the resulting Exit cascade must NOT tear the pane tree down (that layout would
 * then be flushed over the user's real one) nor hit its respawn-the-last-terminal
 * branch (which would leave a fresh shell behind in the daemon).
 */
let quitting = false;

export function isQuitting(): boolean {
  return quitting;
}

export type QuitGuard = {
  /** Number of busy terminals when the quit prompt opened; null while not prompting. */
  busyCount: number | null;
  /** Dismiss the prompt and stay open. */
  cancel: () => void;
  /** Quit. `force` also kills every daemon-owned terminal session first. */
  quit: (force: boolean) => void;
};

/**
 * Window-close gate. Two jobs:
 *
 *  1. Durably flush the workspace snapshot before the window goes away. The
 *     per-change save is fire-and-forget and can be mid-write when the app quits
 *     or an update relaunches it, which is the "close a pane but it's back on
 *     reopen" symptom.
 *  2. Prompt when terminals are still working (see `isSessionBusy`), offering
 *     the two quits that actually differ: a light quit leaves the sessions with
 *     the PTY daemon - it outlives the GUI, so a build or agent keeps running and
 *     the tabs reattach on next launch - or a force quit that kills them all.
 *     Nothing to prompt about (no busy terminal) means no dialog.
 *
 * Safety: hard timeout races on both the kill and the flush, and an always-run
 * destroy in `finally` so a slow or failed step can never hang the close. Once
 * the quit is committed, a further close request is left alone (no
 * preventDefault) so Tauri's own destroy still gets the window out - an escape
 * hatch if anything in `finish` stalls. While the prompt is merely open the
 * guard is still clear, so clicking X again just re-reads the busy count.
 */
export function useQuitGuard(flush: () => Promise<void>, enabled: boolean): QuitGuard {
  const [busyCount, setBusyCount] = useState<number | null>(null);
  // Live refs: the close listener is registered once, but `flush` is re-created
  // by its store on every workspace change.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const closingRef = useRef(false);

  const finish = useCallback(async (force: boolean) => {
    const w = getCurrentWindow();
    quitting = true;
    try {
      if (force) {
        await Promise.race([
          killAllDaemonSessions(),
          new Promise((r) => setTimeout(r, KILL_TIMEOUT_MS)),
        ]);
      }
    } catch (e) {
      // Daemon gone or unreachable: its sessions are unreachable too. Quit anyway.
      console.warn("quit: kill-all failed, closing regardless:", e);
    }
    // MCP servers are child processes too, and nothing was reaping them: on
    // macOS/Linux each is its own process-group leader, so it survived TEDI.
    // Unconditional (not gated on `force`) because these are ours either way,
    // and bounded by the same timeout - a server that ignores stdin EOF must not
    // keep the window open.
    try {
      await Promise.race([
        disconnectAllMcpClients(),
        new Promise((r) => setTimeout(r, KILL_TIMEOUT_MS)),
      ]);
    } catch (e) {
      console.warn("quit: MCP disconnect failed, closing regardless:", e);
    }
    try {
      // `flushNotes` rides the same cap: a quick note autosaves on a debounce,
      // and this is the one moment that debounce would otherwise lose.
      await Promise.race([
        Promise.all([flushNotes(), flushRef.current()]),
        new Promise((r) => setTimeout(r, FLUSH_TIMEOUT_MS)),
      ]);
    } catch {
      /* flush failed; close anyway */
    } finally {
      // destroy() needs core:window:allow-destroy; if that grant ever goes
      // missing again the rejection would leave the window uncloseable, so
      // fall back to quitting the process.
      void w.destroy().catch(() => void exit(0));
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (closingRef.current) return;
        // Every path below finishes the close itself, so keep the window alive
        // for the flush (and the prompt, when one is needed).
        event.preventDefault();
        const busy = busyTerminalCount();
        if (busy === 0) {
          closingRef.current = true;
          void finish(false);
          return;
        }
        setBusyCount(busy);
      })
      .then((un) => {
        unlisten = un;
      })
      .catch(() => {
        /* no real Tauri close event (dev browser shim): nothing to flush on */
      });
    return () => unlisten?.();
  }, [enabled, finish]);

  const cancel = useCallback(() => setBusyCount(null), []);

  const quit = useCallback(
    (force: boolean) => {
      closingRef.current = true;
      setBusyCount(null);
      void finish(force);
    },
    [finish],
  );

  return { busyCount, cancel, quit };
}
