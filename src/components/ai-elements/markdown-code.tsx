"use client";

import type { ReactNode } from "react";

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
 * Shared Streamdown `components` map wiring fenced blocks through the
 * Lezer-highlighted renderer. Used by both the AI chat (`MessageResponse`)
 * and the editor's markdown file preview so code blocks look identical in
 * either surface. Module-level constant so Streamdown sees a stable
 * reference and doesn't re-render on every parent render.
 */
export const markdownComponents = { code: MarkdownCode };
