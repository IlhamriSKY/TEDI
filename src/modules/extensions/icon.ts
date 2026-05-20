/**
 * Resolve `manifest.icon` (a relative path inside the extension folder)
 * to a `data:` URL the renderer can drop straight into an `<img>` tag.
 *
 * Round-trips bytes through Rust's `ext_read_asset_bytes` (base64) instead
 * of `convertFileSrc`, so we don't need to widen the Tauri asset-protocol
 * scope to include `<app_data_dir>/extensions/**` (one less attack
 * surface). 5 MiB cap is enforced on the Rust side.
 *
 * Cached by `${extId}:${relPath}` so re-renders don't re-fetch. The
 * cache lives at module scope - cleared implicitly when the page reloads.
 */
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
  // Fallback: let the browser sniff. Most renderers tolerate a generic
  // `image/*` data URL.
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

/** Drop a single entry - used by reload/uninstall flows so a re-installed
 *  extension picks up its new icon. */
export function evictExtensionIcon(extId: string): void {
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${extId}:`)) cache.delete(key);
  }
}
