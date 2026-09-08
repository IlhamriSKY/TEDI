/**
 * Turning a contributed `icon` string into something renderable.
 * {@link useExtensionIcon} is the entry point every surface uses; the rest of
 * this file is the asset half it delegates to.
 *
 * An asset path is read through Rust's `ext_read_asset_bytes` (base64) rather
 * than the Tauri asset protocol, which would have to be widened. 5 MiB cap
 * enforced in Rust; cached at module scope by `${extId}:${relPath}`.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isIconNameRef, resolveExtIcon, useIconsReady, type LucideIcon } from "@/lib/iconRegistry";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | null>>();

/** MIME type for an extension asset path, for building its `data:` URL. */
export function mimeForRelPath(rel: string): string {
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

export async function loadExtensionIcon(extId: string, relPath: string): Promise<string | null> {
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
 * ignored. Prefer {@link useExtensionIcon}, which also covers `lucide:` names.
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

/** One resolved extension icon: a Lucide component, or an asset URL. */
export type ExtensionIconSource = {
  /** Set when `icon` was a `lucide:`/`hugeicon:` name and the chunk has landed. */
  Icon: LucideIcon | null;
  /** Set when `icon` was an asset path or `data:` URL. */
  url: string | null;
  /** `url` is an SVG, so render it as a CSS mask to pick up `color`; a raster
   *  `<img>` ignores the parent's color and has to be tinted with opacity. */
  isSvg: boolean;
};

/**
 * The one way to turn a contributed `icon` string into something renderable.
 * Every surface that draws an extension icon (header, status bar, sidebar,
 * right-panel toggle) resolves it here so they all accept the same forms, and
 * an extension can pick a `lucide:` glyph anywhere instead of the host holding
 * a per-extension override table for the surfaces that lagged.
 *
 * Callers keep their own markup: the three surfaces size, tint and animate the
 * glyph differently, and only the RESOLUTION is common.
 */
export function useExtensionIcon(
  extensionId: string,
  icon: string | null | undefined,
): ExtensionIconSource {
  useIconsReady(); // re-render once the lazy lucide chunk lands
  const Icon = resolveExtIcon(icon);
  // Gate the asset loader on the REF, not on `Icon`: until the lucide chunk
  // lands `resolveExtIcon` answers null for a perfectly good `lucide:` name,
  // and loading that as a relative path fails and warns on every launch.
  const url = useResolvedExtensionIcon(extensionId, isIconNameRef(icon) ? "" : icon);
  return {
    Icon,
    url,
    isSvg: url !== null && (url.startsWith("data:image/svg+xml") || url.endsWith(".svg")),
  };
}
