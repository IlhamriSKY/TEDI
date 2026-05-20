/**
 * Read/write helpers for extension-namespaced settings (`ext:<id>:<key>`).
 * Built-in TEDI code uses these to render contributed setting forms in
 * the Extensions tab. Extension JS uses the matching `tedi.settings.*`
 * surface in [host.ts](./host.ts); both go through the same store keys.
 */
import { useEffect, useState } from "react";
import { _onAnyChange, _readAny, _writeAny } from "@/modules/settings/store";
import type { ContributedSetting } from "./manifest";

function nsKey(extId: string, key: string): string {
  return `ext:${extId}:${key}`;
}

/**
 * Subscribe to an extension setting, returning `[value, setValue]` with
 * the typed default from the manifest applied on first hydration. The
 * write goes through the same namespaced store key the extension uses
 * via `tedi.settings.set`.
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
