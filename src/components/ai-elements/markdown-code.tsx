"use client";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { extractTableDataFromElement, tableDataToMarkdown } from "streamdown";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { ChatCodeBlock } from "./chat-code";
import { MermaidDiagram } from "./mermaid-diagram";

/**
 * Streamdown `components.code` override. Handles both inline (`code`) and
 * fenced blocks (className "language-X"). `mermaid` blocks render as a
 * diagram; other fenced blocks delegate to the Lezer-based syntax
 * highlighter; inline stays a plain pill.
 */
export function MarkdownCode({
  className,
  children,
  ...rest
}: {
  className?: string;
  children?: ReactNode;
}) {
  const match = className?.match(/language-(\w+)/);
  if (!match) {
    return (
      <code
        className="bg-muted/70 text-foreground rounded px-1.5 py-0.5 font-mono text-[11px]"
        {...rest}
      >
        {children}
      </code>
    );
  }

  const lang = match[1] ?? null;
  const code = String(children ?? "").replace(/\n$/, "");
  if (lang?.toLowerCase() === "mermaid") {
    return <MermaidDiagram code={code} />;
  }
  return <ChatCodeBlock code={code} lang={lang} />;
}

/**
 * Streamdown `components.table` override. Keeps Streamdown's own cell renderers
 * (so the table looks identical to before) but swaps its native-`title` copy
 * control for a hover-revealed button using the host `Tooltip` - so the tooltip
 * matches the rest of the app (and the code-block controls) instead of the
 * browser's plain title bubble. Streamdown's built-in table controls are
 * disabled at the `<Streamdown controls={{ table: false }}>` call site.
 */
export function MarkdownTable({ children, ...props }: ComponentProps<"table">) {
  const ref = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);
  const tRef = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(tRef.current), []);

  const onCopy = async () => {
    const el = ref.current;
    if (!el || !navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(tableDataToMarkdown(extractTableDataFromElement(el)));
      setCopied(true);
      tRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* swallow */
    }
  };

  return (
    <div className="group relative my-3">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onCopy}
            aria-label="Copy table"
            className="border-border/60 bg-card/90 text-muted-foreground hover:text-foreground absolute top-1.5 right-1.5 z-10 size-6 border opacity-0 shadow-sm transition-opacity group-hover:opacity-100"
          >
            {copied ? (
              <Check size={12} strokeWidth={1.75} />
            ) : (
              <Copy size={12} strokeWidth={1.75} />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{copied ? "Copied" : "Copy table"}</TooltipContent>
      </Tooltip>
      {/* Wrapper owns the vertical rhythm so the absolute copy button aligns to
          the table's real top edge (the inner table's own prose/Streamdown
          margin is zeroed). */}
      <div className="overflow-x-auto [&>table]:!my-0">
        <table ref={ref} {...props}>
          {children}
        </table>
      </div>
    </div>
  );
}

/**
 * Shared Streamdown `components` map wiring fenced blocks through the
 * Lezer-highlighted renderer and tables through the host-tooltip copy control.
 * Used by both the AI chat (`MessageResponse`) and the editor's markdown file
 * preview so code blocks and tables look identical in either surface. Module-
 * level constant so Streamdown sees a stable reference and doesn't re-render on
 * every parent render.
 */
export const markdownComponents = { code: MarkdownCode, table: MarkdownTable };
