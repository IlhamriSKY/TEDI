import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import { cn } from "@/lib/utils";
import type { UIMessage } from "@ai-sdk/react";
import { useMemo } from "react";
import { getModel, getModelContextLimit } from "../config";
import { useChatStore } from "../store/chatStore";

/** Extracted from AiMiniWindow so both the composer toolbar and the mini window
 *  can mount it without an import cycle (AiMiniWindow imports AiInputBar). */

function estimateTokens(messages: UIMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text") {
        chars += (p as { text?: string }).text?.length ?? 0;
      } else if (p.type === "reasoning") {
        chars += (p as { text?: string }).text?.length ?? 0;
      } else if (typeof p.type === "string" && p.type.startsWith("tool-")) {
        const tp = p as unknown as { input?: unknown; output?: unknown };
        if (tp.input) chars += JSON.stringify(tp.input).length;
        if (tp.output) chars += JSON.stringify(tp.output).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function LastCompactLine() {
  const lastCompact = useChatStore((s) => s.agentMeta.lastCompact);
  if (!lastCompact) return null;
  const { dropped, elided } = lastCompact.stages;
  if (dropped === 0 && elided === 0) return null;
  const parts: string[] = [];
  if (dropped > 0) parts.push(`dropped ${dropped}`);
  if (elided > 0) parts.push(`elided ${elided}`);
  return (
    <div className="text-muted-foreground mt-1 flex items-center justify-between">
      <span>Context optimized</span>
      <span className="text-foreground font-mono">{parts.join(" · ")}</span>
    </div>
  );
}

export function ContextIndicator({ messages }: { messages: UIMessage[] }) {
  const modelId = useChatStore((s) => s.selectedModelId);
  // Prompt-cache hit ratio (provider-reported). The one number that proves
  // caching is working; 0% on cache-less providers (Groq/Cerebras/LM Studio).
  const usage = useChatStore((s) => s.agentMeta.usage);
  const used = useMemo(() => estimateTokens(messages), [messages]);
  const max = getModelContextLimit(modelId);
  const modelLabel = useMemo(() => {
    try {
      return getModel(modelId).label;
    } catch {
      return modelId;
    }
  }, [modelId]);

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Context usedTokens={used} maxTokens={max} modelId={modelId}>
        <ContextTrigger className="h-6 gap-1 px-0 text-[10.5px]" />
        <ContextContent className="w-72 text-[11px]">
          <ContextContentHeader />
          <ContextContentBody>
            <div className="text-muted-foreground flex items-center justify-between">
              <span>Model</span>
              <span className="text-foreground font-mono">{modelLabel}</span>
            </div>
            <div className="text-muted-foreground mt-1 flex items-center justify-between">
              <span>Current context</span>
              <span className="text-foreground font-mono">{formatTokens(used)}</span>
            </div>
            <div className="text-muted-foreground flex items-center justify-between">
              <span>Context window</span>
              <span className="text-foreground font-mono">{formatTokens(max)}</span>
            </div>
            <LastCompactLine />
            {usage.input > 0 ? (
              <div className="text-muted-foreground flex items-center justify-between">
                <span>Cache hit</span>
                <span
                  className={cn(
                    "font-mono",
                    usage.cached / usage.input >= 0.5 ? "text-diff-added" : "text-foreground",
                  )}
                >
                  {Math.round((usage.cached / usage.input) * 100)}%
                </span>
              </div>
            ) : null}
          </ContextContentBody>
          <ContextContentFooter>
            <span className="text-muted-foreground text-[10px] italic">
              Estimate is based on visible chat content and tool payloads.
            </span>
          </ContextContentFooter>
        </ContextContent>
      </Context>
    </div>
  );
}
