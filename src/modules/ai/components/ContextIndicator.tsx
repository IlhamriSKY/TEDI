import {
  Context,
  ContextContent,
  ContextContentBody,
  ContextContentFooter,
  ContextContentHeader,
  ContextTrigger,
} from "@/components/ai-elements/context";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import type { UIMessage } from "@ai-sdk/react";
import { useEffect, useMemo, useState } from "react";
import { getModel, getModelContextLimit } from "../config";
import { useChatStore } from "../store/chatStore";
import { Minimize2 } from "lucide-react";

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

/** Shows for COMPACT_BADGE_MS after every compaction pass. Surfaces Stage 1
 *  (lossless dedup) too so users see that auto-compact is running. */
const COMPACT_BADGE_MS = 6000;

function CompactPulseBadge() {
  const lastCompact = useChatStore((s) => s.agentMeta.lastCompact);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!lastCompact) return;
    setVisible(true);
    const t = setTimeout(() => setVisible(false), COMPACT_BADGE_MS);
    return () => clearTimeout(t);
  }, [lastCompact]);
  if (!visible || !lastCompact) return null;
  const { dropped, elided, lossless } = lastCompact.stages;
  // Tone by severity: drop=warning, elide=info, lossless=subtle.
  const tone =
    dropped > 0
      ? "border-icon-working/60 bg-icon-working/15 text-icon-working"
      : elided > 0
        ? "border-info/60 bg-info/15 text-info"
        : "border-diff-added/50 bg-diff-added/10 text-diff-added";
  const detail =
    dropped > 0 ? `−${dropped}` : elided > 0 ? `~${elided}` : lossless > 0 ? "tidy" : "";
  const isTidy = lossless > 0 && dropped === 0 && elided === 0;
  const tip =
    dropped > 0
      ? `Compacted: dropped ${dropped} old message${dropped === 1 ? "" : "s"}`
      : elided > 0
        ? `Compacted: elided ${elided} old tool result${elided === 1 ? "" : "s"}`
        : "Compacted: deduplicated stale read results";
  return (
    <IconTooltip label={tip} side="top">
      <span
        aria-label={tip}
        className={cn(
          "flex h-6 shrink-0 items-center gap-1 rounded-md border px-1.5 font-mono text-[10px] leading-none",
          "animate-in fade-in zoom-in-95 duration-200",
          tone,
        )}
      >
        {!isTidy && <span className="size-1.5 animate-pulse rounded-full bg-current/80" />}
        <Minimize2 size={10} strokeWidth={2} />
        {detail ? <span>{detail}</span> : null}
      </span>
    </IconTooltip>
  );
}

function formatRelativeAge(ms: number): string {
  if (ms < 1000) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function LastCompactLine() {
  const lastCompact = useChatStore((s) => s.agentMeta.lastCompact);
  // Tick once a second to refresh the relative age while the popover is open.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!lastCompact) return;
    const i = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [lastCompact]);
  if (!lastCompact) return null;
  const age = formatRelativeAge(Date.now() - lastCompact.at);
  const { dropped, elided, lossless } = lastCompact.stages;
  const parts: string[] = [];
  if (dropped > 0) parts.push(`dropped ${dropped}`);
  if (elided > 0) parts.push(`elided ${elided}`);
  if (lossless > 0) parts.push("dedup");
  const detail = parts.length > 0 ? parts.join(" · ") : "no-op";
  return (
    <div className="text-muted-foreground mt-1 flex items-center justify-between">
      <span>Last compacted</span>
      <span className="text-foreground font-mono">
        {age} <span className="text-muted-foreground/80">({detail})</span>
      </span>
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
      <CompactPulseBadge />
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
