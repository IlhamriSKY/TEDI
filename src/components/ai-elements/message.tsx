import { ChevronLeft, ChevronRight } from "lucide-react";
("use client");

import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupText } from "@/components/ui/button-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { UIMessage } from "ai";
import type { ComponentProps, HTMLAttributes, ReactElement, ReactNode } from "react";
import { createContext, memo, use, useCallback, useEffect, useMemo, useState } from "react";
import { Streamdown, defaultRehypePlugins } from "streamdown";
import { safeUrlTransform } from "@/lib/markdownSafety";
import { toast } from "@/components/ui/toast";
// Deep path, not the `@/modules/ai` barrel: the barrel re-exports components
// that import this file. Same import `chat-code` and `tool` already use.
import { useChatStore } from "@/modules/ai/store/chatStore";
import { ChatStreamingProvider } from "./chat-code";
import { markdownComponents } from "./markdown-code";
import { rehypeTerminalRefs, TERM_REF_TAG } from "./terminal-refs";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-2",
      from === "user" ? "is-user ml-auto max-w-[85%] items-end justify-end" : "is-assistant",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
  <div
    className={cn(
      "flex w-fit max-w-full min-w-0 flex-col gap-2 overflow-hidden text-[12px] leading-relaxed",
      "group-[.is-user]:bg-muted/70 group-[.is-user]:text-foreground group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-sm group-[.is-user]:px-3 group-[.is-user]:py-2",
      "group-[.is-assistant]:text-foreground group-[.is-assistant]:w-full group-[.is-assistant]:max-w-full",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "icon-sm",
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>
          <p>{tooltip}</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return button;
};

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(null);

const useMessageBranch = () => {
  const context = use(MessageBranchContext);

  if (!context) {
    throw new Error("MessageBranch components must be used within MessageBranch");
  }

  return context;
};

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange],
  );

  const goToPrevious = useCallback(() => {
    const newBranch = currentBranch > 0 ? currentBranch - 1 : branches.length - 1;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    const newBranch = currentBranch < branches.length - 1 ? currentBranch + 1 : 0;
    handleBranchChange(newBranch);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({
      branches,
      currentBranch,
      goToNext,
      goToPrevious,
      setBranches,
      totalBranches: branches.length,
    }),
    [branches, currentBranch, goToNext, goToPrevious],
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div className={cn("grid w-full gap-2 [&>div]:pb-0", className)} {...props} />
    </MessageBranchContext.Provider>
  );
};

export type MessageBranchContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageBranchContent = ({ children, ...props }: MessageBranchContentProps) => {
  const { currentBranch, setBranches, branches } = useMessageBranch();
  const childrenArray = useMemo(
    () => (Array.isArray(children) ? children : [children]),
    [children],
  );

  // Sync branches when children change.
  useEffect(() => {
    if (branches.length !== childrenArray.length) {
      setBranches(childrenArray);
    }
  }, [childrenArray, branches, setBranches]);

  return childrenArray.map((branch, index) => (
    <div
      className={cn(
        "grid gap-2 overflow-hidden [&>div]:pb-0",
        index === currentBranch ? "block" : "hidden",
      )}
      key={branch.key}
      {...props}
    >
      {branch}
    </div>
  ));
};

export type MessageBranchSelectorProps = ComponentProps<typeof ButtonGroup>;

export const MessageBranchSelector = ({ className, ...props }: MessageBranchSelectorProps) => {
  const { totalBranches } = useMessageBranch();

  // Hide selector when only one branch.
  if (totalBranches <= 1) {
    return null;
  }

  return (
    <ButtonGroup
      className={cn(
        "[&>*:not(:first-child)]:rounded-l-md [&>*:not(:last-child)]:rounded-r-md",
        className,
      )}
      orientation="horizontal"
      {...props}
    />
  );
};

export type MessageBranchPreviousProps = ComponentProps<typeof Button>;

export const MessageBranchPrevious = ({ children, ...props }: MessageBranchPreviousProps) => {
  const { goToPrevious, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Previous branch"
      disabled={totalBranches <= 1}
      onClick={goToPrevious}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronLeft size={14} />}
    </Button>
  );
};

export type MessageBranchNextProps = ComponentProps<typeof Button>;

export const MessageBranchNext = ({ children, ...props }: MessageBranchNextProps) => {
  const { goToNext, totalBranches } = useMessageBranch();

  return (
    <Button
      aria-label="Next branch"
      disabled={totalBranches <= 1}
      onClick={goToNext}
      size="icon-sm"
      type="button"
      variant="ghost"
      {...props}
    >
      {children ?? <ChevronRight size={14} />}
    </Button>
  );
};

export type MessageBranchPageProps = HTMLAttributes<HTMLSpanElement>;

export const MessageBranchPage = ({ className, ...props }: MessageBranchPageProps) => {
  const { currentBranch, totalBranches } = useMessageBranch();

  return (
    <ButtonGroupText
      className={cn("text-muted-foreground border-none bg-transparent shadow-none", className)}
      {...props}
    >
      {currentBranch + 1} of {totalBranches}
    </ButtonGroupText>
  );
};

/** The `#392` chip. The ordinal rides in the element's own text (see
 *  `terminal-refs`), so this parses it back out of the label. A chip is only
 *  minted for a terminal that was live when the message rendered, so the miss
 *  case means it has been closed since - say so rather than no-op. */
function TerminalRefChip({ children }: { children?: ReactNode }) {
  const label = Array.isArray(children) ? children.join("") : String(children ?? "");
  const ordinal = Number(label.replace("#", ""));
  return (
    <button
      type="button"
      title={`Go to terminal ${ordinal}`}
      onClick={() => {
        if (!useChatStore.getState().live.focusTerminal(ordinal)) {
          toast(`Terminal ${ordinal} is no longer open`, { variant: "info" });
        }
      }}
      className="bg-primary/12 text-primary hover:bg-primary/25 cursor-pointer rounded px-1 font-mono font-medium"
    >
      {label}
    </button>
  );
}

/** Streamdown's own rehype set plus terminal-reference linkification. Passing
 *  `rehypePlugins` REPLACES the defaults, so they are re-spread here. Both are
 *  module-level so Streamdown sees stable identities. */
const REHYPE_PLUGINS = [
  ...Object.values(defaultRehypePlugins),
  rehypeTerminalRefs(
    () =>
      new Set(
        useChatStore
          .getState()
          .live.listTerminals()
          .map((t) => t.ordinal),
      ),
  ),
];
const MD_COMPONENTS = { ...markdownComponents, [TERM_REF_TAG]: TerminalRefChip };

export type MessageResponseProps = ComponentProps<typeof Streamdown> & {
  streaming?: boolean;
};

/**
 * Every surface that renders model-written markdown (chat replies AND tool
 * summaries). The terminal-ref wiring lives here, not at the call sites, so the
 * two cannot drift apart - `components` and `rehypePlugins` only work as a pair.
 */
export const MessageResponse = memo(
  ({ className, streaming = false, ...props }: MessageResponseProps) => (
    <ChatStreamingProvider value={streaming}>
      <Streamdown
        className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
        components={MD_COMPONENTS}
        rehypePlugins={REHYPE_PLUGINS}
        controls={{ table: false }}
        urlTransform={safeUrlTransform}
        {...props}
      />
    </ChatStreamingProvider>
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.streaming === nextProps.streaming &&
    nextProps.isAnimating === prevProps.isAnimating,
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({ className, children, ...props }: MessageToolbarProps) => (
  <div className={cn("mt-4 flex w-full items-center justify-between gap-4", className)} {...props}>
    {children}
  </div>
);
