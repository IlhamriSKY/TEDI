/**
 * `useSyncExternalStore` wrapper for contribution registries. Bridges
 * the registries in `registries.ts` to React components.
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
