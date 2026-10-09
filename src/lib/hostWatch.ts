import { Channel, invoke } from "@tauri-apps/api/core";

export type HostWatch = { active: Promise<boolean>; dispose: () => void };

type Listener<T> = (change: T) => void;
type Shared<T> = { listeners: Set<Listener<T>>; id: Promise<number | null> };

/**
 * A subscriber to a host watch command pair (`fs_watch`/`fs_unwatch`,
 * `git_watch`/`git_unwatch`). However many views watch one root, the host runs
 * one watcher for it, released when the last view disposes. `active` resolves
 * false when the host would not watch the root (a network path, a tree past the
 * platform's watch budget, an older host) and the caller should keep polling.
 * `beforeDispatch` runs once per change, before any listener.
 */
export function createHostWatch<T>(
  watchCmd: string,
  unwatchCmd: string,
  beforeDispatch?: () => void,
): (root: string, onChange: Listener<T>) => HostWatch {
  const watches = new Map<string, Shared<T>>();
  return (root, onChange) => {
    let watch = watches.get(root);
    if (!watch) {
      const listeners = new Set<Listener<T>>();
      const channel = new Channel<T>();
      channel.onmessage = (change) => {
        beforeDispatch?.();
        for (const listener of [...listeners]) listener(change);
      };
      const id = invoke<number>(watchCmd, { root, onChange: channel }).catch(() => null);
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
          .then((id) => (id === null ? undefined : invoke(unwatchCmd, { id })))
          .catch(() => {});
      },
    };
  };
}
