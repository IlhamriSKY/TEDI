import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Clock01Icon,
  CodeIcon,
  HashtagIcon,
  Key01Icon,
  PlusSignIcon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion } from "motion/react";
import type { UIMessage } from "@ai-sdk/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { useComposer, type FileAttachment } from "../lib/composer";
import { recallUserMessage, type RecalledMessage } from "../lib/messageBody";
import { SLASH_COMMANDS } from "../lib/slashCommands";
import type { Snippet } from "../lib/snippets";
import { useChatStore, type OpenEditorFile } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";
import { AgentSwitcher } from "./AgentSwitcher";
import { ContextIndicator } from "./AiMiniWindow";
import { AiStatusBarControls } from "./AiStatusBarControls";
import { SnippetPickerContent, type PickerItem } from "./SnippetPicker";

type SnippetTrigger = {
  start: number;
  end: number;
  query: string;
};

function detectSnippetTrigger(
  value: string,
  caret: number,
): SnippetTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === "#") {
      const prev = i === 0 ? " " : value[i - 1];
      if (!/\s/.test(prev)) return null;
      const slice = value.slice(i + 1, caret);
      if (!/^[a-z0-9-]*$/i.test(slice)) return null;
      return { start: i, end: caret, query: slice.toLowerCase() };
    }
    if (/\s/.test(ch)) return null;
    if (!/[a-z0-9-]/i.test(ch)) return null;
  }
  return null;
}

export function AiInputBar({ messages }: { messages?: UIMessage[] } = {}) {
  const c = useComposer();
  const snippets = useSnippetsStore((s) => s.snippets);
  const openEditorFiles = useChatStore((s) => s.openEditorFiles);
  const promptQueue = useChatStore((s) => s.promptQueue);
  const enqueuePrompt = useChatStore((s) => s.enqueuePrompt);
  const removeQueuedPrompt = useChatStore((s) => s.removeQueuedPrompt);

  const attachedPaths = useMemo(() => {
    const set = new Set<string>();
    for (const f of c.files) {
      if (f.id.startsWith("path-")) set.add(f.id.slice("path-".length));
    }
    return set;
  }, [c.files]);

  const unattachedOpenFiles = useMemo(
    () => openEditorFiles.filter((f) => !attachedPaths.has(f.path)),
    [openEditorFiles, attachedPaths],
  );

  const [trigger, setTrigger] = useState<SnippetTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Shell-style ArrowUp/Down navigation through previously sent user messages.
  // `histIndex` is the position in `history` (0 = most recent, increasing =
  // older). `null` means we're not navigating - typing or sending exits the
  // mode and the user's draft is restored when stepping past the newest entry.
  const history = useMemo<RecalledMessage[]>(() => {
    if (!messages) return [];
    const out: RecalledMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user") continue;
      const rec = recallUserMessage(m);
      if (
        !rec.body &&
        rec.files.length === 0 &&
        rec.selections.length === 0 &&
        rec.snippetHandles.length === 0
      )
        continue;
      out.push(rec);
    }
    return out;
  }, [messages]);
  const allSnippets = useSnippetsStore((s) => s.snippets);
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const draftRef = useRef<{
    value: string;
    files: FileAttachment[];
    snippets: Snippet[];
  }>({ value: "", files: [], snippets: [] });
  const messageCount = messages?.length ?? 0;
  useEffect(() => {
    // A new message just landed (or the conversation was reset): forget the
    // current nav cursor so the next ArrowUp starts fresh from the newest.
    setHistIndex(null);
  }, [messageCount]);

  useEffect(() => {
    autoresize(c.textareaRef.current);
  }, [c.value, c.textareaRef]);

  const updateTrigger = () => {
    const el = c.textareaRef.current;
    if (!el) {
      setTrigger(null);
      return;
    }
    setTrigger(detectSnippetTrigger(c.value, el.selectionStart ?? 0));
  };

  useEffect(updateTrigger, [c.value, c.textareaRef]);

  const filteredItems = useMemo<PickerItem[]>(() => {
    if (!trigger) return [];
    const q = trigger.query;
    const cmdItems: PickerItem[] = Object.values(SLASH_COMMANDS)
      .filter(
        (c) => !q || c.name.includes(q) || c.label.toLowerCase().includes(q),
      )
      .map((command) => ({ kind: "command", command }));
    const snipItems: PickerItem[] = snippets
      .filter(
        (s) =>
          !q ||
          s.handle.includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      )
      .map((snippet) => ({ kind: "snippet", snippet }));
    return [...cmdItems, ...snipItems];
  }, [trigger, snippets]);

  useEffect(() => {
    if (activeIndex >= filteredItems.length) setActiveIndex(0);
  }, [filteredItems.length, activeIndex]);

  const pickerOpen = trigger !== null;

  const onPickItem = (item: PickerItem) => {
    if (!trigger) return;
    const before = c.value.slice(0, trigger.start);
    const afterRaw = c.value.slice(trigger.end);
    let insert = "";
    if (item.kind === "snippet") {
      const needsSpace = afterRaw.length === 0 || !/^\s/.test(afterRaw);
      insert = `#${item.snippet.handle}${needsSpace ? " " : ""}`;
      c.addSnippet(item.snippet);
    } else {
      c.addCommand(item.command);
    }
    const after =
      item.kind === "command" ? afterRaw.replace(/^\s+/, "") : afterRaw;
    c.setValue(`${before}${insert}${after}`);
    setTrigger(null);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      const caret = before.length + insert.length;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const caretOnFirstLine = (): boolean => {
    const el = c.textareaRef.current;
    if (!el) return true;
    const before = c.value.slice(0, el.selectionStart ?? 0);
    return !before.includes("\n");
  };
  const caretOnLastLine = (): boolean => {
    const el = c.textareaRef.current;
    if (!el) return true;
    const after = c.value.slice(el.selectionEnd ?? 0);
    return !after.includes("\n");
  };

  /** Apply a history entry to the composer (textarea + chips), or restore
   *  the draft snapshot when `entry === null`. Attachments are rebuilt from
   *  the recalled `<file>`/`<selection>` content so chips reappear; snippet
   *  handles are looked up in the snippets store. */
  const applyEntry = (entry: RecalledMessage | null) => {
    if (entry === null) {
      const d = draftRef.current;
      c.setValue(d.value);
      c.setAttachments(d.files);
      c.setPickedSnippets(d.snippets);
    } else {
      c.setValue(entry.body);
      const fileAtts: FileAttachment[] = entry.files.map((f, i) => ({
        id: `recall-file-${i}-${f.name}`,
        name: f.name,
        kind: "text",
        mediaType: f.mediaType,
        text: f.content,
        size: f.content.length,
      }));
      const selAtts: FileAttachment[] = entry.selections.map((s, i) => ({
        id: `recall-sel-${i}`,
        name:
          s.source === "editor" ? "Editor selection" : "Terminal selection",
        kind: "selection",
        mediaType: "text/plain",
        text: s.text,
        size: s.text.length,
        source: s.source,
      }));
      c.setAttachments([...fileAtts, ...selAtts]);
      const byHandle = new Map(allSnippets.map((s) => [s.handle, s]));
      const recalledSnips: Snippet[] = [];
      for (const h of entry.snippetHandles) {
        const s = byHandle.get(h);
        if (s) recalledSnips.push(s);
      }
      c.setPickedSnippets(recalledSnips);
    }
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      const end = el.value.length;
      el.focus();
      el.setSelectionRange(end, end);
    });
  };

  /** Returns true if the key was consumed. */
  const navHistory = (dir: "older" | "newer"): boolean => {
    if (history.length === 0) return false;
    if (histIndex === null) {
      if (dir !== "older") return false;
      draftRef.current = {
        value: c.value,
        files: c.files,
        snippets: c.pickedSnippets,
      };
      setHistIndex(0);
      applyEntry(history[0]);
      return true;
    }
    if (dir === "older") {
      const next = Math.min(histIndex + 1, history.length - 1);
      if (next === histIndex) return true; // already at oldest, swallow key
      setHistIndex(next);
      applyEntry(history[next]);
      return true;
    }
    // newer
    if (histIndex === 0) {
      setHistIndex(null);
      applyEntry(null);
      return true;
    }
    const next = histIndex - 1;
    setHistIndex(next);
    applyEntry(history[next]);
    return true;
  };

  const pickActive = () => {
    const it = filteredItems[activeIndex];
    if (it) onPickItem(it);
  };

  const voiceLabel = c.voice.recording
    ? "Listening…"
    : c.voice.transcribing
      ? "Transcribing…"
      : null;

  return (
    <div className="shrink-0 border-t border-border/60 bg-background/40 px-2 py-2">
      <div
        className={cn(
          "flex flex-col gap-1.5 rounded-xl border border-border bg-muted/50 px-2 py-1.5 shadow-sm",
          "transition-colors focus-within:border-foreground/25 focus-within:bg-muted/70 focus-within:ring-1 focus-within:ring-foreground/10",
        )}
      >
        <OpenFilesRow
          files={unattachedOpenFiles}
          onAttach={(path) => void c.attachFileByPath(path)}
        />

        <QueueRow queue={promptQueue} onRemove={removeQueuedPrompt} />

        <ChipsRow
          files={c.files}
          onRemoveFile={c.removeFile}
          snippets={c.pickedSnippets}
          onRemoveSnippet={(id) => {
            const snip = c.pickedSnippets.find((s) => s.id === id);
            c.removeSnippet(id);
            if (!snip) return;
            const re = new RegExp(`(^|\\s)#${snip.handle}\\b ?`);
            c.setValue((v) => v.replace(re, (_m, lead: string) => lead));
          }}
          commands={c.pickedCommands}
          onRemoveCommand={(name) => c.removeCommand(name)}
        />

        <Popover open={pickerOpen}>
          <PopoverAnchor asChild>
            <div className="flex items-start gap-2">
              <textarea
                ref={c.textareaRef}
                value={c.value}
                onChange={(e) => {
                  // Any edit that doesn't match the historical text exits
                  // history-nav mode so subsequent ArrowUp starts fresh from
                  // the newest entry next time the textarea is empty/aligned.
                  if (
                    histIndex !== null &&
                    e.target.value !== history[histIndex].body
                  ) {
                    setHistIndex(null);
                  }
                  c.setValue(e.target.value);
                }}
                onKeyUp={updateTrigger}
                onClick={updateTrigger}
                onSelect={updateTrigger}
                onKeyDown={(e) => {
                  if (pickerOpen) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setActiveIndex((i) =>
                        Math.min(i + 1, Math.max(0, filteredItems.length - 1)),
                      );
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setActiveIndex((i) => Math.max(0, i - 1));
                      return;
                    }
                    if (e.key === "Tab" || e.key === "Enter") {
                      if (filteredItems.length > 0) {
                        e.preventDefault();
                        pickActive();
                        return;
                      }
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setTrigger(null);
                      return;
                    }
                  }
                  // Shell-style history nav. Only fires when the picker is
                  // closed and the caret is on the matching edge (top line
                  // for ArrowUp, bottom line for ArrowDown) so multi-line
                  // editing still works as expected.
                  if (
                    e.key === "ArrowUp" &&
                    !e.shiftKey &&
                    !e.metaKey &&
                    !e.ctrlKey &&
                    !e.altKey &&
                    caretOnFirstLine()
                  ) {
                    if (navHistory("older")) {
                      e.preventDefault();
                      return;
                    }
                  }
                  if (
                    e.key === "ArrowDown" &&
                    !e.shiftKey &&
                    !e.metaKey &&
                    !e.ctrlKey &&
                    !e.altKey &&
                    histIndex !== null &&
                    caretOnLastLine()
                  ) {
                    if (navHistory("newer")) {
                      e.preventDefault();
                      return;
                    }
                  }
                  if (e.key === "Escape" && histIndex !== null) {
                    e.preventDefault();
                    setHistIndex(null);
                    applyEntry(null);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    const isModEnter = e.ctrlKey || e.metaKey;
                    e.preventDefault();
                    setHistIndex(null);
                    if (c.isBusy) {
                      // Busy: only Ctrl/Cmd+Enter queues. Plain Enter is a
                      // no-op so accidental key-mashing during streaming
                      // doesn't silently drop the user's draft.
                      if (isModEnter) {
                        const text = c.value.trim();
                        if (text) {
                          enqueuePrompt(text);
                          c.setValue("");
                        }
                      }
                      return;
                    }
                    // Idle: Enter and Ctrl/Cmd+Enter both send.
                    c.submit();
                  }
                }}
                placeholder={
                  c.isBusy
                    ? "AI is responding · Ctrl+Enter to queue"
                    : "Ask TEDI anything   -   # for snippets and commands"
                }
                rows={1}
                className={cn(
                  "max-h-40 flex-1 resize-none bg-transparent px-1 text-[13px] leading-relaxed outline-none",
                  "placeholder:text-muted-foreground/60",
                )}
              />
            </div>
          </PopoverAnchor>
          <SnippetPickerContent
            items={filteredItems}
            activeIndex={activeIndex}
            onPick={onPickItem}
            onHover={setActiveIndex}
          />
        </Popover>

        <AnimatePresence initial={false}>
          {voiceLabel && (
            <motion.div
              key={voiceLabel}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.12 }}
              className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground"
            >
              {c.voice.recording ? (
                <span className="size-1.5 animate-pulse rounded-full bg-destructive" />
              ) : (
                <Spinner className="size-3" />
              )}
              <span className="truncate">{voiceLabel}</span>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-center justify-between gap-1 border-t border-border/40 pt-1.5 [&>div]:flex-wrap">
          <div className="flex min-w-0 items-center gap-1.5">
            <AgentSwitcher />
            {messages !== undefined ? (
              <ContextIndicator messages={messages} />
            ) : null}
          </div>
          <AiStatusBarControls />
        </div>
      </div>
    </div>
  );
}

function OpenFilesRow({
  files,
  onAttach,
}: {
  files: OpenEditorFile[];
  onAttach: (path: string) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <AnimatePresence initial={false}>
        {files.map((f) => (
          <Tooltip key={`open-${f.path}`}>
            <TooltipTrigger asChild>
              <motion.button
                type="button"
                layout
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ duration: 0.12 }}
                onClick={() => onAttach(f.path)}
                aria-label={`Attach ${f.name}`}
                className={cn(
                  "group flex cursor-pointer items-center gap-1 rounded-md border border-dashed border-border/60 bg-transparent px-1.5 py-0.5 text-[11px] text-muted-foreground",
                  "transition-colors hover:border-foreground/40 hover:bg-card hover:text-foreground",
                )}
              >
                <HugeiconsIcon
                  icon={PlusSignIcon}
                  size={10}
                  strokeWidth={2}
                  className="opacity-70 transition-opacity group-hover:opacity-100"
                />
                <span className="max-w-35 truncate">{f.name}</span>
              </motion.button>
            </TooltipTrigger>
            <TooltipContent side="top">{`Click to attach ${f.path}`}</TooltipContent>
          </Tooltip>
        ))}
      </AnimatePresence>
    </div>
  );
}

function ChipsRow({
  files,
  onRemoveFile,
  snippets,
  onRemoveSnippet,
  commands,
  onRemoveCommand,
}: {
  files: FileAttachment[];
  onRemoveFile: (id: string) => void;
  snippets: Snippet[];
  onRemoveSnippet: (id: string) => void;
  commands: { name: string; label: string; icon: typeof HashtagIcon }[];
  onRemoveCommand: (name: string) => void;
}) {
  if (files.length === 0 && snippets.length === 0 && commands.length === 0)
    return null;
  return (
    <div className="flex flex-wrap gap-1">
      <AnimatePresence initial={false}>
        {commands.map((cmd) => (
          <Tooltip key={`cmd-${cmd.name}`}>
            <TooltipTrigger asChild>
              <motion.div
                layout
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ duration: 0.12 }}
                className="group flex items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 py-0.5 text-[11px]"
              >
                <HugeiconsIcon
                  icon={cmd.icon}
                  size={11}
                  strokeWidth={1.75}
                  className="text-muted-foreground"
                />
                <span className="font-medium">#{cmd.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveCommand(cmd.name)}
                  className="ml-0.5 cursor-pointer rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  aria-label="Remove command"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
                </button>
              </motion.div>
            </TooltipTrigger>
            <TooltipContent side="top">{cmd.label}</TooltipContent>
          </Tooltip>
        ))}
        {snippets.map((s) => (
          <Tooltip key={`snip-${s.id}`}>
            <TooltipTrigger asChild>
              <motion.div
                layout
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ duration: 0.12 }}
                className="group flex items-center gap-1 rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary"
              >
                <HugeiconsIcon
                  icon={HashtagIcon}
                  size={11}
                  strokeWidth={2}
                  className="opacity-80"
                />
                <span className="font-medium">{s.handle}</span>
                <button
                  type="button"
                  onClick={() => onRemoveSnippet(s.id)}
                  className="ml-0.5 cursor-pointer rounded p-0.5 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  aria-label="Remove snippet"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
                </button>
              </motion.div>
            </TooltipTrigger>
            <TooltipContent side="top">{s.description || s.name}</TooltipContent>
          </Tooltip>
        ))}
        {files.map((f) => (
          <motion.div
            key={f.id}
            layout
            initial={{ opacity: 0, scale: 0.92 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ duration: 0.12 }}
            className="group flex items-center gap-1 rounded-md border border-border/60 bg-card px-1.5 py-0.5 text-[11px]"
          >
            {f.kind === "image" && f.url ? (
              <img src={f.url} alt="" className="size-4 rounded object-cover" />
            ) : f.kind === "selection" ? (
              <HugeiconsIcon
                icon={f.source === "editor" ? CodeIcon : TerminalIcon}
                size={11}
                strokeWidth={1.75}
                className="text-muted-foreground"
              />
            ) : (
              <img
                src={fileIconUrl(f.name)}
                alt=""
                aria-hidden
                className="size-3.5 shrink-0"
              />
            )}
            <span className="max-w-35 truncate">
              {f.name}
              {f.kind === "selection" && f.text ? (
                <span className="ml-1 text-muted-foreground">
                  · {selLineCount(f.text)}L
                </span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => onRemoveFile(f.id)}
              className="ml-0.5 cursor-pointer rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
              aria-label="Remove"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function QueueRow({
  queue,
  onRemove,
}: {
  queue: { id: string; text: string }[];
  onRemove: (id: string) => void;
}) {
  if (queue.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <HugeiconsIcon
        icon={Clock01Icon}
        size={10}
        strokeWidth={2}
        className="shrink-0 text-muted-foreground"
      />
      <AnimatePresence initial={false}>
        {queue.map((q) => (
          <Tooltip key={q.id}>
            <TooltipTrigger asChild>
              <motion.div
                layout
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ duration: 0.12 }}
                className="group flex max-w-60 items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px]"
              >
                <span className="truncate text-foreground/90">{q.text}</span>
                <button
                  type="button"
                  onClick={() => onRemove(q.id)}
                  className="ml-0.5 cursor-pointer rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  aria-label="Remove from queue"
                >
                  <HugeiconsIcon icon={Cancel01Icon} size={10} strokeWidth={2} />
                </button>
              </motion.div>
            </TooltipTrigger>
            <TooltipContent side="top">{q.text}</TooltipContent>
          </Tooltip>
        ))}
      </AnimatePresence>
    </div>
  );
}

function selLineCount(text: string): number {
  if (!text) return 0;
  const trimmed = text.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}

function autoresize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

export type AiInputBarProps = { tabId: number };

export function AiInputBarConnect({ onAdd }: { onAdd: () => void }) {
  const closePanel = useChatStore((s) => s.closePanel);
  return (
    <div className="shrink-0 border-t border-border/60 bg-card/40 px-3 py-2">
      <div className="flex h-10 items-center justify-between gap-3 rounded-lg px-3 text-xs">
        <span className="text-muted-foreground">
          Connect any AI provider (or use local models) - your key stays in your
          OS keychain.
        </span>
        <div className="flex items-center gap-1">
          <Button size="xs" onClick={onAdd}>
            <HugeiconsIcon icon={Key01Icon} />
            Add API key
          </Button>
          <IconTooltip label="Dismiss" side="top">
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={closePanel}
              aria-label="Dismiss"
              className="hover:bg-destructive/10 hover:text-destructive"
            >
              <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
            </Button>
          </IconTooltip>
        </div>
      </div>
    </div>
  );
}
