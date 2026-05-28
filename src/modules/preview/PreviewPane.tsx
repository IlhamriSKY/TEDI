import { AlertCircleIcon, Globe02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { isLocalUrl, isSelfReferenceUrl, resolveIframeSrc, SELF_REFERENCE_NOTICE } from "./lib/proxy";
import { PreviewAddressBar, type PreviewAddressBarHandle } from "./PreviewAddressBar";

export type PreviewPaneHandle = {
  reload: () => void;
  focusAddressBar: () => void;
  getUrl: () => string;
};

type Props = {
  url: string;
  visible: boolean;
  onUrlChange: (url: string) => void;
  ref?: Ref<PreviewPaneHandle>;
};

export function PreviewPane({ url, visible, onUrlChange, ref }: Props) {
  // `nonce` is part of the iframe `key`. Bumping it remounts the iframe,
  // which is the only reliable cross-origin reload (calling
  // contentWindow.location.reload() throws on cross-origin frames).
  const [nonce, setNonce] = useState(0);
  const [bypassProxy, setBypassProxy] = useState(false);
  const addressRef = useRef<PreviewAddressBarHandle>(null);

  useImperativeHandle(
    ref,
    () => ({
      reload: () => setNonce((n) => n + 1),
      focusAddressBar: () => addressRef.current?.focus(),
      getUrl: () => url,
    }),
    [url],
  );

  const isLocal = url ? isLocalUrl(url) : true;
  const selfBlocked = url ? isSelfReferenceUrl(url) : false;
  const proxied = !isLocal && !bypassProxy;
  const iframeSrc = useMemo(
    () => (url && !selfBlocked ? resolveIframeSrc(url, { bypassProxy }) : ""),
    [url, bypassProxy, selfBlocked],
  );

  return (
    <div
      className="border-border/60 bg-background flex h-full w-full flex-col overflow-hidden rounded-md border"
      style={{
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      <PreviewAddressBar
        ref={addressRef}
        url={url}
        proxied={proxied}
        canProxy={!isLocal}
        onSubmit={(next) => {
          setBypassProxy(false);
          onUrlChange(next);
        }}
        onReload={() => setNonce((n) => n + 1)}
        onToggleProxy={() => {
          setBypassProxy((v) => !v);
          setNonce((n) => n + 1);
        }}
      />
      <div
        className={
          url && !selfBlocked
            ? "relative min-h-0 flex-1 bg-background"
            : "bg-background relative min-h-0 flex-1"
        }
      >
        {!url ? (
          <EmptyState />
        ) : selfBlocked ? (
          <SelfBlockedState />
        ) : (
          <iframe
            key={`${iframeSrc}#${nonce}`}
            src={iframeSrc}
            title="Preview"
            className="h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="border-border/60 bg-card text-muted-foreground flex size-12 items-center justify-center rounded-2xl border">
        <HugeiconsIcon icon={Globe02Icon} size={20} strokeWidth={1.5} />
      </div>
      <div className="space-y-1.5">
        <p className="text-foreground text-sm font-medium">Nothing to preview yet</p>
        <p className="text-muted-foreground max-w-sm text-xs leading-relaxed">
          Type a URL above, or open the{" "}
          <span className="bg-muted rounded px-1 py-0.5 font-mono text-[10.5px]">Ports</span>{" "}
          dropdown to jump straight to your running dev server. Public sites are routed through
          TEDI's strip-XFO proxy so they render inline - toggle it off with the shield button if a
          site looks broken.
        </p>
      </div>
    </div>
  );
}

function SelfBlockedState() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl border border-icon-working/30 bg-icon-working/10 text-icon-working">
        <HugeiconsIcon icon={AlertCircleIcon} size={20} strokeWidth={1.5} />
      </div>
      <div className="space-y-1.5">
        <p className="text-foreground text-sm font-medium">Preview blocked</p>
        <p className="text-muted-foreground max-w-sm text-xs leading-relaxed">
          {SELF_REFERENCE_NOTICE} Pick a different URL or use the{" "}
          <span className="bg-muted rounded px-1 py-0.5 font-mono text-[10.5px]">Ports</span>{" "}
          dropdown to find your dev server.
        </p>
      </div>
    </div>
  );
}
