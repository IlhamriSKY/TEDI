import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Tool } from "@/components/ai-elements/tool";
import {
  ArrowUp01Icon,
  CodeIcon,
  HashtagIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  extractUserMessage,
  getUserMessageBody,
  type ExtractedFile,
  type ExtractedSelection,
} from "../lib/messageBody";
import { SLASH_COMMANDS } from "../lib/slashCommands";
import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import type {
  ChatStatus,
  DynamicToolUIPart,
  ToolUIPart,
  UIMessage,
  UIMessagePart,
} from "ai";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { AiToolApproval } from "./AiToolApproval";

function CommandSnippet({ name }: { name: string }) {
  const meta = SLASH_COMMANDS[name];
  if (!meta) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1 font-mono text-[11px]">
        /{name}
      </div>
    );
  }
  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-border/50 bg-muted/40 px-2 py-1">
      <HugeiconsIcon
        icon={meta.icon}
        size={12}
        strokeWidth={1.75}
        className="shrink-0 text-foreground"
      />
      <span className="font-mono text-[11px] text-foreground">
        {meta.invocation}
      </span>
      <span className="truncate text-[11px] text-muted-foreground">
        {meta.label}
      </span>
    </div>
  );
}

function UserAttachmentChips({
  files,
  selections,
  snippets,
}: {
  files: ExtractedFile[];
  selections: ExtractedSelection[];
  snippets: string[];
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {snippets.map((handle, i) => (
        <span
          key={`s-${i}-${handle}`}
          className="flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary"
          title={`Snippet #${handle}`}
        >
          <HugeiconsIcon
            icon={HashtagIcon}
            size={11}
            strokeWidth={2}
            className="opacity-80"
          />
          <span className="font-medium">{handle}</span>
        </span>
      ))}
      {selections.map((sel, i) => (
        <span
          key={`sel-${i}`}
          className="flex items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 py-0.5 text-[11px]"
          title={`${sel.source} selection`}
        >
          <HugeiconsIcon
            icon={sel.source === "editor" ? CodeIcon : TerminalIcon}
            size={11}
            strokeWidth={1.75}
            className="text-muted-foreground"
          />
          <span>
            {sel.source === "editor" ? "Editor selection" : "Terminal selection"}
            {sel.lines > 0 ? (
              <span className="ml-1 text-muted-foreground">· {sel.lines}L</span>
            ) : null}
          </span>
        </span>
      ))}
      {files.map((f, i) => (
        <span
          key={`f-${i}-${f.name}`}
          className="flex items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 py-0.5 text-[11px]"
          title={f.name}
        >
          <img
            src={fileIconUrl(f.name)}
            alt=""
            aria-hidden
            className="size-3.5 shrink-0"
          />
          <span className="max-w-40 truncate">{f.name}</span>
        </span>
      ))}
    </div>
  );
}

type AnyToolPart = ToolUIPart | DynamicToolUIPart;
type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

type ApprovalArg = {
  id: string;
  approved: boolean;
  reason?: string;
};

type Props = {
  messages: UIMessage[];
  status: ChatStatus;
  error: Error | undefined;
  clearError: () => void;
  addToolApprovalResponse: (arg: ApprovalArg) => void | PromiseLike<void>;
  stop: () => void | PromiseLike<void>;
};

export function AiChatView({
  messages,
  status,
  error,
  clearError,
  addToolApprovalResponse,
}: Props) {
  const isBusy = status === "submitted" || status === "streaming";
  const lastMessage = messages[messages.length - 1];
  const showSpinner = isBusy && lastMessage?.role === "user";
  const streamingMessageId =
    status === "streaming" && lastMessage?.role === "assistant"
      ? lastMessage.id
      : null;

  const onApproval = useCallback(
    (id: string, approved: boolean) => addToolApprovalResponse({ id, approved }),
    [addToolApprovalResponse],
  );

  if (messages.length === 0) {
    return (
      <Conversation>
        <ConversationContent>
          <ConversationEmptyState
            title="Ask TEDI anything"
            description="Explain command output, fix errors, generate snippets, or run a task."
          />
        </ConversationContent>
      </Conversation>
    );
  }

  return (
    <Conversation className="chat-scroll">
      <ConversationContent className="gap-5 p-3">
        <LastUserMessagePin messages={messages} />
        {messages.map((m) => (
          <RenderedMessage
            key={m.id}
            message={m}
            onApproval={onApproval}
            streaming={m.id === streamingMessageId}
          />
        ))}
        {showSpinner && <ThinkingIndicator />}
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <div className="font-medium">Something went wrong.</div>
            <div className="mt-0.5 leading-relaxed opacity-90">
              {error.message}
            </div>
            <button
              type="button"
              onClick={clearError}
              className="mt-1 cursor-pointer underline opacity-80 hover:opacity-100"
            >
              Dismiss
            </button>
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function LastUserMessagePin({ messages }: { messages: UIMessage[] }) {
  const { scrollRef } = useStickToBottomContext();
  const lastUserMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i];
    }
    return null;
  }, [messages]);

  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    setHidden(true);
    if (!lastUserMessage) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    let io: IntersectionObserver | null = null;

    const tryObserve = (): boolean => {
      const target = scroller.querySelector(
        `[data-message-id="${CSS.escape(lastUserMessage.id)}"]`,
      ) as HTMLElement | null;
      if (!target) return false;
      io = new IntersectionObserver(
        ([entry]) => setHidden(entry.isIntersecting),
        { root: scroller, threshold: 0.1 },
      );
      io.observe(target);
      return true;
    };

    if (tryObserve()) return () => io?.disconnect();
    // ConversationContent may not have rendered the message yet on the
    // first pass; retry on the next frame to catch the initial mount.
    const raf = requestAnimationFrame(() => tryObserve());
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
    };
  }, [lastUserMessage, scrollRef]);

  if (!lastUserMessage || hidden) return null;

  const body = getUserMessageBody(lastUserMessage) || "(attachments only)";
  const oneLine = body.replace(/\s+/g, " ").trim();
  const scrollToMessage = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const target = scroller.querySelector(
      `[data-message-id="${CSS.escape(lastUserMessage.id)}"]`,
    ) as HTMLElement | null;
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <motion.button
      type="button"
      onClick={scrollToMessage}
      title="Jump to your last message"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        // Sticky inside the scroll container so wheel events on the chat
        // still bubble to the scrollable ancestor. `top-0 -mx-3` cancels
        // ConversationContent's `p-3` so the pin reaches the chat edges.
        "sticky top-0 z-10 -mx-3 flex cursor-pointer items-center gap-2",
        "border-b border-border/60 bg-background/95 px-3 py-1.5 text-left text-[11.5px] shadow-sm backdrop-blur",
        "text-foreground/85 transition-colors hover:bg-accent hover:text-foreground",
      )}
    >
      <HugeiconsIcon
        icon={ArrowUp01Icon}
        size={11}
        strokeWidth={2}
        className="shrink-0 opacity-70"
      />
      <span className="min-w-0 flex-1 truncate">{oneLine}</span>
    </motion.button>
  );
}

const RenderedMessage = memo(function RenderedMessage({
  message,
  onApproval,
  streaming,
}: {
  message: UIMessage;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
}) {
  // Only the trailing text part of an in-flight assistant message is live;
  // earlier text parts (split by tool calls) are already finalized.
  let lastTextIdx = -1;
  for (let i = message.parts.length - 1; i >= 0; i -= 1) {
    if (message.parts[i]?.type === "text") {
      lastTextIdx = i;
      break;
    }
  }
  if (message.role === "user") {
    const rawText = message.parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");

    const { commandName, files, selections, snippets, body } =
      extractUserMessage(rawText);

    return (
      <Message from="user" data-message-id={message.id}>
        <MessageContent>
          {commandName ? <CommandSnippet name={commandName} /> : null}
          {files.length + selections.length + snippets.length > 0 ? (
            <UserAttachmentChips
              files={files}
              selections={selections}
              snippets={snippets}
            />
          ) : null}
          {body ? (
            <p className="whitespace-pre-wrap wrap-break-word">{body}</p>
          ) : null}
        </MessageContent>
      </Message>
    );
  }

  return (
    <Message from={message.role}>
      <MessageContent>
        <div className="flex flex-col gap-3">
          {message.parts.map((part, i) => (
            <RenderedPart
              key={`${message.id}-${i}`}
              part={part as AnyPart}
              onApproval={onApproval}
              streaming={streaming && i === lastTextIdx}
            />
          ))}
        </div>
      </MessageContent>
    </Message>
  );
});

const RenderedPart = memo(function RenderedPart({
  part,
  onApproval,
  streaming,
}: {
  part: AnyPart;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
}) {
  if (part.type === "text") {
    return (
      <MessageResponse streaming={streaming}>
        {(part as unknown as { text: string }).text}
      </MessageResponse>
    );
  }

  if (part.type === "reasoning") {
    return (
      <Reasoning>
        <ReasoningTrigger />
        <ReasoningContent>
          {(part as unknown as { text: string }).text}
        </ReasoningContent>
      </Reasoning>
    );
  }

  if (
    part.type === "dynamic-tool" ||
    (typeof part.type === "string" && part.type.startsWith("tool-"))
  ) {
    return (
      <RenderedTool
        part={part as unknown as AnyToolPart}
        onApproval={onApproval}
      />
    );
  }

  return null;
});

const RenderedTool = memo(function RenderedTool({
  part,
  onApproval,
}: {
  part: AnyToolPart;
  onApproval: (id: string, approved: boolean) => void;
}) {
  const toolName =
    part.type === "dynamic-tool"
      ? part.toolName
      : part.type.replace(/^tool-/, "");

  if (part.state === "approval-requested") {
    return (
      <AiToolApproval
        part={part as Extract<ToolUIPart, { state: "approval-requested" }>}
        toolName={toolName}
        onRespond={(approved) => onApproval(part.approval.id, approved)}
      />
    );
  }

  return (
    <Tool
      toolName={toolName}
      state={part.state}
      input={part.input}
      output={"output" in part ? part.output : undefined}
      errorText={"errorText" in part ? part.errorText : undefined}
    />
  );
});

function ThinkingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "flex w-fit items-center gap-2 rounded-2xl border border-border/50",
        "bg-muted/40 px-3 py-2 text-[11.5px] text-muted-foreground",
      )}
      role="status"
      aria-label="Thinking"
    >
      <span className="flex items-center gap-1">
        <ThinkingDot delay={0} />
        <ThinkingDot delay={0.18} />
        <ThinkingDot delay={0.36} />
      </span>
      <span className="leading-none">Thinking…</span>
    </motion.div>
  );
}

function ThinkingDot({ delay }: { delay: number }) {
  return (
    <motion.span
      className="block size-1.5 rounded-full bg-muted-foreground/70"
      animate={{
        opacity: [0.25, 1, 0.25],
        y: [0, -2, 0],
      }}
      transition={{
        duration: 1.1,
        repeat: Infinity,
        ease: "easeInOut",
        delay,
      }}
    />
  );
}
