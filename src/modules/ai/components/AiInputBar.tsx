import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { Cancel01Icon, Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion } from "motion/react";
import type { UIMessage } from "@ai-sdk/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMentionSearch } from "../hooks/useMentionSearch";
import { useComposer, type FileAttachment } from "../lib/composer";
import { recallUserMessage, type RecalledMessage } from "../lib/messageBody";
import { detectPickerTrigger, type PickerTrigger } from "../lib/pickerTrigger";
import { HASH_COMMANDS, VISIBLE_SLASH_COMMANDS } from "../lib/slashCommands";
import type { Snippet } from "../lib/snippets";
import { useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";
import { AgentSwitcher } from "./AgentSwitcher";
import { AiStatusBarControls } from "./AiStatusBarControls";
import { ChipsRow } from "./ChipsRow";
import { ContextIndicator } from "./ContextIndicator";
import { InfoModal } from "./InfoModal";
import { MentionPickerContent, type MentionItem } from "./MentionPicker";
import { OpenFilesRow } from "./OpenFilesRow";
import { QueueRow } from "./QueueRow";
import { SessionHistoryDialog } from "./SessionHistoryDialog";
import { SnippetPickerContent, type PickerItem } from "./SnippetPicker";

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

  const [trigger, setTrigger] = useState<PickerTrigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  // Shell-style ArrowUp/Down through sent user messages. `histIndex` is the
  // position in `history` (0 = newest). `null` means not navigating; stepping
  // past the newest restores the user's draft.
  //
  // Per-message parse cache. User messages aren't re-cloned after pushMessage
  // (only the streaming assistant message is replaced each token), so the user
  // refs in `messages` stay stable across the session. WeakMap keyed on the
  // message avoids re-parsing <file>/<selection> blocks on every token.
  const recallCacheRef = useRef<WeakMap<UIMessage, RecalledMessage>>(new WeakMap());
  const history = useMemo<RecalledMessage[]>(() => {
    if (!messages) return [];
    const cache = recallCacheRef.current;
    const out: RecalledMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role !== "user") continue;
      let rec = cache.get(m);
      if (!rec) {
        rec = recallUserMessage(m);
        cache.set(m, rec);
      }
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
  const histIndexRef = useRef<number | null>(null);
  const draftRef = useRef<{
    value: string;
    files: FileAttachment[];
    snippets: Snippet[];
  }>({ value: "", files: [], snippets: [] });
  const messageCount = messages?.length ?? 0;
  useEffect(() => {
    // New message or reset: clear nav cursor so the next ArrowUp starts at the newest.
    histIndexRef.current = null;
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
    setTrigger(detectPickerTrigger(c.value, el.selectionStart ?? 0));
  };

  useEffect(updateTrigger, [c.value, c.textareaRef]);

  const isMention = trigger?.kind === "mention";
  const mentionQuery = isMention ? (trigger?.query ?? "") : "";
  const mention = useMentionSearch({
    active: !!isMention,
    query: mentionQuery,
    openFiles: openEditorFiles,
  });

  const filteredItems = useMemo<PickerItem[]>(() => {
    if (!trigger || trigger.kind === "mention") return [];
    const q = trigger.query.toLowerCase();
    //   `/` -> every command
    //   `#` -> snippets plus tag-style commands (`init`, `plan`); they behave
    //          like persistent session tags, not one-shot actions.
    if (trigger.kind === "slash") {
      return VISIBLE_SLASH_COMMANDS.flatMap((command) =>
        !q || command.name.includes(q) || command.label.toLowerCase().includes(q)
          ? [{ kind: "command" as const, command }]
          : [],
      );
    }
    // trigger.kind === "hash"
    const hashCmds: PickerItem[] = HASH_COMMANDS.flatMap((command) =>
      !q || command.name.includes(q) || command.label.toLowerCase().includes(q)
        ? [{ kind: "command", command }]
        : [],
    );
    const snipItems: PickerItem[] = snippets.flatMap((snippet) =>
      !q ||
      snippet.handle.includes(q) ||
      snippet.name.toLowerCase().includes(q) ||
      snippet.description.toLowerCase().includes(q)
        ? [{ kind: "snippet", snippet }]
        : [],
    );
    return [...hashCmds, ...snipItems];
  }, [trigger, snippets]);

  /** Length of the navigable list. Drives ArrowUp/Down/Tab/Enter for any picker. */
  const navLength = isMention ? mention.items.length : filteredItems.length;

  useEffect(() => {
    if (activeIndex >= navLength) setActiveIndex(0);
  }, [navLength, activeIndex]);

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
    } else if (trigger.kind === "slash") {
      // `/cmd ` lets the user type args and hit Enter, or hit Enter for no-arg
      // commands. Leaves text in the textarea so the user can back out.
      insert = `/${item.command.name} `;
    } else {
      c.addCommand(item.command);
    }
    const after =
      item.kind === "command" && trigger.kind === "hash" ? afterRaw.replace(/^\s+/, "") : afterRaw;
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

  const onPickMention = (item: MentionItem) => {
    if (!trigger) return;
    const before = c.value.slice(0, trigger.start);
    const afterRaw = c.value.slice(trigger.end);
    // Drop the `@query` from the textarea; chips below already represent the attachment.
    const after = afterRaw.replace(/^\s+/, "");
    const sep = before && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
    c.setValue(`${before}${sep}${after}`);
    setTrigger(null);
    setActiveIndex(0);
    if (item.kind === "file") {
      void c.attachFileByPath(item.path);
    } else if (item.kind === "folder") {
      void c.attachFolderByPath(item.path);
    }
    requestAnimationFrame(() => {
      const el = c.textareaRef.current;
      if (!el) return;
      const caret = before.length + sep.length;
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

  /** Apply a history entry to the composer, or restore the draft when `entry === null`.
   *  Rebuilds attachments from recalled `<file>`/`<selection>` blocks; snippet
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
        name: s.source === "editor" ? "Editor selection" : "Terminal selection",
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
    const cur = histIndexRef.current;
    if (cur === null) {
      if (dir !== "older") return false;
      draftRef.current = {
        value: c.value,
        files: c.files,
        snippets: c.pickedSnippets,
      };
      histIndexRef.current = 0;
      applyEntry(history[0]);
      return true;
    }
    if (dir === "older") {
      const next = Math.min(cur + 1, history.length - 1);
      if (next === cur) return true; // at oldest; swallow key
      histIndexRef.current = next;
      applyEntry(history[next]);
      return true;
    }
    // newer
    if (cur === 0) {
      histIndexRef.current = null;
      applyEntry(null);
      return true;
    }
    const next = cur - 1;
    histIndexRef.current = next;
    applyEntry(history[next]);
    return true;
  };

  const pickActive = () => {
    if (isMention) {
      const it = mention.items[activeIndex];
      if (it) onPickMention(it);
      return;
    }
    const it = filteredItems[activeIndex];
    if (it) onPickItem(it);
  };

  const voiceLabel = c.voice.recording
    ? "Listening…"
    : c.voice.transcribing
      ? "Transcribing…"
      : null;

  return (
    <div className="border-border/60 bg-background/40 shrink-0 border-t p-2">
      <SessionHistoryDialog />
      <InfoModal />
      <div
        className={cn(
          "border-border bg-muted/50 flex flex-col gap-1.5 rounded-xl border px-2 py-1.5 shadow-sm",
          "focus-within:border-foreground/25 focus-within:bg-muted/70 focus-within:ring-foreground/10 transition-colors focus-within:ring-1",
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
                aria-label="Message to the agent"
                onChange={(e) => {
                  // Editing away from the historical text exits history-nav mode.
                  const cur = histIndexRef.current;
                  if (cur !== null && e.target.value !== history[cur].body) {
                    histIndexRef.current = null;
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
                      setActiveIndex((i) => Math.min(i + 1, Math.max(0, navLength - 1)));
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setActiveIndex((i) => Math.max(0, i - 1));
                      return;
                    }
                    if (e.key === "Tab" || e.key === "Enter") {
                      if (navLength > 0) {
                        e.preventDefault();
                        pickActive();
                        return;
                      }
                      // Picker open but empty/loading; swallow Enter so the
                      // half-typed `@query` doesn't reach the LLM.
                      if (isMention) {
                        e.preventDefault();
                        return;
                      }
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setTrigger(null);
                      return;
                    }
                  }
                  // Shell-style history nav. Fires only when the picker is
                  // closed and the caret is on the matching edge so multi-line
                  // editing still works.
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
                    histIndexRef.current !== null &&
                    caretOnLastLine()
                  ) {
                    if (navHistory("newer")) {
                      e.preventDefault();
                      return;
                    }
                  }
                  if (e.key === "Escape" && histIndexRef.current !== null) {
                    e.preventDefault();
                    histIndexRef.current = null;
                    applyEntry(null);
                    return;
                  }
                  if (e.key === "Enter" && !e.shiftKey) {
                    const isModEnter = e.ctrlKey || e.metaKey;
                    e.preventDefault();
                    histIndexRef.current = null;
                    if (c.isBusy) {
                      // Busy: only Ctrl/Cmd+Enter queues. Plain Enter is a
                      // no-op so key-mashing during streaming doesn't drop the draft.
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
                    : // Short enough for the narrow panel. Full hint lives in /help.
                      "Ask TEDI · / @ #"
                }
                rows={1}
                className={cn(
                  "max-h-40 flex-1 resize-none bg-transparent px-1 text-[13px] leading-relaxed outline-none",
                  "placeholder:text-muted-foreground/60",
                )}
              />
            </div>
          </PopoverAnchor>
          {isMention ? (
            <MentionPickerContent
              items={mention.items}
              activeIndex={activeIndex}
              onPick={onPickMention}
              onHover={setActiveIndex}
              loading={mention.loading}
              query={mentionQuery}
            />
          ) : (
            <SnippetPickerContent
              items={filteredItems}
              activeIndex={activeIndex}
              onPick={onPickItem}
              onHover={setActiveIndex}
              emptyText={
                trigger?.kind === "slash"
                  ? trigger.query
                    ? `No commands match "/${trigger.query}"`
                    : "Type a command name…"
                  : trigger?.query
                    ? `No snippets match "#${trigger.query}". Add snippets in Settings → Agents.`
                    : "Type a snippet handle, or add one in Settings → Agents."
              }
            />
          )}
        </Popover>

        <AnimatePresence initial={false}>
          {voiceLabel && (
            <motion.div
              key={voiceLabel}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.12 }}
              className="text-muted-foreground flex items-center gap-1.5 px-1 text-[11px]"
            >
              {c.voice.recording ? (
                <span className="bg-destructive size-1.5 animate-pulse rounded-full" />
              ) : (
                <Spinner className="size-3" />
              )}
              <span className="truncate">{voiceLabel}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bottom toolbar wraps at the group level: when narrower than
            (meta) + (action), the action group drops to a new row.
            Per-button wrapping used to cascade into 4 rows. */}
        <div className="border-border/40 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5 border-t pt-1.5">
          <div className="flex min-w-0 shrink items-center gap-1">
            <AgentSwitcher />
            {/* Hide the percent label from `ContextTrigger` so the chip stays
                compact. The ring shows usage; the hovercard has exact numbers. */}
            <div className="shrink-0 [&_button>span:first-child]:hidden">
              <ContextIndicator messages={messages ?? []} />
            </div>
          </div>
          <AiStatusBarControls />
        </div>
      </div>
    </div>
  );
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
    <div className="border-border/60 bg-card/40 shrink-0 border-t px-3 py-2">
      <div className="flex h-10 items-center justify-between gap-3 rounded-lg px-3 text-xs">
        <span className="text-muted-foreground">
          Connect any AI provider (or use local models) - your key stays in your OS keychain.
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
