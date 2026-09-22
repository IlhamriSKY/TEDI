import { Channel, invoke } from "@tauri-apps/api/core";

/** Mirrors Rust `fs::watch::FsChange`. */
export type FsChange = {
  /** Parent directories that may list differently, forward-slash and deduped. */
  dirs: string[];
  /** Too much moved to name: re-read every loaded directory. */
  rescan: boolean;
};

type Listener = (change: FsChange) => void;
type Watch = { listeners: Set<Listener>; id: Promise<number | null> };

/** One host watcher per root, however many trees are looking at it: the
 *  Explorer, a second Explorer, an extension's folder tree. */
const watches = new Map<string, Watch>();

/**
 * Hear about changes under `root`. `active` resolves false when the host would
 * not watch it - a network path, a tree past the platform's watch budget, an
 * older host - and the caller should keep polling.
 */
export function watchTree(
  root: string,
  onChange: Listener,
): { active: Promise<boolean>; dispose: () => void } {
  let watch = watches.get(root);
  if (!watch) {
    const listeners = new Set<Listener>();
    const channel = new Channel<FsChange>();
    channel.onmessage = (change) => {
      for (const listener of [...listeners]) listener(change);
    };
    const id = invoke<number>("fs_watch", { root, onChange: channel }).catch(() => null);
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
        .then((id) => (id === null ? undefined : invoke("fs_unwatch", { id })))
        .catch(() => {});
    },
  };
}
