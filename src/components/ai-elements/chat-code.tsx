"use client";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  ArrowRight01Icon,
  CheckmarkCircle01Icon,
  CopyIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createContext, memo, use, useEffect, useRef, useState } from "react";

import { Shimmer } from "./shimmer";
import { highlight, isHighlightable, type HighlightedNode } from "./chat-code-lezer";

// Shell langs that get the CommandCard UI (prompt prefix + Run button).
// Still highlightable; the card delegates to HighlightedPre.
const POSIX_SHELL = new Set(["bash", "sh", "zsh", "shell", "console", "shellscript"]);
const WINDOWS_SHELL = new Set(["powershell", "pwsh", "ps1", "ps", "cmd", "bat", "batch"]);
const SHELL_LANGS = new Set([...POSIX_SHELL, ...WINDOWS_SHELL]);

// True while the parent message is still streaming from the model. We hide
// fenced-code contents during this phase: parsing partial code is wasted
// work and a flashing skeleton is calmer UI than text that grows char-by-char.
const StreamingCtx = createContext(false);
export const ChatStreamingProvider = StreamingCtx.Provider;

function shellPrompt(lang: string): string {
  if (WINDOWS_SHELL.has(lang))
    return lang === "cmd" || lang === "bat" || lang === "batch" ? ">" : "PS>";
  return "$";
}

function normalizeLangLabel(raw: string): string {
  const lower = raw.toLowerCase();
  if (POSIX_SHELL.has(lower)) return "bash";
  if (lower === "pwsh" || lower === "ps1" || lower === "ps") return "powershell";
  if (lower === "bat" || lower === "batch") return "cmd";
  return lower || "text";
}

export type ChatCodeBlockProps = {
  code: string;
  lang: string | null;
};

export function ChatCodeBlock({ code, lang }: ChatCodeBlockProps) {
  const streaming = use(StreamingCtx);
  const label = normalizeLangLabel(lang ?? "");

  if (streaming) {
    return <GeneratingPlaceholder label={label} />;
  }

  if (SHELL_LANGS.has(label)) {
    return <CommandCard code={code} lang={label} />;
  }

  return <FinalizedCodeBlock code={code} lang={label} />;
}

function GeneratingPlaceholder({ label }: { label: string }) {
  return (
    <div className="not-prose border-border/50 bg-muted/30 text-muted-foreground my-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-[11px]">
      <span className="bg-muted-foreground/60 inline-block size-1.5 animate-pulse rounded-full" />
      <Shimmer duration={1.2}>
        {label === "text" ? "Generating code…" : `Generating ${label}…`}
      </Shimmer>
    </div>
  );
}

function BlockChrome({
  label,
  code,
  children,
}: {
  label: string;
  code: string;
  children: React.ReactNode;
}) {
  return (
    <div className="not-prose border-border/50 bg-muted/30 my-2 overflow-hidden rounded-lg border">
      <div className="border-border/40 bg-muted/20 flex items-center justify-between gap-2 border-b px-3 py-1">
        <span className="text-muted-foreground font-mono text-[10px] tracking-wide uppercase">
          {label}
        </span>
        <CopyButton text={code} />
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function FinalizedCodeBlock({ code, lang }: { code: string; lang: string }) {
  if (!isHighlightable(lang)) {
    return (
      <BlockChrome label={lang} code={code}>
        <pre className="text-foreground m-0 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed">
          {code}
        </pre>
      </BlockChrome>
    );
  }
  return (
    <BlockChrome label={lang} code={code}>
      <HighlightedPre code={code} lang={lang} />
    </BlockChrome>
  );
}

const HighlightedPre = memo(function HighlightedPre({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
  const [nodes, setNodes] = useState<HighlightedNode[] | null>(null);
  const cancelRef = useRef(false);

  useEffect(() => {
    cancelRef.current = false;
    let cancelled = false;
    highlight(code, lang)
      .then((result) => {
        if (cancelled || cancelRef.current) return;
        setNodes(result);
      })
      .catch(() => {
        if (cancelled) return;
        setNodes(null);
      });
    return () => {
      cancelled = true;
      cancelRef.current = true;
    };
  }, [code, lang]);

  if (!nodes) {
    return (
      <pre className="text-foreground m-0 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed">
        {code}
      </pre>
    );
  }

  return (
    <pre className="text-foreground m-0 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed">
      {nodes.map((node, i) =>
        node.kind === "break" ? (
          // eslint-disable-next-line react/no-array-index-key
          <span key={i}>{"\n"}</span>
        ) : (
          // eslint-disable-next-line react/no-array-index-key
          <span key={i} className={node.cls || undefined}>
            {node.value}
          </span>
        ),
      )}
    </pre>
  );
});

function CommandCard({ code, lang }: { code: string; lang: string }) {
  const isMultiline = code.includes("\n");
  const prompt = shellPrompt(lang);
  const [nodes, setNodes] = useState<HighlightedNode[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    highlight(code, lang)
      .then((result) => {
        if (!cancelled) setNodes(result);
      })
      .catch(() => {
        /* no highlight available */
      });
    return () => {
      cancelled = true;
    };
  }, [code, lang]);

  return (
    <div className="not-prose border-border/50 bg-muted/40 my-2 overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="text-muted-foreground font-mono text-[10px] tracking-wide uppercase">
          {normalizeLangLabel(lang)}
        </span>
        <div className="flex items-center gap-1">
          <RunInTerminalButton command={code} />
          <CopyButton text={code} />
        </div>
      </div>
      <div className="border-border/40 bg-background/40 border-t">
        <HighlightedShellCode
          code={code}
          nodes={nodes}
          prompt={prompt}
          isMultiline={isMultiline}
        />
      </div>
    </div>
  );
}

const HighlightedShellCode = memo(function HighlightedShellCode({
  code,
  nodes,
  prompt,
  isMultiline,
}: {
  code: string;
  nodes: HighlightedNode[] | null;
  prompt: string;
  isMultiline: boolean;
}) {
  if (!nodes) {
    // Fallback: plain text with prompt
    return (
      <pre
        className={cn(
          "text-foreground m-0 overflow-x-auto px-3 py-2 font-mono text-[12px] leading-relaxed",
          isMultiline ? "whitespace-pre" : "whitespace-pre-wrap",
        )}
      >
        {code.split("\n").map((line, i) => (
          // eslint-disable-next-line react/no-array-index-key
          <span key={i} className="flex">
            <span className="text-muted-foreground/70 mr-2 select-none">{prompt}</span>
            <span>{line}</span>
          </span>
        ))}
      </pre>
    );
  }

  // Split highlighted nodes into lines and prepend prompt to each
  const lines: React.ReactNode[][] = [[]];
  for (const node of nodes) {
    if (node.kind === "break") {
      lines.push([]);
    } else {
      lines[lines.length - 1].push(
        <span key={lines.length - 1 + "-" + lines[lines.length - 1].length} className={node.cls || undefined}>
          {node.value}
        </span>,
      );
    }
  }

  return (
    <pre
      className={cn(
        "text-foreground m-0 overflow-x-auto px-3 py-2 font-mono text-[12px] leading-relaxed",
        isMultiline ? "whitespace-pre" : "whitespace-pre-wrap",
      )}
    >
      {lines.map((lineNodes, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <span key={i} className="flex">
          <span className="text-muted-foreground/70 mr-2 select-none">{prompt}</span>
          <span>{lineNodes}</span>
        </span>
      ))}
    </pre>
  );
});

function RunInTerminalButton({ command }: { command: string }) {
  const [sent, setSent] = useState(false);
  const tRef = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(tRef.current), []);
  const onRun = () => {
    const ok = useChatStore.getState().live.injectIntoActivePty(command);
    if (!ok) return;
    setSent(true);
    tRef.current = window.setTimeout(() => setSent(false), 1500);
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={onRun}
          className="text-muted-foreground hover:text-foreground h-5 gap-1 px-1.5 text-[10px] font-medium"
          aria-label="Run in active terminal"
        >
          <HugeiconsIcon
            icon={sent ? TerminalIcon : ArrowRight01Icon}
            size={11}
            strokeWidth={1.75}
          />
          <span>{sent ? "Sent" : "Run"}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">Run in active terminal</TooltipContent>
    </Tooltip>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const tRef = useRef<number>(0);

  useEffect(() => () => window.clearTimeout(tRef.current), []);

  const onCopy = async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      tRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* swallow */
    }
  };

  return (
    <Button
      type="button"
      size="icon"
      variant="ghost"
      onClick={onCopy}
      className="text-muted-foreground hover:text-foreground size-5 shrink-0"
      aria-label="Copy code"
    >
      <HugeiconsIcon
        icon={copied ? CheckmarkCircle01Icon : CopyIcon}
        size={11}
        strokeWidth={1.75}
      />
    </Button>
  );
}
