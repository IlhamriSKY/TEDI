import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { joinPath, toForwardSlash } from "@/lib/path";
import { useVisibilityPoll } from "@/lib/windowResume";
import { parentDir, tryReadText } from "@/modules/editor/lib/formatters/configWalk";
import {
  PROJECT_URL_FILES,
  parseHostsFile,
  urlFromConfig,
  type LocalHosts,
} from "@/modules/browser/lib/projectUrl";
import { IS_WINDOWS } from "@/lib/platform";

/**
 * IO half of `browser/lib/projectUrl`: on workspace-root change, walk up for a
 * config naming the project's url. It feeds the same pill a terminal-printed url
 * does, so a server TEDI never saw start (Laragon's Apache, a container) stops
 * being invisible.
 *
 * Also home to `useLiveUrl`, the one place that decides whether ANY candidate
 * url is actually answering. It lives here because it is this file's `isUp` /
 * `port_is_open` probe generalised from "once per root" to "on a timer".
 */

/** Deep enough for `src/modules/x`, shallow enough not to reach the drive root. */
const MAX_WALK = 4;

/**
 * Per DIRECTORY, for the session - `explorerRoot` follows the focused terminal
 * so it changes on every `cd`, and keying by directory lets a walk reuse what
 * earlier walks learned about the parents.
 *
 * Trade: editing `APP_URL` needs a restart. Fine, the pill is a shortcut.
 */
const dirCache = new Map<string, Promise<string | null>>();

const HOSTS_PATH = IS_WINDOWS ? "C:/Windows/System32/drivers/etc/hosts" : "/etc/hosts";

/**
 * Read once per session. Needed because Laragon's default TLD is the
 * registrable `.dev`, so only a hosts entry separates `myapp.dev` from a real
 * site. An unreadable file degrades to an empty set, not an error.
 */
let hostsPromise: Promise<LocalHosts> | null = null;

function localHosts(): Promise<LocalHosts> {
  hostsPromise ??= tryReadText(HOSTS_PATH).then((text) =>
    text === null ? new Set<string>() : parseHostsFile(text),
  );
  return hostsPromise;
}

/** The url declared by config in `dir` itself, or null. */
function urlInDir(dir: string, hosts: LocalHosts): Promise<string | null> {
  let hit = dirCache.get(dir);
  if (!hit) {
    hit = (async () => {
      // One wave per directory, not one round trip per candidate: a directory
      // with none of them (the common case) costs one wait, not four.
      const texts = await Promise.all(
        PROJECT_URL_FILES.map((name) => tryReadText(joinPath(dir, name))),
      );
      for (let i = 0; i < texts.length; i++) {
        const text = texts[i];
        if (text === null) continue;
        const url = urlFromConfig(PROJECT_URL_FILES[i], text, hosts);
        if (url) return url;
      }
      return null;
    })();
    dirCache.set(dir, hit);
  }
  return hit;
}

/** First url found walking up from `startDir`, or null within `MAX_WALK`. */
async function findConfigUrl(startDir: string): Promise<string | null> {
  const hosts = await localHosts();
  let dir: string | null = toForwardSlash(startDir).replace(/\/+$/, "");
  for (let i = 0; i < MAX_WALK && dir; i++) {
    const url = await urlInDir(dir, hosts);
    if (url) return url;
    const next = parentDir(dir);
    if (next === dir) break;
    dir = next;
  }
  return null;
}

/**
 * A TCP connect, not `http_ping`: a Laragon vhost's self-signed HTTPS cert is
 * refused by the host's rustls client, so an HTTP probe calls a live server
 * dead. Non-loopback is also refused, so an error is a "no" either way.
 */
async function isUp(url: string): Promise<boolean> {
  try {
    return await invoke<boolean>("port_is_open", { url });
  } catch {
    return false;
  }
}

/** Matches the file tree's poll. Fast enough to notice a server you just
 *  started, slow enough to be invisible next to the git status poll, which
 *  spawns three CHILD PROCESSES every 2500ms while the window is visible. */
const PROBE_MS = 4000;
/** Consecutive all-dead rounds before the url is dropped. TWO, not one: vite /
 *  nodemon / artisan leave a 1-3s hole on a hot restart, and one strike blinks
 *  the pill off every single time. The price is ~8s of offering a stopped
 *  server. */
const DEAD_STRIKES = 2;

/**
 * The first url in `urls` that something is actually listening on, or null when
 * none of them answer. Ordered: `urls` is a priority list, so a live leader
 * wins and a dead one falls through to the next candidate.
 *
 * Three invariants, because they ARE the design:
 *  1. OPTIMISTIC before the first probe resolves. A url a terminal printed a
 *     second ago is shown immediately; the probe only takes it away.
 *  2. It never writes back to whoever produced `urls`. A server that restarts on
 *     the same port therefore returns on the next tick with no reprint, no
 *     re-detection and no leaf event.
 *  3. Which is why the interval must KEEP RUNNING while everything reads dead.
 *     Stopping on dead would make (2) impossible.
 *
 * ponytail: probes sequentially. `urls` is 1-3 entries and a dead loopback port
 * refuses instantly; parallelise only if this ever shows up in a profile.
 * ponytail: a url nothing will ever answer (a `cat`ed README naming
 * localhost:3000) is re-probed every PROBE_MS for as long as the window is
 * visible. Back off after N dead rounds if that ever matters.
 */
export function useLiveUrl(urls: string[]): string | null {
  const [live, setLive] = useState<string | null>(null);
  // Read inside the probe so a candidate change does not have to tear the timer
  // down; `key` below is what actually restarts the effect.
  const urlsRef = useRef(urls);
  urlsRef.current = urls;
  // The joined string, NOT the array: the caller's memo recomputes on every
  // `tabs` change (any leaf added, closed or focused), and depending on the
  // array identity would restart the poll each time.
  const key = urls.join("|");

  const strikes = useRef(0);
  // Load-bearing, not decorative: `port_is_open`'s DNS half is an untimed
  // `spawn_blocking(to_socket_addrs)` (only the connect gets the 600ms timeout),
  // so an unresolvable `.test` vhost can outlast the interval.
  const inFlight = useRef(false);
  // Bumped whenever the candidate list changes, so a probe that resolves after
  // the switch cannot publish a url from the list it started against.
  const generation = useRef(0);

  const probe = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = generation.current;
    try {
      for (const url of urlsRef.current) {
        const up = await isUp(url);
        if (generation.current !== mine) return;
        if (up) {
          strikes.current = 0;
          setLive(url);
          return;
        }
      }
      strikes.current++;
      if (strikes.current >= DEAD_STRIKES) setLive(null);
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    generation.current++;
    strikes.current = 0;
    const list = urlsRef.current;
    if (list.length === 0) {
      setLive(null);
      return;
    }
    // Invariant 1. Keeping a still-valid pick stops an unrelated list change
    // from blinking the pill.
    setLive((prev) => (prev && list.includes(prev) ? prev : list[0]));
    void probe();
  }, [key, probe]);

  // Same visible-only timer + resume coalescing as the git / file-tree polls.
  useVisibilityPoll(() => void probe(), PROBE_MS, urls.length > 0);

  return live;
}

/**
 * Reports the project's url (or null) to `onDetect`, once per workspace root.
 * `onDetect` may be a fresh closure each render without re-running the walk.
 */
export function useProjectUrl(root: string | null, onDetect: (url: string | null) => void): void {
  const cb = useRef(onDetect);
  cb.current = onDetect;

  useEffect(() => {
    if (!root) {
      cb.current(null);
      return;
    }
    let alive = true;
    void (async () => {
      const url = await findConfigUrl(root);
      // No interim clear, so `cd` into a subdirectory does not blink the pill.
      if (!alive) return;
      // Reported whether or not it answers. Liveness is `useLiveUrl`'s job now:
      // probing here fires only on an `explorerRoot` change, so a server started
      // after the user stopped navigating could never enter the candidate list
      // and nothing would ever discover it.
      if (alive) cb.current(url);
    })();
    return () => {
      alive = false;
    };
  }, [root]);
}
