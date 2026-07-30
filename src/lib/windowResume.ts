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
