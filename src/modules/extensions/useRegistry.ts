/**
 * `useSyncExternalStore` wrapper for the contribution registries so
 * React components stay in sync without prop-drilling. Registries live
 * outside React (see `registries.ts`); this hook is the bridge.
 */
import { useSyncExternalStore } from "react";

type ListEntry<T> = { extensionId: string; item: T };

type RegistryLike<T> = {
  subscribe(listener: () => void): () => void;
  list(): ListEntry<T>[];
};

export function useRegistry<T>(reg: RegistryLike<T>): ListEntry<T>[] {
  return useSyncExternalStore(
    (l) => reg.subscribe(l),
    () => reg.list(),
    () => reg.list(),
  );
}
