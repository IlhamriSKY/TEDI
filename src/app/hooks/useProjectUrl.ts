import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import { joinPath, parentDir, tryReadText } from "@/modules/editor/lib/formatters/configWalk";
import {
  PROJECT_URL_FILES,
  parseHostsFile,
  urlFromConfig,
  type LocalHosts,
} from "@/modules/browser/lib/projectUrl";
import { IS_WINDOWS } from "@/lib/platform";

/**
 * IO half of `browser/lib/projectUrl`: on workspace-root change, walk up for a
 * config naming the project's url, then probe that one port. A hit lights the
 * same pill a terminal-printed url does, so a server TEDI never saw start
 * (Laragon's Apache, a container) stops being invisible.
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
  let dir: string | null = startDir.replace(/\\/g, "/").replace(/\/+$/, "");
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
      if (!url) {
        cb.current(null);
        return;
      }
      const up = await isUp(url);
      if (alive) cb.current(up ? url : null);
    })();
    return () => {
      alive = false;
    };
  }, [root]);
}
