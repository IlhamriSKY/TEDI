import { useEffect, useRef } from "react";

/**
 * Coalesce the two events that both mean "the window is back".
 *
 * Returning to a locked or backgrounded machine fires `visibilitychange` (to
 * visible) and then `focus`, a few milliseconds apart. Every panel that
 * refreshes on return listens for both, so each one ran its whole refresh
 * twice: unlocking kicked off two passes of directory listing, two of git
 * status and two of remote listing at once, against a disk cache that had gone
 * cold for the length of the lock.
 *
 * Wrap the refresh with this and the second event inside `windowMs` is dropped.
 * Only wrap the resume handlers: a refresh triggered by something the user just
 * did must never be swallowed because it landed near a focus change.
 */
export function coalesceResume(refresh: () => void, windowMs = 400): () => void {
  let lastRun = 0;
  return () => {
    const now = Date.now();
    if (now - lastRun < windowMs) return;
    lastRun = now;
    refresh();
  };
}

/**
 * Poll `refresh` every `intervalMs`, but only while the window is visible.
 *
 * The timer is torn down on blur or hide and restarted on focus or show, so a
 * backgrounded window costs nothing, and the return from a lock refreshes once
 * rather than twice (both events fire, `coalesceResume` drops the second).
 * Every panel that refreshes on a timer wants exactly this, so it lives here
 * instead of being rebuilt per panel.
 *
 * `refresh` is read through a ref, so a caller may pass a fresh closure each
 * render without restarting the timer; each tick calls the newest one. Pass
 * `enabled: false` to stay mounted but idle (a collapsed panel, a tree with no
 * root yet). Anything a caller needs on mount, or on its own events, belongs in
 * that caller's own effect.
 */
export function useVisibilityPoll(refresh: () => void, intervalMs: number, enabled = true): void {
  const latest = useRef(refresh);
  latest.current = refresh;

  useEffect(() => {
    if (!enabled) return;
    let intervalId: number | null = null;
    const start = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        if (document.visibilityState === "visible") latest.current();
      }, intervalMs);
    };
    const stop = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    const refreshOnResume = coalesceResume(() => latest.current());
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshOnResume();
        start();
      } else {
        stop();
      }
    };
    const onFocus = () => {
      refreshOnResume();
      start();
    };

    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", stop);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", stop);
    };
  }, [enabled, intervalMs]);
}
