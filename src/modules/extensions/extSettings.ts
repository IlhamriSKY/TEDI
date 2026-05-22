/**
 * Read/write helpers for extension-namespaced settings (`ext:<id>:<key>`).
 * Used by the Extensions tab UI; extension JS hits the same store keys via
 * `tedi.settings.*` in host.ts.
 */
import { useEffect, useState } from "react";
import { _onAnyChange, _readAny, _writeAny } from "@/modules/settings/store";
import type { ContributedSetting } from "./manifest";

function nsKey(extId: string, key: string): string {
  return `ext:${extId}:${key}`;
}

/**
 * Subscribes to an extension setting. Returns `[value, setValue]` with the
 * manifest default applied on first hydration. Writes go through the same
 * namespaced key as `tedi.settings.set`.
 */
export function useExtSetting<T = unknown>(
  extId: string,
  def: ContributedSetting,
): [T | undefined, (next: T) => Promise<void>] {
  const [value, setValue] = useState<T | undefined>(() => def.default as T | undefined);
  const k = nsKey(extId, def.id);

  useEffect(() => {
    let alive = true;
    void _readAny<T>(k).then((v) => {
      if (!alive) return;
      setValue(v ?? (def.default as T | undefined));
    });
    let unsub: (() => void) | null = null;
    void _onAnyChange((changed, newValue) => {
      if (changed !== k) return;
      setValue((newValue ?? def.default) as T | undefined);
    }).then((fn) => {
      if (!alive) {
        fn();
        return;
      }
      unsub = fn;
    });
    return () => {
      alive = false;
      unsub?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [k]);

  const write = async (next: T): Promise<void> => {
    await _writeAny(nsKey(extId, def.id), next);
  };
  return [value, write];
}
