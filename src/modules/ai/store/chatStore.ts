import { Chat, type UIMessage } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { create } from "zustand";
import {
  DEFAULT_MODEL_ID,
  providerNeedsKey,
  tryGetModel,
  type DynamicModelId,
  type ProviderId,
} from "../config";

/** Treat unknown model ids as SumoPod - they only appear when the user
 *  picked a runtime-detected SumoPod model and the registry hasn't yet
 *  been re-hydrated (e.g. cold reload before /v1/models resolves). */
function resolveProvider(modelId: DynamicModelId): ProviderId {
  return tryGetModel(modelId)?.provider ?? "sumopod";
}
import { usePreferencesStore } from "@/modules/settings/preferences";
import { BUILTIN_AGENTS } from "../lib/agents";
import {
  discardCheckpoint,
  openCheckpoint,
  restoreCheckpoint,
  type RestoreOutcome,
} from "../lib/checkpoint";
import { useAgentsStore } from "./agentsStore";
import { usePlanStore } from "./planStore";
import { useTodosStore } from "./todoStore";
import { EMPTY_PROVIDER_KEYS, type ProviderKeys } from "../lib/keyring";
import {
  deleteSessionData,
  deriveTitle,
  loadAll,
  loadMessages,
  newSessionId,
  saveActiveId,
  saveMessages,
  saveSessionsList,
  type SessionMeta,
} from "../lib/sessions";
import { createContextAwareTransport } from "../lib/transport";
import type { ToolContext } from "../tools/tools";

type Live = {
  getCwd: () => string | null;
  getTerminalContext: (lines?: number) => string | null;
  injectIntoActivePty: (text: string) => boolean;
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  openPreview: (url: string) => boolean;
  /** Open a new terminal tab. Optional cwd overrides the inherited cwd.
   *  Returns true if a new tab was created. */
  openTerminal: (cwd?: string | null) => boolean;
  /** Inject `command` into the active terminal AND submit (CR). Returns
   *  false if there is no active terminal tab to run in. Use this when
   *  the user asked the AI to "run X in the terminal" - the command and
   *  its output stay in the terminal the user is looking at, not the
   *  hidden agent shell. */
  runInActiveTerminal: (command: string) => boolean;
};

export type AgentRunStatus = "idle" | "thinking" | "streaming" | "awaiting-approval" | "error";

/** Cumulative token usage for the active session. Reset on session
 *  switch / clear. `cached` is the chunk of `input` that hit the
 *  provider's prompt cache - the higher the ratio, the cheaper the run. */
export type SessionUsage = {
  input: number;
  output: number;
  cached: number;
};

export type AgentMeta = {
  status: AgentRunStatus;
  step: string | null;
  approvalsPending: number;
  error: string | null;
  usage: SessionUsage;
};

const ZERO_USAGE: SessionUsage = { input: 0, output: 0, cached: 0 };

const IDLE_META: AgentMeta = {
  status: "idle",
  step: null,
  approvalsPending: 0,
  error: null,
  usage: ZERO_USAGE,
};

export type MiniState = {
  open: boolean;
};

export type PendingSelection = {
  id: string;
  text: string;
  source: "terminal" | "editor";
};

export type OpenEditorFile = {
  /** Absolute path - used as the unique key and passed to attachFileByPath. */
  path: string;
  /** Display name (basename of the path). */
  name: string;
};

export type QueuedPrompt = {
  id: string;
  text: string;
  enqueuedAt: number;
};

export type ApprovalResponder = (approvalId: string, approved: boolean) => void;

type StoreState = {
  live: Live;
  setLive: (live: Live) => void;

  /**
   * Set by AgentRunBridge each render. Lets surfaces outside the chat hook
   * tree (e.g. the AI diff tab in the editor area) resolve a pending tool
   * approval through the active session's `addToolApprovalResponse`.
   */
  approvalResponder: ApprovalResponder | null;
  setApprovalResponder: (fn: ApprovalResponder | null) => void;
  respondToApproval: (approvalId: string, approved: boolean) => void;

  apiKeys: ProviderKeys;
  setApiKeys: (keys: ProviderKeys) => void;
  setApiKey: (provider: ProviderId, key: string | null) => void;

  selectedModelId: DynamicModelId;
  /** Provider the user picked alongside selectedModelId. Resolves the
   *  "two providers detected the same model id" race - whichever the user
   *  actually selected in the dropdown wins, regardless of refresh order. */
  selectedProvider: ProviderId;
  setSelectedModelId: (id: DynamicModelId, provider?: ProviderId) => void;

  mini: MiniState;
  openMini: () => void;
  closeMini: () => void;
  toggleMini: () => void;

  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;

  focusSignal: number;
  pendingPrefill: string | null;
  focusInput: (prefill?: string | null) => void;
  consumePrefill: () => string | null;

  pendingSelections: PendingSelection[];
  attachSelection: (text: string, source: "terminal" | "editor") => void;
  consumeSelections: () => PendingSelection[];

  /** Files currently open in editor leaves. Mirrors `useTabs` state; updated
   *  by App.tsx alongside `setLive`. Surfaced as suggestion chips above the
   *  AI input - clicking one promotes it to an actual attachment. */
  openEditorFiles: OpenEditorFile[];
  setOpenEditorFiles: (files: OpenEditorFile[]) => void;

  /** Prompts queued via Ctrl/Cmd+Enter while the agent is busy. They fire
   *  one-by-one as the agent returns to idle. Text-only - attachments and
   *  snippets are bound to the active composer state at send time. */
  promptQueue: QueuedPrompt[];
  enqueuePrompt: (text: string) => void;
  removeQueuedPrompt: (id: string) => void;
  consumeNextQueuedPrompt: () => QueuedPrompt | null;
  clearPromptQueue: () => void;

  agentMeta: AgentMeta;
  patchAgentMeta: (patch: Partial<AgentMeta>) => void;
  resetAgentMeta: () => void;

  // Sessions
  sessionsHydrated: boolean;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  hydrateSessions: () => Promise<void>;
  newSession: () => string;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  /** Persist messages of a session and bump its updatedAt + auto-title. */
  persistMessages: (id: string, messages: UIMessage[]) => void;
};

const NOOP_LIVE: Live = {
  getCwd: () => null,
  getTerminalContext: () => null,
  injectIntoActivePty: () => false,
  getWorkspaceRoot: () => null,
  getActiveFile: () => null,
  openPreview: () => false,
  openTerminal: () => false,
  runInActiveTerminal: () => false,
};

// Per-session Chat instances. Transport reads the keys map lazily, so a key
// change does not require rebuilding chats.
const chats = new Map<string, Chat<UIMessage>>();
// Initial messages for a session, populated at hydration time and consumed
// when the matching Chat is constructed.
const seedMessages = new Map<string, UIMessage[]>();

// Trailing debounce for per-token message persistence. Streaming fires
// `persistMessages` on every token; without this we'd JSON-serialize the
// full message array and round-trip to the store plugin per token, which
// stalls the UI. Flush on idle (status transition) via `flushPersist`.
const PERSIST_DEBOUNCE_MS = 300;
const pendingPersist = new Map<
  string,
  { latest: UIMessage[]; timer: ReturnType<typeof setTimeout> }
>();

function flushPersistEntry(id: string) {
  const entry = pendingPersist.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingPersist.delete(id);
  void saveMessages(id, entry.latest);
}

export function flushPersist(id?: string): void {
  if (id) {
    flushPersistEntry(id);
    return;
  }
  for (const key of Array.from(pendingPersist.keys())) flushPersistEntry(key);
}

// Per-session read cache: paths the model has called `read_file` on.
// `edit`/`multi_edit` enforce read-before-edit by checking membership.
// Stored at module scope (keyed by sessionId) instead of inside makeChat's
// closure so restore-checkpoint can clear it - after a restore, the
// model's "I've read this file" knowledge is gone from history and the
// cache must follow.
const readCaches = new Map<string, Set<string>>();

function getReadCache(sessionId: string): Set<string> {
  let cache = readCaches.get(sessionId);
  if (!cache) {
    cache = new Set<string>();
    readCaches.set(sessionId, cache);
  }
  return cache;
}

function makeChat(sessionId: string): Chat<UIMessage> {
  const readCache = getReadCache(sessionId);
  const toolContext: ToolContext = {
    getCwd: () => useChatStore.getState().live.getCwd(),
    getWorkspaceRoot: () => useChatStore.getState().live.getWorkspaceRoot(),
    getTerminalContext: (lines) => useChatStore.getState().live.getTerminalContext(lines),
    injectIntoActivePty: (text) => useChatStore.getState().live.injectIntoActivePty(text),
    openPreview: (url) => useChatStore.getState().live.openPreview(url),
    openTerminal: (cwd) => useChatStore.getState().live.openTerminal(cwd),
    runInActiveTerminal: (command) => useChatStore.getState().live.runInActiveTerminal(command),
    readCache,
    getSessionId: () => sessionId,
  };

  const transport = createContextAwareTransport({
    getKeys: () => useChatStore.getState().apiKeys,
    toolContext,
    getModelId: () => useChatStore.getState().selectedModelId,
    getCustomInstructions: () => usePreferencesStore.getState().customInstructions,
    getLmstudioBaseURL: () => usePreferencesStore.getState().lmstudioBaseURL,
    getOpenaiCompatibleBaseURL: () => usePreferencesStore.getState().openaiCompatibleBaseURL,
    getAgentPersona: () => {
      const s = useAgentsStore.getState();
      const all = s.all();
      const a = all.find((x) => x.id === s.activeId) ?? BUILTIN_AGENTS[0];
      return { name: a.name, instructions: a.instructions };
    },
    getLive: () => {
      const live = useChatStore.getState().live;
      return {
        cwd: live.getCwd(),
        workspaceRoot: live.getWorkspaceRoot(),
        activeFile: live.getActiveFile(),
      };
    },
    getPlanMode: () => usePlanStore.getState().active,
    onStep: (step) => {
      useChatStore.getState().patchAgentMeta({ step });
    },
    onUsage: (delta) => {
      // Accumulate per-step usage into the active session's running total.
      // Lets the UI surface cache hit ratio (cached / input) so users can
      // see provider prompt-cache savings without external tooling.
      useChatStore.setState((state) => ({
        agentMeta: {
          ...state.agentMeta,
          usage: {
            input: state.agentMeta.usage.input + delta.inputTokens,
            output: state.agentMeta.usage.output + delta.outputTokens,
            cached: state.agentMeta.usage.cached + delta.cachedInputTokens,
          },
        },
      }));
    },
  });

  const initialMessages = seedMessages.get(sessionId);
  seedMessages.delete(sessionId);

  return new Chat<UIMessage>({
    id: sessionId,
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (e) => {
      useChatStore.getState().patchAgentMeta({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    },
  });
}

export const useChatStore = create<StoreState>((set, get) => ({
  live: NOOP_LIVE,
  setLive: (live) => set({ live }),

  approvalResponder: null,
  setApprovalResponder: (fn) => set({ approvalResponder: fn }),
  respondToApproval: (approvalId, approved) => {
    const fn = get().approvalResponder;
    if (fn) fn(approvalId, approved);
  },

  apiKeys: { ...EMPTY_PROVIDER_KEYS },
  setApiKeys: (keys) => set({ apiKeys: keys }),
  setApiKey: (provider, key) => {
    set({ apiKeys: { ...get().apiKeys, [provider]: key } });
  },

  selectedModelId: DEFAULT_MODEL_ID,
  selectedProvider: tryGetModel(DEFAULT_MODEL_ID)?.provider ?? "openai",
  setSelectedModelId: (id, provider) => {
    const resolved =
      provider ??
      tryGetModel(id)?.provider ??
      // Last resort: keep the current provider rather than guessing wrong.
      get().selectedProvider;
    set({ selectedModelId: id, selectedProvider: resolved });
  },

  // `mini` was the floating mini-window state. The right sidebar replaces
  // it, so these now alias the sidebar's open/close - kept under the old
  // names because callers (AgentRunBridge auto-open on approval, AgentStatusPill
  // click) still use them.
  mini: { open: false },
  openMini: () => set({ panelOpen: true, mini: { open: true } }),
  closeMini: () => set({ panelOpen: false, mini: { open: false } }),
  toggleMini: () => set((s) => ({ panelOpen: !s.panelOpen, mini: { open: !s.panelOpen } })),

  panelOpen: false,
  openPanel: () => set({ panelOpen: true, mini: { open: true } }),
  closePanel: () => set({ panelOpen: false, mini: { open: false } }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen, mini: { open: !s.panelOpen } })),

  focusSignal: 0,
  pendingPrefill: null,
  focusInput: (prefill = null) =>
    set((s) => ({
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingPrefill: prefill ?? null,
    })),
  consumePrefill: () => {
    const v = get().pendingPrefill;
    if (v != null) set({ pendingPrefill: null });
    return v;
  },

  pendingSelections: [],
  attachSelection: (text, source) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingSelections: [...s.pendingSelections, { id, text: trimmed, source }],
    }));
  },
  consumeSelections: () => {
    const v = get().pendingSelections;
    if (v.length > 0) set({ pendingSelections: [] });
    return v;
  },

  promptQueue: [],
  enqueuePrompt: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const item: QueuedPrompt = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: trimmed,
      enqueuedAt: Date.now(),
    };
    set((s) => ({ promptQueue: [...s.promptQueue, item] }));
  },
  removeQueuedPrompt: (id) =>
    set((s) => ({ promptQueue: s.promptQueue.filter((p) => p.id !== id) })),
  consumeNextQueuedPrompt: () => {
    const queue = get().promptQueue;
    if (queue.length === 0) return null;
    const [next, ...rest] = queue;
    set({ promptQueue: rest });
    return next;
  },
  clearPromptQueue: () => set({ promptQueue: [] }),

  openEditorFiles: [],
  setOpenEditorFiles: (files) => {
    // Only write when the (path, name) tuple actually changed - prevents
    // re-renders on every tab keystroke since App.tsx runs the sync effect
    // whenever the `tabs` array reference changes.
    const prev = get().openEditorFiles;
    if (prev.length === files.length) {
      let same = true;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i].path !== files[i].path || prev[i].name !== files[i].name) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    set({ openEditorFiles: files });
  },

  agentMeta: IDLE_META,
  patchAgentMeta: (patch) => set((s) => ({ agentMeta: { ...s.agentMeta, ...patch } })),
  resetAgentMeta: () => set({ agentMeta: IDLE_META }),

  sessionsHydrated: false,
  sessions: [],
  activeSessionId: null,

  hydrateSessions: async () => {
    if (get().sessionsHydrated) return;
    const { sessions } = await loadAll();

    // Reuse the most recent untitled "New chat" session if one exists from
    // the previous run - no point stacking empty placeholder sessions every
    // launch. Otherwise prepend a fresh one.
    const reusable = sessions[0]?.title === "New chat" ? sessions[0] : null;
    let nextSessions: SessionMeta[];
    let freshId: string;
    if (reusable) {
      nextSessions = sessions;
      freshId = reusable.id;
    } else {
      freshId = newSessionId();
      const fresh: SessionMeta = {
        id: freshId,
        title: "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      nextSessions = [fresh, ...sessions];
      void saveSessionsList(nextSessions);
    }
    void saveActiveId(freshId);

    set({
      sessions: nextSessions,
      activeSessionId: freshId,
      sessionsHydrated: true,
    });
  },

  newSession: () => {
    const id = newSessionId();
    const meta: SessionMeta = {
      id,
      title: "New chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const next = [meta, ...get().sessions];
    set({ sessions: next, activeSessionId: id, agentMeta: IDLE_META });
    void saveSessionsList(next);
    void saveActiveId(id);
    return id;
  },

  switchSession: (id) => {
    if (get().activeSessionId === id) return;
    if (!get().sessions.some((s) => s.id === id)) return;

    // Lazily seed the chat with persisted messages the first time we open
    // this session. Subsequent switches reuse the cached Chat instance.
    const flip = () => {
      set({ activeSessionId: id, agentMeta: IDLE_META });
      void saveActiveId(id);
    };
    if (chats.has(id) || seedMessages.has(id)) {
      flip();
      return;
    }
    void loadMessages(id).then((m) => {
      if (m && m.length > 0 && !chats.has(id)) seedMessages.set(id, m);
      flip();
    });
  },

  deleteSession: (id) => {
    const remaining = get().sessions.filter((s) => s.id !== id);
    chats.get(id)?.stop();
    chats.delete(id);
    seedMessages.delete(id);
    const pend = pendingPersist.get(id);
    if (pend) {
      clearTimeout(pend.timer);
      pendingPersist.delete(id);
    }
    discardCheckpoint(id);
    readCaches.delete(id);
    void deleteSessionData(id);
    void useTodosStore.getState().clearSession(id);

    if (remaining.length === 0) {
      const fresh: SessionMeta = {
        id: newSessionId(),
        title: "New chat",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      set({ sessions: [fresh], activeSessionId: fresh.id });
      void saveSessionsList([fresh]);
      void saveActiveId(fresh.id);
      return;
    }

    const wasActive = get().activeSessionId === id;
    const nextActive = wasActive ? remaining[0].id : get().activeSessionId;
    set({ sessions: remaining, activeSessionId: nextActive });
    void saveSessionsList(remaining);
    if (wasActive) void saveActiveId(nextActive);
  },

  renameSession: (id, title) => {
    const next = get().sessions.map((s) =>
      s.id === id ? { ...s, title, updatedAt: Date.now() } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },

  persistMessages: (id, messages) => {
    // Debounce the message-blob write so streaming doesn't pound the store.
    const existing = pendingPersist.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const entry = pendingPersist.get(id);
      if (!entry) return;
      pendingPersist.delete(id);
      void saveMessages(id, entry.latest);
    }, PERSIST_DEBOUNCE_MS);
    pendingPersist.set(id, { latest: messages, timer });

    // Update zustand session list only when the derived title actually
    // changes - otherwise we'd rewrite the sessions array (and trigger
    // re-renders + a store write) on every token.
    const sessions = get().sessions;
    const meta = sessions.find((s) => s.id === id);
    if (!meta) return;
    const isUntitled = !meta.title || meta.title === "New chat";
    if (!isUntitled) return;
    const nextTitle = deriveTitle(messages);
    if (nextTitle === meta.title) return;
    const next = sessions.map((s) =>
      s.id === id ? { ...s, title: nextTitle, updatedAt: Date.now() } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },
}));

export function getAgentMeta(): AgentMeta {
  return useChatStore.getState().agentMeta;
}

export function getActiveProviderKey(): string | null {
  const { selectedModelId, apiKeys } = useChatStore.getState();
  return apiKeys[resolveProvider(selectedModelId)] ?? null;
}

export function hasKeyForModel(modelId: DynamicModelId): boolean {
  const { apiKeys } = useChatStore.getState();
  const provider = resolveProvider(modelId);
  return providerNeedsKey(provider) ? !!apiKeys[provider] : true;
}

export function getOrCreateChat(sessionId: string): Chat<UIMessage> {
  const existing = chats.get(sessionId);
  if (existing) return existing;
  const c = makeChat(sessionId);
  chats.set(sessionId, c);
  return c;
}

export function getChat(sessionId?: string): Chat<UIMessage> | undefined {
  if (sessionId) return chats.get(sessionId);
  const id = useChatStore.getState().activeSessionId;
  return id ? chats.get(id) : undefined;
}

export async function sendMessage(text: string): Promise<boolean> {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return false;
  if (providerNeedsKey(resolveProvider(state.selectedModelId)) && !getActiveProviderKey())
    return false;
  // Guard against the restore-in-progress race: if we appended a new user
  // message while restore was mid `c.messages = trimmed`, that message
  // would either be lost (trim drops it) or yield an inconsistent state.
  if (restoringSessions.has(sessionId)) return false;
  const c = getOrCreateChat(sessionId);
  // Open a fresh restore checkpoint just before the user message is
  // appended. Tools called by the agent will capture their pre-mutation
  // file state into this checkpoint.
  openCheckpoint(sessionId, c.messages.length);
  await c.sendMessage({ text });
  return true;
}

export function stop(): void {
  const id = useChatStore.getState().activeSessionId;
  if (!id) return;
  void chats.get(id)?.stop();
}

/**
 * Open a restore checkpoint synchronously, intended for call sites that
 * dispatch `chat.sendMessage` directly (composer submit / queue drain).
 * Returns false if the session is in the middle of a restore - the caller
 * MUST then skip the send to avoid races. Otherwise opens a fresh
 * checkpoint and returns true.
 */
export function openSendCheckpoint(sessionId: string | null): boolean {
  if (!sessionId) return false;
  if (restoringSessions.has(sessionId)) return false;
  const c = chats.get(sessionId);
  if (!c) return false;
  openCheckpoint(sessionId, c.messages.length);
  return true;
}

/**
 * Sessions currently mid-restore. Consulted by `openSendCheckpoint` and
 * `sendMessage` so a quick "click Restore then quickly hit Send" can't
 * append a new user message during `c.messages = trimmed` and end up
 * either lost (trimmed away) or in an inconsistent state.
 */
const restoringSessions = new Set<string>();

/**
 * Roll the active session back to the last user-message checkpoint.
 * Reverts any files the agent mutated, trims chat history, stops a running
 * agent, and clears stale read-cache entries so the next turn doesn't
 * inherit the model's view of files that were just reverted.
 *
 * Returns `null` if there's nothing to restore.
 */
export async function restoreToLastCheckpoint(): Promise<RestoreOutcome | null> {
  const sessionId = useChatStore.getState().activeSessionId;
  if (!sessionId) return null;
  const c = chats.get(sessionId);
  if (!c) return null;
  if (restoringSessions.has(sessionId)) return null;

  restoringSessions.add(sessionId);
  try {
    // Stop any in-flight stream before mutating its message list.
    try {
      await c.stop();
    } catch {
      // already stopped - ignore
    }

    const outcome = await restoreCheckpoint(sessionId);
    if (!outcome) return null;

    // Trim history back to the pre-user-turn baseline.
    const trimmed = c.messages.slice(0, outcome.baselineMessageCount);
    c.messages = trimmed;
    // Make sure the persisted store reflects the trim immediately - the
    // debounced persist would catch this eventually but a session switch
    // before then would lose the truncation.
    flushPersist(sessionId);
    void saveMessages(sessionId, trimmed);

    // Clear read-before-edit knowledge. The trimmed history no longer
    // contains the original read_file results, so the model's mental view
    // of the file is gone too - the next turn must re-read before editing.
    readCaches.get(sessionId)?.clear();

    // Reset transient agent state. The agent loop is no longer running and
    // any pending approval cards refer to messages we just removed.
    useChatStore.setState({ agentMeta: IDLE_META });

    return outcome;
  } finally {
    restoringSessions.delete(sessionId);
  }
}
