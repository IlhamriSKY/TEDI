import { Channel, invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { useVisibilityPoll } from "@/lib/windowResume";
import { forgetGitReads } from "./api";

/** The cadence every git view polled at before the watcher, and still the
 *  fastest any of them refreshes: a burst of changes costs at most what the
 *  poll did, never more. */
const POLL_MS = 2500;
/** With a watcher running the poll is only a safety net, for the one change a
 *  watcher can miss: a tracked file that also matches an ignore pattern,
 *  edited outside TEDI. Coming back to the window refreshes regardless. */
const SAFETY_MS = 30_000;

/** What a change can have moved; mirrors Rust `git::watch::RepoChange`. A
 *  refresh called WITHOUT one (the poll, a return to the window, arming) must
 *  assume everything moved. */
export type RepoChange = {
  /** `git status` may read differently. */
  tracked: boolean;
  /** The ignored list may read differently: an ignored path came or went. */
  ignored: boolean;
};

type Listener = (change: RepoChange) => void;
type Watch = { listeners: Set<Listener>; id: Promise<number | null> };

/** One host watcher per repository root, however many views are looking at it:
 *  the Explorer, a second Explorer, an extension's folder tree and Source
 *  Control all subscribe to the same root. */
const watches = new Map<string, Watch>();

/**
 * Hear about changes to the repository at `root` (its toplevel, as `git_status`
 * reports it). `active` resolves false when the host would not watch it - a
 * network path, a tree too big to watch on Linux, an older host - and the
 * caller should keep polling.
 */
export function watchRepo(
  root: string,
  onChange: Listener,
): { active: Promise<boolean>; dispose: () => void } {
  let watch = watches.get(root);
  if (!watch) {
    const listeners = new Set<Listener>();
    const channel = new Channel<RepoChange>();
    channel.onmessage = (change) => {
      // A read that started before this change must not be handed to the
      // refresh the change is about to trigger.
      forgetGitReads();
      for (const listener of [...listeners]) listener(change);
    };
    const id = invoke<number>("git_watch", { root, onChange: channel }).catch(() => null);
    watch = { listeners, id };
    watches.set(root, watch);
  }
  const entry = watch;
  entry.listeners.add(onChange);
  let disposed = false;
  return {
    active: entry.id.then((id) => id !== null),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      entry.listeners.delete(onChange);
      if (entry.listeners.size > 0 || watches.get(root) !== entry) return;
      watches.delete(root);
      void entry.id
        .then((id) => (id === null ? undefined : invoke("git_unwatch", { id })))
        .catch(() => {});
    },
  };
}

/**
 * Keep a local repository's git state fresh: on a change when the host can
 * watch `watchRoot`, on the old 2.5 s poll when it cannot or when there is no
 * repository to watch yet (so a `git init` is still noticed).
 *
 * The rules are the poll's rules, so nothing a user sees gets worse: nothing
 * runs while TEDI is not the window in use (coming back refreshes once), and
 * changes are throttled to one refresh per 2.5 s. What changes is the idle
 * case - an untouched working tree now costs no git process at all - and the
 * first change after a quiet spell, which refreshes ~250 ms after it lands
 * instead of whenever the next tick happened to fall.
 *
 * `refresh` receives what moved when a watcher says so, merged across every
 * change the throttle held back, and nothing when it runs for any other reason.
 */
export function useRepoRefresh(
  refresh: (change?: RepoChange) => void,
  watchRoot: string | null,
  enabled: boolean,
): void {
  const [watching, setWatching] = useState(false);
  const latest = useRef(refresh);
  latest.current = refresh;

  useVisibilityPoll(refresh, watching ? SAFETY_MS : POLL_MS, enabled);

  useEffect(() => {
    if (!enabled || !watchRoot) return;
    let cancelled = false;
    let last = 0;
    let timer: number | null = null;
    let held: RepoChange | null = null;
    const run = () => {
      timer = null;
      last = Date.now();
      const change = held;
      held = null;
      latest.current(change ?? undefined);
    };
    const watch = watchRepo(watchRoot, (change) => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      held = held
        ? { tracked: held.tracked || change.tracked, ignored: held.ignored || change.ignored }
        : change;
      if (timer === null) timer = window.setTimeout(run, Math.max(0, last + POLL_MS - Date.now()));
    });
    void watch.active.then((ok) => {
      if (cancelled) return;
      setWatching(ok);
      if (!ok) return;
      // A change between the fetch that revealed this root and the watcher
      // arming would otherwise wait out the safety poll. Refresh EVERYTHING:
      // whatever a message managed to hold before the arm resolved is a subset.
      if (timer !== null) window.clearTimeout(timer);
      held = null;
      run();
    });
    return () => {
      cancelled = true;
      watch.dispose();
      if (timer !== null) window.clearTimeout(timer);
      setWatching(false);
    };
  }, [watchRoot, enabled]);
}
