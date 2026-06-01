import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { buildProxyUrl } from "@/modules/preview/lib/proxy";

export type MarketplaceItem = {
  /** Catalog id, e.g. `discord-rich-presence`. Not the installed manifest id
   *  (which is publisher-prefixed like `tedi.discord-rich-presence`). Kept
   *  only for React keys + telemetry; dedup against installed uses the repo
   *  slug, which both sides reliably agree on. */
  id: string;
  name: string;
  /** Normalized `owner/repo`. Used both for install (backend accepts it
   *  directly) and for dedup against installed `source = github:owner/repo`. */
  repoSlug: string;
  /** Original URL from the catalog, displayed in the card. */
  repository: string;
  description?: string;
  icon?: string;
  publisher?: string;
  version?: string;
  license?: string;
  /** `"official"` items render first and get a small badge; `"unofficial"`
   *  items render after with no badge. */
  channel: "official" | "unofficial";
};

export type MarketplaceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; items: MarketplaceItem[] }
  | { status: "error"; message: string };

/** Body of the Marketplace tab. Receives derived state from the parent so it
 *  has no network logic of its own; install routes through the same review
 *  pipeline as the From-GitHub tab to keep the manifest dialog as the single
 *  security boundary. */
export function MarketplacePanel({
  state,
  items,
  onRefresh,
  onInstall,
}: {
  state: MarketplaceState;
  items: MarketplaceItem[];
  onRefresh: () => void;
  onInstall: (item: MarketplaceItem) => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground flex-1 text-[11px]">
          Browse the official catalog at <code>tedi.ilhamriski.com/extensions/</code>. Items already
          installed (matched by GitHub repo) are hidden. Install opens the same manifest review
          dialog as the GitHub tab.
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2.5 text-[11px]"
          disabled={state.status === "loading"}
          onClick={onRefresh}
        >
          {state.status === "loading" ? "Loading…" : "Refresh"}
        </Button>
      </div>

      {state.status === "loading" ? (
        <div className="text-muted-foreground flex items-center gap-2 text-[11px]">
          <Spinner className="size-3" /> Loading marketplace…
        </div>
      ) : state.status === "error" ? (
        <div className="text-destructive text-[11px]">
          Could not load marketplace: {state.message}
        </div>
      ) : state.status === "ready" ? (
        items.length === 0 ? (
          <span className="text-muted-foreground text-[11px]">
            All marketplace extensions are already installed.
          </span>
        ) : (
          <div className="flex flex-col gap-1.5">
            {items.map((item) => (
              <MarketplaceCard key={item.id} item={item} onInstall={() => onInstall(item)} />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}

/** Single marketplace row. Remote icon falls back to a letter avatar if the
 *  URL 404s or violates CORS for an image load, mirroring `ExtensionIcon`.
 *  Channel badge (Official / Unofficial) makes provenance obvious before the
 *  user clicks Install. */
function MarketplaceCard({ item, onInstall }: { item: MarketplaceItem; onInstall: () => void }) {
  const [iconBroken, setIconBroken] = useState(false);
  // Route remote icons through the existing `tedi-frame://` proxy. The
  // catalog server (tedi.ilhamriski.com) ships `Cross-Origin-Resource-Policy:
  // same-site`, which blocks the webview's cross-origin `<img>` load. The
  // proxy strips that header (see `STRIPPED_HEADERS` in preview.rs), so the
  // PNG arrives at the webview origin and renders. `data:` / `blob:` URLs
  // are passed through untouched.
  const iconSrc = useMemo(() => {
    if (!item.icon) return null;
    const lower = item.icon.toLowerCase();
    if (lower.startsWith("http://") || lower.startsWith("https://")) {
      try {
        return buildProxyUrl(item.icon);
      } catch {
        return item.icon;
      }
    }
    return item.icon;
  }, [item.icon]);
  const showImg = !!iconSrc && !iconBroken;
  const letter = item.name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="border-border/60 bg-card/60 flex items-start gap-3 rounded-md border px-2.5 py-2">
      {showImg ? (
        <img
          src={iconSrc}
          alt=""
          className="border-border/40 size-8 shrink-0 rounded-md border object-cover"
          loading="lazy"
          draggable={false}
          onError={() => setIconBroken(true)}
        />
      ) : (
        <div
          aria-hidden
          className="bg-muted text-muted-foreground border-border/40 flex size-8 shrink-0 items-center justify-center rounded-md border text-[12px] font-semibold"
        >
          {letter}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12px] font-medium">{item.name}</span>
          {item.version ? (
            <Badge variant="secondary" className="h-4 px-1.5 font-mono text-[9.5px]">
              v{item.version}
            </Badge>
          ) : null}
          {item.channel === "official" ? (
            <Badge
              variant="outline"
              className="border-diff-added/50 bg-diff-added/10 text-diff-added h-4 px-1.5 text-[9.5px] tracking-wide uppercase"
            >
              Official
            </Badge>
          ) : null}
        </div>
        {item.description ? (
          <span className="text-muted-foreground text-[10.5px] leading-snug">
            {item.description}
          </span>
        ) : null}
        <span className="text-muted-foreground/70 text-[10px] break-all">
          {item.publisher ? `${item.publisher} · ` : ""}
          {item.repoSlug}
          {item.license ? ` · ${item.license}` : ""}
        </span>
      </div>
      <Button size="sm" variant="outline" className="h-7 px-2.5 text-[11px]" onClick={onInstall}>
        Install
      </Button>
    </div>
  );
}
