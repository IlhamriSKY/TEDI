import { invoke } from "@tauri-apps/api/core";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { tryGetModel } from "../config";
import { useWhisperRecording } from "../hooks/useWhisperRecording";
import type { TediUserMetadata } from "./messageBody";
import { expandSnippetTokens, type Snippet } from "../lib/snippets";
import { tryRunSlashCommand, type SlashCommandMeta } from "./slashCommands";
import { toast } from "@/components/ui/toast";
import { getOrCreateChat, openSendCheckpoint, useChatStore } from "../store/chatStore";
import { useSnippetsStore } from "../store/snippetsStore";

export type FileAttachment = {
  id: string;
  name: string;
  kind: "image" | "text" | "selection";
  mediaType: string;
  url?: string;
  text?: string;
  size: number;
  /** For kind === "selection": which surface it came from. */
  source?: "terminal" | "editor";
};

type MessagePart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; url: string; filename?: string };

export const MAX_TEXT_INLINE = 200_000;
export const ACCEPTED_FILES =
  "image/*,.txt,.md,.json,.yaml,.yml,.toml,.sh,.zsh,.bash,.py,.js,.jsx,.ts,.tsx,.rs,.go,.java,.c,.cpp,.h,.hpp,.html,.css,.csv,.log,.env,.config,.conf,.ini,Dockerfile,.dockerfile";

type Voice = ReturnType<typeof useWhisperRecording>;

type ComposerCtx = {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  setValue: React.Dispatch<React.SetStateAction<string>>;
  files: FileAttachment[];
  addFiles: (list: FileList | null) => Promise<void>;
  /** Attach a file by absolute path - used by the file explorer's "Attach to Agent". */
  attachFileByPath: (path: string) => Promise<void>;
  /** Attach a directory snapshot (one-level listing) by absolute path. Returns
   *  false if the read failed (path missing, permission, sensitive root, …). */
  attachFolderByPath: (path: string) => Promise<boolean>;
  removeFile: (id: string) => void;
  /** Replace the full attachment list. Used by ArrowUp/Down history recall
   *  to swap in the attachments that were sent with a previous message. */
  setAttachments: (files: FileAttachment[]) => void;
  pickedSnippets: Snippet[];
  addSnippet: (s: Snippet) => void;
  removeSnippet: (id: string) => void;
  /** Replace the full picked-snippet list (history recall). */
  setPickedSnippets: (snippets: Snippet[]) => void;
  pickedCommands: SlashCommandMeta[];
  addCommand: (c: SlashCommandMeta) => void;
  removeCommand: (name: string) => void;
  isBusy: boolean;
  /** True whenever the agent is in any non-idle state (thinking, streaming,
   *  awaiting an approval, or post-error). Drives the Stop button so the
   *  user can always interrupt — including when a stuck approval card or a
   *  post-error stream-handle is hiding the regular Send button. */
  isActive: boolean;
  submit: () => void;
  stop: () => void;
  voice: Voice;
  canSend: boolean;
};

const Ctx = createContext<ComposerCtx | null>(null);

export function useComposer(): ComposerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useComposer must be used inside <AiComposerProvider>");
  return ctx;
}

type ProviderProps = {
  children: React.ReactNode;
};

export function AiComposerProvider({ children }: ProviderProps) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const status = useChatStore((s) => s.agentMeta.status);
  const isBusy = status === "thinking" || status === "streaming";
  // Active = anything but `idle`. Includes `awaiting-approval` and `error`
  // so the Stop button stays reachable when a hung approval card or post-
  // error stream handle would otherwise leave the user with no way to
  // cancel.
  const isActive = status !== "idle";
  const queueLen = useChatStore((s) => s.promptQueue.length);
  const consumeNextQueuedPrompt = useChatStore((s) => s.consumeNextQueuedPrompt);

  const [value, setValue] = useState("");
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [pickedSnippets, setPickedSnippets] = useState<Snippet[]>([]);
  const [pickedCommands, setPickedCommands] = useState<SlashCommandMeta[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset composer state whenever the active session changes (e.g. user ran
  // `/new`, picked a different session in the history dialog, or switched
  // sessions externally). Without this, attachments/snippets from the prior
  // session linger and silently get sent with the next message in the new
  // session — surprising and easy to miss.
  const lastSessionIdRef = useRef<string | null>(sessionId);
  useEffect(() => {
    if (lastSessionIdRef.current === sessionId) return;
    lastSessionIdRef.current = sessionId;
    setValue("");
    setFiles([]);
    setPickedSnippets([]);
    setPickedCommands([]);
  }, [sessionId]);

  // Auto-fire next queued prompt when the agent settles. Awaiting-approval
  // counts as "busy" - we never bypass a pending approval just to drain the
  // queue. Sending a queued message sets the chat busy again, which puts the
  // effect back to sleep until the next idle window.
  //
  // `firingRef` is a latch: chat status updates lag a few ticks behind a
  // `sendMessage` call, so without it the effect could re-fire on the
  // queueLen change before isBusy flips to true and drain the whole queue
  // in one render pass.
  const firingRef = useRef(false);
  useEffect(() => {
    if (isBusy) {
      firingRef.current = false;
      return;
    }
    if (status === "awaiting-approval") return;
    if (firingRef.current) return;
    if (queueLen === 0) return;
    if (!sessionId) return;
    // Open the checkpoint FIRST. If the session is mid-restore, leave the
    // queued item in the queue so it survives across the restore window —
    // consuming before the checkpoint passes would permanently drop the
    // prompt on a transient race.
    if (!openSendCheckpoint(sessionId)) {
      // The effect will re-fire after `restoringSessions` clears (state
      // changes trigger a re-render through the existing dependencies).
      return;
    }
    const next = consumeNextQueuedPrompt();
    if (!next) return;
    firingRef.current = true;
    const chat = getOrCreateChat(sessionId);
    void chat.sendMessage({ text: next.text });
  }, [isBusy, status, queueLen, sessionId, consumeNextQueuedPrompt]);

  const focusSignal = useChatStore((s) => s.focusSignal);
  const pendingPrefill = useChatStore((s) => s.pendingPrefill);
  const consumePrefill = useChatStore((s) => s.consumePrefill);
  const pendingSelections = useChatStore((s) => s.pendingSelections);
  const consumeSelections = useChatStore((s) => s.consumeSelections);

  useEffect(() => {
    if (focusSignal === 0) return;
    textareaRef.current?.focus();
    if (pendingPrefill != null) {
      const text = consumePrefill();
      if (text) setValue((v) => (v ? `${text}${v}` : text));
    }
  }, [focusSignal, pendingPrefill, consumePrefill]);

  // Listen for explorer's "Attach to Agent" event.
  useEffect(() => {
    const onAttach = (e: Event) => {
      const path = (e as CustomEvent<string>).detail;
      if (typeof path === "string" && path.length > 0) {
        void attachFileByPath(path);
      }
    };
    window.addEventListener("tedi:ai-attach-file", onAttach);
    return () => window.removeEventListener("tedi:ai-attach-file", onAttach);
    // attachFileByPath is stable for our purposes (closes over setFiles only)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (pendingSelections.length === 0) return;
    const drained = consumeSelections();
    if (drained.length === 0) return;
    setFiles((prev) => {
      const existing = new Set(prev.map((f) => f.id));
      const next: FileAttachment[] = [];
      for (const sel of drained) {
        if (existing.has(sel.id)) continue;
        next.push({
          id: sel.id,
          name: sel.source === "editor" ? "Editor selection" : "Terminal selection",
          kind: "selection",
          mediaType: "text/plain",
          text: sel.text,
          size: sel.text.length,
          source: sel.source,
        });
      }
      return next.length ? [...prev, ...next] : prev;
    });
  }, [pendingSelections, consumeSelections]);

  const voice = useWhisperRecording({
    onResult: (transcript: string) => {
      setValue((v) => (v ? `${v} ${transcript}` : transcript));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
  });

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    const next: FileAttachment[] = [];
    for (const f of Array.from(list)) {
      const att = await readAttachment(f);
      if (att) next.push(att);
    }
    if (next.length) setFiles((prev) => [...prev, ...next]);
  };

  const removeFile = (id: string) => setFiles((prev) => prev.filter((f) => f.id !== id));

  const addSnippet = (s: Snippet) =>
    setPickedSnippets((prev) => (prev.some((p) => p.id === s.id) ? prev : [...prev, s]));
  const removeSnippet = (id: string) =>
    setPickedSnippets((prev) => prev.filter((s) => s.id !== id));

  const addCommand = (cmd: SlashCommandMeta) =>
    setPickedCommands((prev) => (prev.some((p) => p.name === cmd.name) ? prev : [...prev, cmd]));
  const removeCommand = (name: string) =>
    setPickedCommands((prev) => prev.filter((c) => c.name !== name));

  const attachFileByPath = async (path: string) => {
    try {
      type ReadResult =
        | { kind: "text"; content: string; size: number }
        | { kind: "binary"; size: number }
        | { kind: "toolarge"; size: number; limit: number };
      const result = await invoke<ReadResult>("fs_read_file", { path });
      if (result.kind !== "text") {
        // Binary/oversize files: skip (could surface a toast in future).
        console.warn("attachFileByPath: skipped non-text file", path, result);
        return;
      }
      const name = normalizeBasename(path);
      const id = `path-${path}`;
      setFiles((prev) => {
        if (prev.some((f) => f.id === id)) return prev;
        const att: FileAttachment = {
          id,
          name,
          kind: "text",
          mediaType: "text/plain",
          text: result.content,
          size: result.size,
        };
        return [...prev, att];
      });
      // Open the AI panel & focus the input so the user sees the chip.
      useChatStore.getState().focusInput();
    } catch (e) {
      console.error("attachFileByPath failed:", e);
    }
  };

  const attachFolderByPath = async (path: string): Promise<boolean> => {
    try {
      type DirEntry = { name: string; kind: "file" | "dir" | "symlink"; size: number };
      const entries = await invoke<DirEntry[]>("fs_read_dir", { path });
      const lines: string[] = [];
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        lines.push(e.kind === "dir" ? `${e.name}/` : e.name);
      }
      const body = lines.length === 0 ? "(empty)" : lines.join("\n");
      const name = `${normalizeBasename(path)}/`;
      const id = `folder-${path}`;
      setFiles((prev) => {
        if (prev.some((f) => f.id === id)) return prev;
        const att: FileAttachment = {
          id,
          name,
          kind: "text",
          mediaType: "text/directory",
          text: `Directory listing of ${path}:\n${body}`,
          size: body.length,
        };
        return [...prev, att];
      });
      useChatStore.getState().focusInput();
      return true;
    } catch (e) {
      console.error("attachFolderByPath failed:", e);
      return false;
    }
  };

  const submit = () => {
    if (isBusy) return;
    const trimmed = value.trim();
    if (
      !trimmed &&
      files.length === 0 &&
      pickedSnippets.length === 0 &&
      pickedCommands.length === 0
    )
      return;

    // Slash-command interception.
    //
    // Two input shapes feed this:
    //   - Raw text starting with `/cmd` or `#cmd` (user typed it)
    //   - Hash chips from the # picker (`#init`, `#plan`) accumulated in
    //     `pickedCommands`. Multiple chips can stack and ALL must fire.
    //
    // Each command source is either `handled` (a side effect like toggling
    // plan mode) or `send-prompt` (rewrites the message body, e.g. `#init`).
    // We fire every handled source, and use the first send-prompt source as
    // the effective body — only one source can rewrite the prompt, the rest
    // remain fire-and-forget.
    let effectiveText = trimmed;
    let commandMarker: string | null = null;
    let textConsumedByCommand = false;
    let sendPromptApplied = false;
    let toastMsg: string | undefined;
    let toastVariant: "success" | "info" | "warning" | "error" | undefined;

    if (trimmed.startsWith("/") || trimmed.startsWith("#")) {
      const outcome = tryRunSlashCommand(trimmed);
      if (outcome.kind === "handled") {
        textConsumedByCommand = true;
        effectiveText = "";
        if (outcome.toast) toastMsg = outcome.toast;
        if (outcome.toastVariant) toastVariant = outcome.toastVariant;
      } else if (outcome.kind === "send-prompt") {
        sendPromptApplied = true;
        effectiveText = outcome.prompt;
        if (outcome.commandName) {
          commandMarker = `<tedi-command name="${outcome.commandName}" />`;
        }
      }
    }

    for (const cmd of pickedCommands) {
      const outcome = tryRunSlashCommand(`#${cmd.name}`);
      if (outcome.kind === "handled") {
        if (outcome.toast) toastMsg = outcome.toast;
        if (outcome.toastVariant) toastVariant = outcome.toastVariant;
        continue;
      }
      if (outcome.kind === "send-prompt") {
        // First send-prompt wins as the body. Subsequent ones are dropped:
        // the user can't `#init` twice in one message.
        if (!sendPromptApplied) {
          sendPromptApplied = true;
          effectiveText = outcome.prompt;
          if (outcome.commandName) {
            commandMarker = `<tedi-command name="${outcome.commandName}" />`;
          }
        }
      }
    }

    // Everything was consumed by handled side effects (no body, no other
    // attachments either) — nothing to actually send. Covers:
    //   - user typed only `/clear` (textConsumedByCommand=true) with nothing else
    //   - user has only `#plan` chip(s) and an empty textarea
    const anyCommandRan = textConsumedByCommand || pickedCommands.length > 0;
    if (
      anyCommandRan &&
      !sendPromptApplied &&
      effectiveText === "" &&
      files.length === 0 &&
      pickedSnippets.length === 0
    ) {
      setValue("");
      setPickedCommands([]);
      if (toastMsg) toast(toastMsg, { variant: toastVariant ?? "info" });
      return;
    }

    const parts: MessagePart[] = [];
    const fileBlocks = files
      .filter((f) => f.kind === "text")
      .map((f) => `<file name="${f.name}" mediaType="${f.mediaType}">\n${f.text ?? ""}\n</file>`);
    const selectionBlocks = files
      .filter((f) => f.kind === "selection")
      .map((f) => `<selection source="${f.source ?? "terminal"}">\n${f.text ?? ""}\n</selection>`);
    const { body: bodyAfterTokens, blocks: snippetBlocks } = expandSnippetTokens(
      effectiveText,
      useSnippetsStore.getState().snippets,
    );
    const seenHandles = new Set<string>();
    const allSnippetBlocks: string[] = [];
    for (const s of pickedSnippets) {
      if (seenHandles.has(s.handle)) continue;
      seenHandles.add(s.handle);
      allSnippetBlocks.push(`<snippet name="${s.handle}">\n${s.content}\n</snippet>`);
    }
    for (const block of snippetBlocks) {
      const m = block.match(/^<snippet name="([^"]+)"/);
      if (m && seenHandles.has(m[1])) continue;
      if (m) seenHandles.add(m[1]);
      allSnippetBlocks.push(block);
    }
    const composed = [
      commandMarker ?? "",
      allSnippetBlocks.join("\n\n"),
      selectionBlocks.join("\n\n"),
      fileBlocks.join("\n\n"),
      bodyAfterTokens,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (composed) parts.push({ type: "text", text: composed });

    for (const f of files) {
      if (f.kind === "image" && f.url) {
        parts.push({
          type: "file",
          mediaType: f.mediaType,
          url: f.url,
          filename: f.name,
        });
      }
    }

    if (!sessionId) return;
    const chat = getOrCreateChat(sessionId);
    if (!openSendCheckpoint(sessionId)) {
      // Restore in progress - silently drop this submit. The user can
      // retry after restore finishes (button auto-disables, restore is
      // sub-second for typical turns).
      return;
    }
    const { selectedModelId: modelId, selectedProvider: provider } = useChatStore.getState();
    const modelInfo = tryGetModel(modelId);
    // `selectedProvider` is the source of truth for the gateway tag - it's
    // set by the dropdown pick, so collisions in the model registry (e.g.
    // SumoPod and OpenAI-Compatible both detecting the same id) can't mis-
    // label the chip. tryGetModel is consulted for the display label and
    // the raw `owned_by` (so a mimo proxied via xiaomimimo is credited
    // to Xiaomi, not the generic "OpenAI Compatible" gateway).
    const metadata: TediUserMetadata = {
      tediModel: modelId,
      tediModelLabel: modelInfo?.label ?? modelId,
      tediProvider: provider,
      tediOwnedBy: modelInfo?.ownedBy,
      sentAt: Date.now(),
    };
    void chat.sendMessage({ role: "user", parts, metadata } as Parameters<
      typeof chat.sendMessage
    >[0]);
    setValue("");
    setFiles([]);
    setPickedSnippets([]);
    setPickedCommands([]);
  };

  const stop = () => {
    if (!sessionId) return;
    void getOrCreateChat(sessionId).stop();
    // Reset transient agent meta — clears `error` / `step` so a hung error
    // banner or stale step label doesn't linger after the user cancels.
    useChatStore.getState().resetAgentMeta();
  };

  const canSend =
    !isBusy &&
    (value.trim().length > 0 ||
      files.length > 0 ||
      pickedSnippets.length > 0 ||
      pickedCommands.length > 0);

  const ctx: ComposerCtx = {
    textareaRef,
    value,
    setValue,
    files,
    addFiles,
    attachFileByPath,
    attachFolderByPath,
    isActive,
    removeFile,
    setAttachments: setFiles,
    pickedSnippets,
    addSnippet,
    removeSnippet,
    setPickedSnippets,
    pickedCommands,
    addCommand,
    removeCommand,
    isBusy,
    submit,
    stop,
    voice,
    canSend,
  };

  return <Ctx.Provider value={ctx}>{children}</Ctx.Provider>;
}

function normalizeBasename(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const trimmed = norm.endsWith("/") ? norm.slice(0, -1) : norm;
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

async function readAttachment(file: File): Promise<FileAttachment | null> {
  const id = `${file.name}-${file.size}-${file.lastModified}`;
  if (file.type.startsWith("image/")) {
    const url = await readAsDataURL(file);
    return {
      id,
      name: file.name,
      kind: "image",
      mediaType: file.type || "image/png",
      url,
      size: file.size,
    };
  }
  if (file.size > MAX_TEXT_INLINE) return null;
  const text = await file.text();
  return {
    id,
    name: file.name,
    kind: "text",
    mediaType: file.type || "text/plain",
    text,
    size: file.size,
  };
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
