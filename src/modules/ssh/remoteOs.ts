/**
 * What OS is on the other end of an SSH session, for the status-bar OS pill.
 *
 * Read from `/etc/os-release` over the SFTP channel the session already has -
 * no exec channel, no new Rust command, one read per session. Cached by session
 * id, so switching panes costs nothing and a reconnect (which mints a fresh id)
 * re-probes.
 *
 * ponytail: os-release only. A remote macOS or Windows host has no such file
 * and falls back to the generic host glyph; probe SystemVersion.plist / the
 * Windows drive if that ever matters.
 */
import { useEffect, useState } from "react";
import type { OsBrandName } from "@/components/BrandIcon";

export type RemoteOs = {
  /** Logo to draw, or null when the host did not identify itself. */
  brand: OsBrandName | null;
  /** `PRETTY_NAME`, e.g. "Ubuntu 24.04.1 LTS". Names the pill in its tooltip. */
  label: string;
};

const UNKNOWN: RemoteOs = { brand: null, label: "Remote host" };

/** os-release `ID` (then `ID_LIKE`) to logo. Derivatives inherit their parent's
 *  mark rather than getting an entry each - Mint reads as Ubuntu, Rocky as Red
 *  Hat - and anything still unmatched is at least Linux, since the file itself
 *  says so. */
const BRAND_BY_ID: Record<string, OsBrandName> = {
  ubuntu: "ubuntu",
  debian: "debian",
  raspbian: "debian",
  arch: "arch",
  fedora: "fedora",
  alpine: "alpine",
  rhel: "redhat",
  centos: "redhat",
  opensuse: "opensuse",
  suse: "opensuse",
  freebsd: "freebsd",
};

/** Exported for `scripts/ssh/ssh-os-verify.ts`. */
export function parseOsRelease(text: string): RemoteOs {
  const kv = new Map<string, string>();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    kv.set(
      line.slice(0, eq).trim(),
      line
        .slice(eq + 1)
        .trim()
        .replace(/^"|"$/g, ""),
    );
  }
  const id = (kv.get("ID") ?? "").toLowerCase();
  // ID_LIKE is a space-separated list, closest ancestor first.
  const like = (kv.get("ID_LIKE") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const brand =
    BRAND_BY_ID[id] ?? like.map((l) => BRAND_BY_ID[l]).find(Boolean) ?? ("linux" as OsBrandName);
  const label = kv.get("PRETTY_NAME") || kv.get("NAME") || id || UNKNOWN.label;
  return { brand, label };
}

const resolved = new Map<number, RemoteOs>();
const inflight = new Map<number, Promise<RemoteOs>>();

export function readRemoteOs(sessionId: number): Promise<RemoteOs> {
  const done = resolved.get(sessionId);
  if (done) return Promise.resolve(done);
  const running = inflight.get(sessionId);
  if (running) return running;
  // Lazy import: the status bar is always mounted and must not pull the SFTP
  // module (and its transfer machinery) into the main bundle.
  const p = import("./sftp")
    .then(({ sftpReadFile }) => sftpReadFile(sessionId, "/etc/os-release"))
    .then(parseOsRelease)
    // A host with no os-release (macOS, Windows, a locked-down box) is not an
    // error worth retrying on every mount - cache the unknown too.
    .catch(() => UNKNOWN)
    .then((os) => {
      resolved.set(sessionId, os);
      inflight.delete(sessionId);
      return os;
    });
  inflight.set(sessionId, p);
  return p;
}

/** The remote OS of `sessionId`, or null while it is still being read (and for
 *  a local pane). Reads the cache synchronously on a session change so hopping
 *  between two remotes never shows the other host's logo. */
export function useRemoteOs(sessionId: number | null): RemoteOs | null {
  const [os, setOs] = useState<RemoteOs | null>(null);
  useEffect(() => {
    if (sessionId == null) {
      setOs(null);
      return;
    }
    setOs(resolved.get(sessionId) ?? null);
    let cancelled = false;
    void readRemoteOs(sessionId).then((r) => {
      if (!cancelled) setOs(r);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  return os;
}
