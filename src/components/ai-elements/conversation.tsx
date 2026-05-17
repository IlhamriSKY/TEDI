"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import { ArrowDown01Icon, Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion } from "motion/react";
import type { ComponentProps } from "react";
import { useCallback } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

export const Conversation = ({ className, ...props }: ConversationProps) => (
  <StickToBottom
    className={cn("relative flex-1 overflow-y-hidden", className)}
    initial="smooth"
    resize="smooth"
    role="log"
    {...props}
  />
);

export type ConversationContentProps = ComponentProps<typeof StickToBottom.Content>;

export const ConversationContent = ({ className, ...props }: ConversationContentProps) => (
  // `use-stick-to-bottom` hardcodes `scrollbar-gutter: stable both-edges`
  // on the scroller via inline style, which reserves 16px on BOTH sides
  // (so the layout stays symmetric whether or not a scrollbar is shown)
  // and leaves a visible gap around full-bleed children like the sticky
  // last-message pin. Trailing `!` flag raises our class to `!important`
  // so it beats the inline style — `auto` only allocates a gutter when a
  // scrollbar actually appears, so empty / short chats render fully flush
  // and longer ones still get a clean right-side scrollbar lane.
  <StickToBottom.Content
    scrollClassName="[scrollbar-gutter:auto]!"
    className={cn("flex flex-col gap-5 p-4", className)}
    {...props}
  />
);

export type ConversationEmptyStateProps = ComponentProps<"div"> & {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
};

export const ConversationEmptyState = ({
  className,
  title = "No messages yet",
  description = "Start a conversation to see messages here",
  icon,
  children,
  ...props
}: ConversationEmptyStateProps) => (
  <div
    className={cn(
      "flex size-full flex-col items-center justify-center gap-3 p-8 text-center",
      className,
    )}
    {...props}
  >
    {children ?? (
      <>
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{title}</h3>
          {description && <p className="text-muted-foreground text-sm">{description}</p>}
        </div>
      </>
    )}
  </div>
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  const handleScrollToBottom = useCallback(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  return (
    <AnimatePresence>
      {!isAtBottom && (
        <motion.div
          key="scroll-to-bottom"
          initial={{ opacity: 0, y: 10, scale: 0.9 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 8, scale: 0.9 }}
          transition={{
            type: "spring",
            stiffness: 380,
            damping: 28,
            mass: 0.55,
          }}
          className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2"
        >
          <Button
            className={cn(
              // Same outline-pill style; just enough shadow to lift it off
              // the chat, no halo ring. Text + arrow keeps the affordance
              // obvious without needing a giant glow.
              "border-border/60 bg-background text-muted-foreground hover:border-foreground/30 hover:bg-accent hover:text-foreground dark:bg-background dark:hover:bg-muted pointer-events-auto h-7 gap-1.5 rounded-full border px-3 text-[11px] font-medium shadow-md backdrop-blur transition-colors active:scale-95",
              className,
            )}
            onClick={handleScrollToBottom}
            type="button"
            variant="outline"
            {...props}
          >
            <HugeiconsIcon icon={ArrowDown01Icon} size={13} strokeWidth={2.25} />
            <span>Scroll to bottom</span>
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

const getMessageText = (message: UIMessage): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");

export type ConversationDownloadProps = Omit<ComponentProps<typeof Button>, "onClick"> & {
  messages: UIMessage[];
  filename?: string;
  formatMessage?: (message: UIMessage, index: number) => string;
};

const defaultFormatMessage = (message: UIMessage): string => {
  const roleLabel = message.role.charAt(0).toUpperCase() + message.role.slice(1);
  return `**${roleLabel}:** ${getMessageText(message)}`;
};

export const messagesToMarkdown = (
  messages: UIMessage[],
  formatMessage: (message: UIMessage, index: number) => string = defaultFormatMessage,
): string => messages.map((msg, i) => formatMessage(msg, i)).join("\n\n");

export const ConversationDownload = ({
  messages,
  filename = "conversation.md",
  formatMessage = defaultFormatMessage,
  className,
  children,
  ...props
}: ConversationDownloadProps) => {
  const handleDownload = useCallback(() => {
    const markdown = messagesToMarkdown(messages, formatMessage);
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [messages, filename, formatMessage]);

  return (
    <Button
      className={cn("dark:bg-background dark:hover:bg-muted absolute top-4 right-4", className)}
      onClick={handleDownload}
      size="icon"
      type="button"
      variant="outline"
      {...props}
    >
      {children ?? <HugeiconsIcon icon={Download01Icon} size={16} />}
    </Button>
  );
};
