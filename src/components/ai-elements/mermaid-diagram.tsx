"use client";

import { useEffect, useId, useState } from "react";

import { useTheme } from "@/modules/theme/ThemeProvider";
import { Shimmer } from "./shimmer";
import { useIsStreaming } from "./chat-code";

/**
 * Lazily-loaded, cached mermaid module. Mermaid is heavy (pulls in dagre,
 * cytoscape, …), so keep it out of the initial bundle and only pull the
 * chunk when a diagram actually needs to render.
 */
let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => m.default);
  }
  return mermaidPromise;
}

function Notice({ children }: { children: string }) {
  return (
    <div className="not-prose border-border/50 bg-muted/30 text-muted-foreground my-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px]">
      <span className="bg-muted-foreground/60 inline-block size-1.5 animate-pulse rounded-full" />
      <Shimmer duration={1.2}>{children}</Shimmer>
    </div>
  );
}

/**
 * Renders a fenced ```mermaid block as an SVG diagram. Used for both AI chat
 * output and the editor's markdown file preview, so the source is untrusted:
 * mermaid runs with `securityLevel: "strict"` (labels escaped, no scripts or
 * click handlers) and the SVG it returns is already sanitized, which is what
 * makes the `dangerouslySetInnerHTML` injection below safe.
 */
export function MermaidDiagram({ code }: { code: string }) {
  const streaming = useIsStreaming();
  const { resolvedTheme } = useTheme();
  // React's useId yields colons; strip them so the id is a valid CSS selector
  // for mermaid's internal querySelector.
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Don't try to parse a half-streamed diagram: it would just error and
    // flash the fallback until the block completes.
    if (streaming || !code.trim()) return;
    let cancelled = false;
    setFailed(false);

    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: resolvedTheme === "dark" ? "dark" : "default",
          fontFamily: "inherit",
        });
        const { svg: out } = await mermaid.render(id, code);
        if (!cancelled) setSvg(out);
      })
      .catch(() => {
        if (cancelled) return;
        setSvg(null);
        setFailed(true);
        // A failed render can leave mermaid's temporary measuring nodes behind.
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      });

    return () => {
      cancelled = true;
    };
  }, [code, resolvedTheme, streaming, id]);

  if (streaming) return <Notice>Generating diagram…</Notice>;

  if (failed) {
    // Invalid/unsupported diagram: fall back to the raw source so nothing is lost.
    return (
      <div className="not-prose border-border/50 bg-muted/30 my-2 overflow-hidden rounded-lg border">
        <div className="border-border/40 bg-muted/20 text-muted-foreground border-b px-3 py-1 font-mono text-[10px] tracking-wide uppercase">
          mermaid
        </div>
        <pre className="text-foreground m-0 overflow-x-auto px-3 py-2.5 font-mono text-[11.5px] leading-relaxed">
          {code}
        </pre>
      </div>
    );
  }

  if (!svg) return <Notice>Rendering diagram…</Notice>;

  return (
    <div
      className="not-prose border-border/50 bg-muted/20 my-2 flex justify-center overflow-x-auto rounded-lg border p-3 [&_svg]:h-auto [&_svg]:max-w-full"
      // Safe: SVG is produced by mermaid in strict mode (sanitized, no scripts).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
