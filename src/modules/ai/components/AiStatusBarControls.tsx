import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Kbd } from "@/components/ui/kbd";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtShortcut, MOD_KEY } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useRef } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { APPROVAL_MODE_SEND } from "../lib/approvalModeStyle";
import { ACCEPTED_FILES, useComposer } from "../lib/composer";
import { useChatStore } from "../store/chatStore";
import { ModelDropdown } from "./ModelDropdown";
import { ReasoningDropdown } from "./ReasoningDropdown";
import { CircleStop, Mic, Plus, Send, Sparkles } from "lucide-react";

export function AiOpenButton({ onToggle, active }: { onToggle: () => void; active: boolean }) {
  const tooltipLabel = (
    <span className="inline-flex items-center gap-1.5">
      <span>{active ? "Close AI agent" : "Open AI agent"}</span>
      <Kbd className="h-4 min-w-4 px-1">{fmtShortcut(MOD_KEY, "I")}</Kbd>
    </span>
  );
  return (
    <IconTooltip label={tooltipLabel} side="top">
      <button
        type="button"
        onClick={onToggle}
        aria-label={active ? "Close AI agent" : "Open AI agent"}
        aria-pressed={active}
        className={cn(
          "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors",
          active ? "text-foreground bg-accent/60" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Sparkles size={16} strokeWidth={1.75} className="shrink-0" />
      </button>
    </IconTooltip>
  );
}

export function AiStatusBarControls() {
  const c = useComposer();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const enqueuePrompt = useChatStore((s) => s.enqueuePrompt);
  // The Send button carries the active approval-mode color (ask=amber,
  // semi=blue, full-auto=green) so the autonomy level reads from the one
  // control the user looks at before sending.
  const approvalMode = usePreferencesStore((s) => s.approvalMode);
  const sendTone = APPROVAL_MODE_SEND[approvalMode];

  const interruptAndSend = () => {
    const text = c.value.trim();
    if (!text) return;
    enqueuePrompt(text);
    c.setValue("");
    c.stop();
  };
  const addToQueue = () => {
    const text = c.value.trim();
    if (!text) return;
    enqueuePrompt(text);
    c.setValue("");
  };

  return (
    // min-w-0 (not shrink-0) so the group can shrink to its row when the panel
    // is narrow; only the ModelDropdown gives up width (see its `shrink`), the
    // fixed buttons keep Send pinned at the right edge instead of clipping it.
    // ml-auto keeps the group flush-right on BOTH the shared row and, once the
    // toolbar wraps, its own row (justify-between would otherwise flush a lone
    // wrapped item to the left, pulling Send off the bottom-right).
    <div className="ml-auto flex min-w-0 items-center gap-0.5">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_FILES}
        aria-label="Attach files"
        className="hidden"
        onChange={(e) => {
          void c.addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      <IconBtn title="Attach file or image" onClick={() => fileInputRef.current?.click()}>
        <Plus size={13} strokeWidth={2} />
      </IconBtn>

      {c.voice.supported && (
        <IconBtn
          title={
            !c.voice.hasKey
              ? "Voice needs an OpenAI key"
              : c.voice.recording
                ? "Stop & transcribe"
                : c.voice.transcribing
                  ? "Transcribing…"
                  : "Voice input"
          }
          onClick={() => (c.voice.recording ? c.voice.stop() : void c.voice.start())}
          disabled={c.isBusy || c.voice.transcribing || !c.voice.hasKey}
          className={cn(
            c.voice.recording && "bg-destructive/10 text-destructive hover:bg-destructive/15",
          )}
        >
          {c.voice.recording ? (
            <span className="bg-destructive size-2 animate-pulse rounded-full" />
          ) : c.voice.transcribing ? (
            <Spinner className="size-3" />
          ) : (
            <Mic size={13} strokeWidth={2} />
          )}
        </IconBtn>
      )}

      <ModelDropdown />

      {/* Renders nothing unless the selected model has a real reasoning
          parameter, so the toolbar gains no width for models without one. */}
      <ReasoningDropdown />

      <span className="bg-border mx-1 h-5 w-px" aria-hidden />

      {c.isActive ? (
        <>
          <IconBtn
            title={
              c.isBusy ? "Stop" : c.value.trim() ? "Cancel run" : "Cancel run (clears agent state)"
            }
            onClick={c.stop}
          >
            <CircleStop size={13} strokeWidth={2} />
          </IconBtn>
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!c.value.trim()}
                    className={cn("h-6 gap-1 rounded-md px-2 text-[11px]", sendTone)}
                    aria-label="Send options"
                  >
                    <Send size={12} strokeWidth={2} />
                    Send
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="top">Send options</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem
                onClick={interruptAndSend}
                disabled={!c.value.trim()}
                className="flex flex-col items-start gap-0.5 py-1.5"
              >
                <span className="text-[11.5px] font-medium">Send now (interrupt)</span>
                <span className="text-muted-foreground text-[10.5px]">
                  Stop the current run, then send this
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={addToQueue}
                disabled={!c.value.trim()}
                className="flex flex-col items-start gap-0.5 py-1.5"
              >
                <span className="flex items-center gap-1.5 text-[11.5px] font-medium">
                  Add to queue
                  <Kbd className="h-3.5 gap-px px-1 font-mono text-[9.5px]">
                    {fmtShortcut(MOD_KEY, "Enter")}
                  </Kbd>
                </span>
                <span className="text-muted-foreground text-[10.5px]">
                  Run after the current finishes
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ) : (
        <IconTooltip label="Send (Enter)" side="top">
          <Button
            type="button"
            size="sm"
            onClick={c.submit}
            disabled={!c.canSend}
            className={cn("h-6 gap-1 rounded-md px-2 text-[11px]", sendTone)}
            aria-label="Send (Enter)"
          >
            <Send size={12} strokeWidth={2} />
            Send
          </Button>
        </IconTooltip>
      )}
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <IconTooltip label={title} side="top">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={title}
        onClick={onClick}
        disabled={disabled}
        className={cn("text-muted-foreground hover:text-foreground size-6 rounded-md", className)}
      >
        {children}
      </Button>
    </IconTooltip>
  );
}
