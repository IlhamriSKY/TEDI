import { cn } from "@/lib/utils";
import { useEffect, useMemo, useRef, useState } from "react";
import { previewResolveFavicon } from "./lib/native";
import { Globe } from "lucide-react";

// Resolved favicon URL per origin (null = the site declares no icon -> globe).
// Cached so a site is parsed once per session no matter how many tabs/panes
// show it, and so the icon is instant when revisited.
const faviconCache = new Map<string, string | null>();
const faviconInflight = new Map<string, Promise<string | null>>();

function resolveOriginFavicon(pageUrl: string, origin: string): Promise<string | null> {
  if (faviconCache.has(origin)) return Promise.resolve(faviconCache.get(origin) ?? null);
  let inflight = faviconInflight.get(origin);
  if (!inflight) {
    inflight = previewResolveFavicon(pageUrl)
      .catch(() => null)
      .then((resolved) => {
        faviconCache.set(origin, resolved);
        faviconInflight.delete(origin);
        return resolved;
      });
    faviconInflight.set(origin, inflight);
  }
  return inflight;
}

/**
 * Website favicon for a browser leaf. Shared by the tab strip (EntryIcon) and
 * the per-pane header / drag overlay (PaneTreeView) so a browser pane shows the
 * same icon everywhere it appears.
 *
 * Probes `<origin>/favicon.ico` first (instant, and correct for the many sites
 * that serve it). When that 404s, it escalates to {@link previewResolveFavicon}
 * which parses the page's declared `<link rel="icon">` - covering sites whose
 * icon lives at a custom/hashed path. Falls back to the globe glyph when no
 * icon can be found or the URL is blank/unparseable.
 */
export function BrowserFavicon({
  url,
  size = 14,
  className,
}: {
  url: string;
  size?: number;
  className?: string;
}) {
  const origin = useMemo(() => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }, [url]);
  const originRef = useRef(origin);
  originRef.current = origin;
  const [src, setSrc] = useState<string | null>(null);
  // Whether we've already escalated past the optimistic /favicon.ico probe, so
  // a subsequent image error drops straight to the globe instead of looping.
  const escalated = useRef(false);

  useEffect(() => {
    escalated.current = false;
    if (!origin) {
      setSrc(null);
      return;
    }
    const cached = faviconCache.get(origin);
    if (cached !== undefined) {
      // Already resolved this origin (custom URL or null): use it, skip probing.
      escalated.current = true;
      setSrc(cached);
    } else {
      setSrc(`${origin}/favicon.ico`);
    }
  }, [origin]);

  const handleError = () => {
    if (!origin || escalated.current) {
      setSrc(null); // give up -> globe
      return;
    }
    escalated.current = true;
    void resolveOriginFavicon(url, origin).then((resolved) => {
      // Ignore a late resolve if the pane has since navigated to another origin.
      if (originRef.current === origin) setSrc(resolved);
    });
  };

  if (!src) {
    return <Globe size={size} strokeWidth={2} className={cn("shrink-0", className)} />;
  }
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={cn("shrink-0 rounded-sm object-contain", className)}
      onError={handleError}
    />
  );
}
