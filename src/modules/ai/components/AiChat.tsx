import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool } from "@/components/ai-elements/tool";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import {
  extractUserMessage,
  getTediUserMetadata,
  getUserMessageBody,
  type ExtractedFile,
  type ExtractedSelection,
} from "../lib/messageBody";
import { openAICompatibleInstanceLabel, PROVIDERS } from "../config";
import { formatElapsed, useElapsedSince } from "../lib/elapsed";
import { useIsMaxEffort } from "../lib/useMaxEffort";
import { useChatStore } from "../store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { humanizeChatErrorMessage } from "../lib/errors";
import { SLASH_COMMANDS } from "../lib/slashCommands";
import { cn } from "@/lib/utils";
import { PixelActivity } from "@/components/ui/pixel-activity";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { motion } from "motion/react";
import { ImageLightbox } from "./ImageLightbox";
import { RestoreCheckpointButton } from "./RestoreCheckpointButton";
import type { ChatStatus, DynamicToolUIPart, ToolUIPart, UIMessage, UIMessagePart } from "ai";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStickToBottomContext } from "use-stick-to-bottom";
import { AiToolApproval } from "./AiToolApproval";
import { ChevronRight, ChevronUp, Code, Terminal } from "lucide-react";

function CommandSnippet({ name }: { name: string }) {
  const meta = SLASH_COMMANDS[name];
  if (!meta) {
    return (
      <div className="border-border/50 bg-muted/40 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px]">
        /{name}
      </div>
    );
  }
  const Icon = meta.icon;
  return (
    <div className="border-border/50 bg-muted/40 inline-flex max-w-full items-center gap-2 rounded-md border px-2 py-1">
      <Icon size={12} strokeWidth={2} className="text-foreground shrink-0" />
      <span className="text-foreground font-mono text-[11px]">{meta.invocation}</span>
      {meta.label && meta.label !== name ? (
        <span className="text-muted-foreground truncate text-[11px]">{meta.label}</span>
      ) : null}
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
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-1">
      {snippets.map((handle, i) => (
        <Tooltip key={`s-${i}-${handle}`}>
          <TooltipTrigger asChild>
            <span className="border-primary/30 bg-primary/10 text-primary flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]">
              <ChevronRight size={11} strokeWidth={2} className="opacity-80" />
              <span className="font-medium">{handle}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{`Snippet >${handle}`}</TooltipContent>
        </Tooltip>
      ))}
      {selections.map((sel, i) => (
        <Tooltip key={`sel-${i}`}>
          <TooltipTrigger asChild>
            <span className="border-border/60 bg-card flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]">
              {sel.source === "editor" ? (
                <Code size={11} strokeWidth={2} className="text-muted-foreground" />
              ) : (
                <Terminal size={11} strokeWidth={2} className="text-muted-foreground" />
              )}
              <span>
                {sel.source === "editor" ? "Editor selection" : "Terminal selection"}
                {sel.lines > 0 ? (
                  <span className="text-muted-foreground ml-1">· {sel.lines}L</span>
                ) : null}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{`${sel.source} selection`}</TooltipContent>
        </Tooltip>
      ))}
      {files.map((f, i) => {
        const isImage = Boolean(f.url) && (f.mediaType?.startsWith("image/") ?? false);
        // Images render the picture itself; click to enlarge.
        if (isImage) {
          return (
            <button
              key={`f-${i}-${f.name}`}
              type="button"
              onClick={() => {
                if (f.url) setLightboxUrl(f.url);
              }}
              className="block shrink-0 cursor-zoom-in"
              aria-label={`Enlarge ${f.name}`}
              title={f.name}
            >
              {/* Small inline preview at the image's real aspect ratio. */}
              <img
                src={f.url}
                alt={f.name}
                className="border-border/60 hover:border-foreground/30 max-h-10 w-auto max-w-full rounded-md border object-contain transition-colors"
              />
            </button>
          );
        }
        return (
          <Tooltip key={`f-${i}-${f.name}`}>
            <TooltipTrigger asChild>
              <span className="border-border/60 bg-card flex max-w-full min-w-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]">
                <img src={fileIconUrl(f.name)} alt="" aria-hidden className="size-3.5 shrink-0" />
                <span className="max-w-40 truncate">{f.name}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{f.name}</TooltipContent>
          </Tooltip>
        );
      })}
      {lightboxUrl ? (
        <ImageLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />
      ) : null}
    </div>
  );
}

function UserMessageModelChip({
  meta,
}: {
  meta: {
    tediModel: string;
    tediModelLabel: string;
    tediProvider: string;
    tediOwnedBy?: string;
  };
}) {
  // Prefer the model maker (e.g. "Xiaomi" for mimo) over the gateway label
  // so the chip credits the brand. Exception: SumoPod proxies many makers, so
  // always render the SumoPod gateway label and ignore any upstream owned_by.
  const oacInstances = usePreferencesStore((s) => s.openaiCompatibleInstances);
  // OpenAI-Compatible: credit the endpoint by its configured label (multiple
  // can be added). Its `owned_by` is a gateway-internal tag (often "cx") that
  // means nothing, so ignore it and never show the generic provider name.
  const oacLabel =
    meta.tediProvider === "openai-compatible"
      ? openAICompatibleInstanceLabel(meta.tediModel, oacInstances)
      : null;
  const gatewayLabel =
    oacLabel ?? PROVIDERS.find((p) => p.id === meta.tediProvider)?.label ?? meta.tediProvider;
  const showOwner =
    meta.tediProvider !== "openai-compatible" &&
    meta.tediProvider !== "sumopod" &&
    !!meta.tediOwnedBy;
  const ownerLabel = showOwner ? capitalize(meta.tediOwnedBy as string) : gatewayLabel;
  const tooltip =
    showOwner && (meta.tediOwnedBy as string).toLowerCase() !== gatewayLabel.toLowerCase()
      ? `Sent via ${meta.tediModelLabel} (${ownerLabel} · ${gatewayLabel})`
      : `Sent via ${meta.tediModelLabel} (${ownerLabel})`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-muted-foreground/80 flex items-center gap-1 text-[10px]">
          <span className="font-mono">{meta.tediModelLabel}</span>
          <span aria-hidden>·</span>
          <span>{ownerLabel}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
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
};

export function AiChatView({
  messages,
  status,
  error,
  clearError,
  addToolApprovalResponse,
}: Props) {
  const isBusy = status === "submitted" || status === "streaming";
  const activity = useChatStore((s) => s.agentMeta.step);
  const lastMessage = messages[messages.length - 1];
  const streamingMessageId =
    status === "streaming" && lastMessage?.role === "assistant" ? lastMessage.id : null;

  // Restore only applies after the turn finishes; attach to the most recent
  // user message and hide mid-stream to avoid yanking state from a running agent.
  const lastUserMessageId = useMemo(() => {
    if (isBusy) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].id;
    }
    return null;
  }, [messages, isBusy]);

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
            isLastUser={m.id === lastUserMessageId}
          />
        ))}
        {isBusy && <RunningIndicator waiting={status === "submitted"} activity={activity} />}
        {error && (
          <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
            <div className="font-medium">Something went wrong.</div>
            <div className="mt-0.5 leading-relaxed opacity-90">
              {humanizeChatErrorMessage(error.message)}
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
  const userMessages = useMemo(() => messages.filter((m) => m.role === "user"), [messages]);

  // Stable key from user-message ids. `userMessages` re-derives on every
  // assistant token, but observers only rewire when a user message is added or
  // removed, not on every streaming chunk.
  const userIdsKey = useMemo(() => userMessages.map((m) => m.id).join("|"), [userMessages]);

  // id -> true when scrolled above the viewport. Tracks every user message and
  // surfaces the most recent off-screen one, so scrolling deep into history
  // shows the matching prompt, not just the global last user message.
  const [aboveViewport, setAboveViewport] = useState<ReadonlyMap<string, boolean>>(() => new Map());

  // Latest snapshot accessible inside the effect closure without becoming a dep.
  const userMessagesRef = useRef(userMessages);
  userMessagesRef.current = userMessages;

  useEffect(() => {
    const scroller = scrollRef.current;
    const currentUserMessages = userMessagesRef.current;
    if (!scroller || currentUserMessages.length === 0) {
      setAboveViewport(new Map());
      return;
    }

    const state = new Map<string, boolean>();
    let raf = 0;
    const flush = () => {
      raf = 0;
      setAboveViewport(new Map(state));
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(flush);
    };

    const observers: IntersectionObserver[] = [];
    const wireOne = (id: string): boolean => {
      const target = scroller.querySelector(
        `[data-message-id="${CSS.escape(id)}"]`,
      ) as HTMLElement | null;
      if (!target) return false;
      const io = new IntersectionObserver(
        ([entry]) => {
          // "Above viewport" means not intersecting and bounding box ends
          // before the root's top edge. boundingClientRect and rootBounds
          // share viewport coords, so this is a direct y-comparison.
          const rootTop = entry.rootBounds?.top ?? 0;
          const isAbove = !entry.isIntersecting && entry.boundingClientRect.bottom <= rootTop;
          state.set(id, isAbove);
          schedule();
        },
        { root: scroller, threshold: 0 },
      );
      io.observe(target);
      observers.push(io);
      return true;
    };

    // Some messages haven't rendered on the first pass; retry next frame.
    const pending: string[] = [];
    for (const m of currentUserMessages) {
      if (!wireOne(m.id)) pending.push(m.id);
    }
    let retryRaf = 0;
    if (pending.length > 0) {
      retryRaf = requestAnimationFrame(() => {
        for (const id of pending) wireOne(id);
      });
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (retryRaf) cancelAnimationFrame(retryRaf);
      for (const io of observers) io.disconnect();
    };
  }, [userIdsKey, scrollRef]);

  // Pick the latest user message currently above the viewport. If none are
  // scrolled off, the pin stays hidden.
  const pinTarget = useMemo(() => {
    for (let i = userMessages.length - 1; i >= 0; i--) {
      if (aboveViewport.get(userMessages[i].id)) return userMessages[i];
    }
    return null;
  }, [userMessages, aboveViewport]);

  if (!pinTarget) return null;

  const body = getUserMessageBody(pinTarget) || "(attachments only)";
  const oneLine = body.replace(/\s+/g, " ").trim();
  const scrollToMessage = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const target = scroller.querySelector(
      `[data-message-id="${CSS.escape(pinTarget.id)}"]`,
    ) as HTMLElement | null;
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          type="button"
          onClick={scrollToMessage}
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
          className={cn(
            // Sticky inside the scroll container so wheel events bubble to the
            // scrollable ancestor. `-mx-4` cancels ConversationContent's `px-4`
            // so the pin is flush with the chat's edges.
            "tedi-chat-pin sticky top-0 z-10 -mx-4 flex cursor-pointer items-center gap-2",
            "border-border/60 bg-background/95 border-b px-3 py-1.5 text-left text-[11.5px] shadow-sm backdrop-blur",
            "text-foreground/85 hover:bg-accent hover:text-accent-foreground transition-colors",
          )}
        >
          <ChevronUp size={11} strokeWidth={2} className="shrink-0 opacity-70" />
          <span className="min-w-0 flex-1 truncate">{oneLine}</span>
        </motion.button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Jump to this message</TooltipContent>
    </Tooltip>
  );
}

const RenderedMessage = memo(function RenderedMessage({
  message,
  onApproval,
  streaming,
  isLastUser,
}: {
  message: UIMessage;
  onApproval: (id: string, approved: boolean) => void;
  streaming: boolean;
  isLastUser: boolean;
}) {
  // Only the trailing text part of an in-flight assistant message streams;
  // earlier text parts split by tool calls are finalized.
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

    const { commandName, files, selections, snippets, body } = extractUserMessage(rawText);

    // Image attachments ride along as `file` parts (data URLs), not text
    // `<file>` blocks, so pull them out here and merge into the chip list.
    const imageFiles: ExtractedFile[] = message.parts
      .filter(
        (p): p is { type: "file"; url: string; mediaType: string; filename?: string } =>
          p.type === "file" && typeof (p as { url?: unknown }).url === "string",
      )
      .map((p) => ({ name: p.filename ?? "image", url: p.url, mediaType: p.mediaType }));
    const allFiles = [...files, ...imageFiles];

    const meta = getTediUserMetadata(message);
    return (
      <Message from="user" data-message-id={message.id}>
        <MessageContent>
          {commandName ? <CommandSnippet name={commandName} /> : null}
          {allFiles.length + selections.length + snippets.length > 0 ? (
            <UserAttachmentChips files={allFiles} selections={selections} snippets={snippets} />
          ) : null}
          {body ? <p className="wrap-break-word whitespace-pre-wrap">{body}</p> : null}
        </MessageContent>
        <div className="mt-1 flex items-center justify-end gap-2">
          {isLastUser ? <RestoreCheckpointButton /> : null}
          {meta ? <UserMessageModelChip meta={meta} /> : null}
        </div>
      </Message>
    );
  }

  return (
    <Message from={message.role}>
      <MessageContent>
        <div className="flex flex-col gap-3">
          {message.parts.map((part, i) => (
            // Contain a malformed model part so one bad part can't crash the
            // whole chat panel (RenderedPart reads untrusted model output).
            <ErrorBoundary
              key={`${message.id}-${i}`}
              label="message part"
              resetKeys={[part]}
              fallback={() => (
                <div className="text-muted-foreground bg-muted/40 rounded-md px-2 py-1 text-[11px]">
                  (a part of this message failed to render)
                </div>
              )}
            >
              <RenderedPart
                part={part as AnyPart}
                onApproval={onApproval}
                streaming={streaming && i === lastTextIdx}
              />
            </ErrorBoundary>
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
        <ReasoningContent>{(part as unknown as { text: string }).text}</ReasoningContent>
      </Reasoning>
    );
  }

  if (
    part.type === "dynamic-tool" ||
    (typeof part.type === "string" && part.type.startsWith("tool-"))
  ) {
    return <RenderedTool part={part as unknown as AnyToolPart} onApproval={onApproval} />;
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
  const toolName = part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");

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

/**
 * Proof of life for the whole turn. Mounted for as long as the agent is busy -
 * NOT only while the last message is the user's, which used to hide it the
 * moment the assistant replied, so a 90s tool call (an API request, a slow
 * provider) left a completely static screen with no way to tell running from
 * hung. The dots animate and the clock ticks: both stop dead if the app does.
 */
function readableActivity(activity: string | null, waiting: boolean): string {
  if (waiting) return "Waiting for the model";
  if (!activity) return "Thinking about the next step";
  const clean = activity.replace(/…/g, "").replace(/\s+/g, " ").trim();
  const translations: Array<[RegExp, string]> = [
    [/^Grepping\s+(.+)$/i, "Searching code for $1"],
    [/^Globbing\s+(.+)$/i, "Finding files matching $1"],
    [/^Listing\s+(.+)$/i, "Checking files in $1"],
    [/^Fetching\s+(.+)$/i, "Loading $1"],
    [/^Calling\s+(.+)$/i, "Using $1"],
    [/^Spawning\s+(.+)$/i, "Starting $1"],
  ];
  for (const [pattern, replacement] of translations) {
    if (pattern.test(clean)) return clean.replace(pattern, replacement);
  }
  return clean;
}

function RunningIndicator({ waiting, activity }: { waiting: boolean; activity: string | null }) {
  // Mounts when the turn starts and unmounts when it settles, so elapsed is
  // time-in-turn. `true`: while mounted, the turn is by definition running.
  const elapsed = useElapsedSince(true);
  const label = readableActivity(activity, waiting);
  const isMax = useIsMaxEffort();
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="border-border/50 bg-muted/25 text-muted-foreground flex max-w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11.5px] shadow-sm"
      role="status"
      aria-label={`AI status: ${label}`}
    >
      {/* No frame around it. The block IS the indicator, and a border made it
          read as a button you could press. At max the cells take the foil
          palette, so the deepest setting is visible while the turn runs and
          not only in the picker that set it. */}
      <PixelActivity
        label="AI working"
        variant={isMax ? "max" : "default"}
        className="text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate leading-none" title={label}>
        {label}
      </span>
      {elapsed >= 1000 ? (
        <span
          aria-hidden
          className="border-border/50 bg-background shrink-0 rounded px-1.5 py-0.5 font-mono text-[10.5px] tabular-nums opacity-80"
        >
          {formatElapsed(elapsed)}
        </span>
      ) : null}
    </motion.div>
  );
}
