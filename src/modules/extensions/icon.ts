/**
 * Resolves `manifest.icon` (relative path) to a `data:` URL for `<img>`.
 * Reads bytes through Rust's `ext_read_asset_bytes` (base64) to avoid
 * widening the Tauri asset-protocol scope. 5 MiB cap enforced in Rust.
 * Cached by `${extId}:${relPath}` at module scope; cleared on page reload.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

function mimeForRelPath(rel: string): string {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".ico")) return "image/x-icon";
  // Fallback: let the browser sniff.
  return "application/octet-stream";
}

export async function loadExtensionIcon(
  extId: string,
  relPath: string,
): Promise<string | null> {
  const key = `${extId}:${relPath}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = (async () => {
    try {
      const b64 = await invoke<string>("ext_read_asset_bytes", {
        id: extId,
        relPath,
      });
      const url = `data:${mimeForRelPath(relPath)};base64,${b64}`;
      cache.set(key, url);
      return url;
    } catch (err) {
      console.warn(`[extensions] icon load failed for ${key}`, err);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, promise);
  return promise;
}

/** Evicts cache entries for one extension so reinstalls pick up new icons. */
export function evictExtensionIcon(extId: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${extId}:`)) cache.delete(key);
  }
}

/**
 * Resolves an extension `icon` string to a renderable URL. `null`/`undefined`
 * (and empty string) short-circuit to `null`; a `data:` URL passes through;
 * anything else is loaded via `loadExtensionIcon` relative to the extension's
 * install root, with an `alive` guard so a resolved-after-unmount promise is
 * ignored. Shared by the header, status-bar, sidebar-section, and right-panel
 * icon renderers.
 */
export function useResolvedExtensionIcon(
  extensionId: string,
  icon: string | null | undefined,
): string | null {
  const [url, setUrl] = useState<string | null>(() =>
    icon && icon.startsWith("data:") ? icon : null,
  );
  useEffect(() => {
    if (!icon) {
      setUrl(null);
      return;
    }
    if (icon.startsWith("data:")) {
      setUrl(icon);
      return;
    }
    let alive = true;
    void loadExtensionIcon(extensionId, icon).then((next) => {
      if (alive) setUrl(next);
    });
    return () => {
      alive = false;
    };
  }, [extensionId, icon]);
  return url;
}
