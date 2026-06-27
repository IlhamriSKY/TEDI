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

/** Treat unknown model ids as SumoPod. They surface when the user picked a
 *  runtime-detected SumoPod model and the registry hasn't re-hydrated yet. */
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
import { useSubagentRunStore } from "./subagentRunStore";
import { useTodosStore } from "./todoStore";
import { toast } from "@/components/ui/toast";
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
import type { CompactStages } from "../lib/compact";
import { disposeSessionShell } from "../tools/shell";
import type { BrowserInfo, TerminalInfo, TerminalTarget } from "@/modules/scheduler/types";
import { createContextAwareTransport } from "../lib/transport";
import type { ToolContext } from "../tools/tools";

type Live = {
  getCwd: () => string | null;
  getTerminalContext: (lines?: number) => string | null;
  injectIntoActivePty: (text: string) => boolean;
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  openPreview: (url: string) => number | null;
  /** Open a new terminal tab. Optional cwd overrides the inherited cwd.
   *  Returns true if a new tab was created. */
  openTerminal: (cwd?: string | null) => boolean;
  /** Open a new terminal with placement options. `mode="tab"` makes a fresh
   *  top-level tab; `mode="split"` splits the focused leaf of `targetTabId`
   *  (or the active tab) with `splitDir` "row" (right) or "col" (down).
   *  Result variant surfaces specific errors to the tool layer. */
  openTerminalAdvanced: (opts: {
    cwd?: string | null;
    mode?: "tab" | "split";
    splitDir?: "row" | "col";
    targetTabId?: number | null;
  }) =>
    | { ok: true; tabId: number; leafId: number | null; mode: "tab" | "split" }
    | { ok: false; error: string };
  /** Move every terminal leaf into one tab. Refuses if the total exceeds
   *  the per-tab pane cap. */
  consolidateTerminalsIntoGroup: (
    targetTabId: number,
  ) =>
    | { ok: true; targetTabId: number; moved: number; alreadyInGroup: number }
    | { ok: false; error: string; movedBeforeFailure?: number };
  /** Merge given pane leaves (any kind: terminal/editor/browser) into one tab
   *  as splits. Refuses past the per-tab pane cap. */
  groupLeavesIntoTab: (
    leafIds: number[],
    targetTabId?: number,
  ) =>
    | { ok: true; targetTabId: number; moved: number; alreadyInGroup: number }
    | { ok: false; error: string };
  /** Change a pane's split orientation in its group (row = beside, col =
   *  stacked). With `direction` it sets that orientation; without it, toggles. */
  rotatePaneSplit: (
    leafId: number,
    direction?: "row" | "col",
  ) => { ok: true; orientation: "row" | "col"; changed: boolean } | { ok: false; error: string };
  /** Close one terminal leaf. Refuses the last leaf so at least one tab remains. */
  closeTerminalLeaf: (
    leafId: number,
  ) => { ok: true; closedTab: boolean } | { ok: false; error: string };
  /** Inject `command` into the active terminal and submit (CR). Returns
   *  false when no active terminal exists. Used when the user asks the AI
   *  to "run X in the terminal" so output stays in the visible terminal. */
  runInActiveTerminal: (command: string) => boolean;
  /** Snapshot every terminal leaf with ordinal/title/cwd. */
  listTerminals: () => TerminalInfo[];
  /** Snapshot every open in-app browser pane with its current URL. */
  listBrowsers: () => BrowserInfo[];
  /** Navigate an existing browser pane (by leaf id) to a URL. False if that leaf isn't a browser. */
  navigateBrowser: (leafId: number, url: string) => boolean;
  /** Drive an existing browser pane's history: back / forward / reload. */
  dispatchBrowser: (leafId: number, action: "back" | "forward" | "reload") => boolean;
  /** Read an existing browser pane's rendered text (title + visible body).
   *  With `fields` also lists tagged interactive controls as `[N]`. */
  readBrowser: (leafId: number, fields?: boolean) => Promise<string | null>;
  /** Type into / click an interactive control (by `[N]` index) of a browser
   *  pane. Returns the raw result string, or null if not a browser. */
  actBrowser: (
    leafId: number,
    index: number,
    action: "click" | "type" | "hover" | "key" | "scroll" | "clickxy",
    text: string,
    submit: boolean,
  ) => Promise<string | null>;
  /** Capture a browser pane as a base64 JPEG (last-resort visual). */
  screenshotBrowser: (leafId: number) => Promise<string | null>;
  /** Inject text into a specific terminal (no Enter). */
  injectIntoTerminal: (target: TerminalTarget, text: string) => boolean;
  /** Submit a command (Enter appended) to a specific terminal. */
  runInTerminal: (target: TerminalTarget, command: string) => boolean;
  /** True when the target (default = active) terminal is running a command
   *  or on the alt-screen (TUI). False when the cursor sits on a shell PS1
   *  on the normal screen, i.e. safe for the AI to inject a command. */
  isTerminalBusy: (target?: TerminalTarget) => boolean;
};

export type AgentRunStatus = "idle" | "thinking" | "streaming" | "awaiting-approval" | "error";

/** Cumulative token usage for the active session. Reset on switch/clear.
 *  `cached` is the slice of `input` that hit the provider's prompt cache. */
export type SessionUsage = {
  input: number;
  output: number;
  cached: number;
};

/** Most-recent compaction event. Drives the pulse badge and hovercard line
 *  next to the context indicator. Includes Stage 1 so every pass surfaces. */
export type LastCompact = {
  at: number;
  stages: CompactStages;
};

export type AgentMeta = {
  status: AgentRunStatus;
  step: string | null;
  approvalsPending: number;
  error: string | null;
  usage: SessionUsage;
  lastCompact: LastCompact | null;
};

const ZERO_USAGE: SessionUsage = { input: 0, output: 0, cached: 0 };

const IDLE_META: AgentMeta = {
  status: "idle",
  step: null,
  approvalsPending: 0,
  error: null,
  usage: ZERO_USAGE,
  lastCompact: null,
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
  /** Absolute path. Unique key and the arg to attachFileByPath. */
  path: string;
  /** Display name (basename). */
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
   * tree (e.g. the AI diff tab) resolve approvals via the active session's
   * `addToolApprovalResponse`.
   */
  approvalResponder: ApprovalResponder | null;
  setApprovalResponder: (fn: ApprovalResponder | null) => void;
  respondToApproval: (approvalId: string, approved: boolean) => void;

  apiKeys: ProviderKeys;
  setApiKeys: (keys: ProviderKeys) => void;
  setApiKey: (provider: ProviderId, key: string | null) => void;

  selectedModelId: DynamicModelId;
  /** Provider picked alongside selectedModelId. Wins when two providers
   *  detect the same model id, regardless of refresh order. */
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

  /** Files open in editor leaves. Surfaced as suggestion chips above the AI
   *  input; clicking promotes to an attachment. */
  openEditorFiles: OpenEditorFile[];
  setOpenEditorFiles: (files: OpenEditorFile[]) => void;

  /** Prompts queued via Ctrl/Cmd+Enter while the agent is busy. Fired
   *  one-by-one on idle. Text-only; attachments bind at send time. */
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

  showHistoryPicker: boolean;
  setShowHistoryPicker: (open: boolean) => void;
};

const NOOP_LIVE: Live = {
  getCwd: () => null,
  getTerminalContext: () => null,
  injectIntoActivePty: () => false,
  getWorkspaceRoot: () => null,
  getActiveFile: () => null,
  openPreview: () => null,
  openTerminal: () => false,
  openTerminalAdvanced: () => ({ ok: false, error: "live bridge not ready" }),
  consolidateTerminalsIntoGroup: () => ({ ok: false, error: "live bridge not ready" }),
  groupLeavesIntoTab: () => ({ ok: false, error: "live bridge not ready" }),
  rotatePaneSplit: () => ({ ok: false, error: "live bridge not ready" }),
  closeTerminalLeaf: () => ({ ok: false, error: "live bridge not ready" }),
  runInActiveTerminal: () => false,
  listTerminals: () => [],
  listBrowsers: () => [],
  navigateBrowser: () => false,
  dispatchBrowser: () => false,
  readBrowser: async () => null,
  actBrowser: async () => null,
  screenshotBrowser: async () => null,
  injectIntoTerminal: () => false,
  runInTerminal: () => false,
  isTerminalBusy: () => true,
};

// Per-session Chat instances. The transport reads keys lazily, so key changes
// don't require rebuilds. Bounded by CHAT_LRU_CAP: LRU chats hibernate
// (messages flush, Chat dropped); re-open rebuilds from disk.
const chats = new Map<string, Chat<UIMessage>>();
const CHAT_LRU_CAP = 10;

function touchChatLRU(sessionId: string): void {
  const existing = chats.get(sessionId);
  if (!existing) return;
  chats.delete(sessionId);
  chats.set(sessionId, existing);
}

function hibernateOldestChat(): void {
  let guard = chats.size + 1;
  while (chats.size > CHAT_LRU_CAP && guard-- > 0) {
    const oldest = chats.keys().next().value;
    if (oldest === undefined) return;
    const activeId = useChatStore.getState().activeSessionId;
    // Never evict the active session. Move to tail and try next.
    if (oldest === activeId) {
      touchChatLRU(oldest);
      continue;
    }
    const victim = chats.get(oldest);
    if (victim) {
      try {
        void victim.stop();
      } catch {
        // already stopped
      }
      // Snapshot the in-memory messages back to `seedMessages` so the next
      // getOrCreateChat re-hydrates correctly. Disk could be stale if the
      // debounced persist hasn't fired.
      seedMessages.set(oldest, victim.messages);
      // Durably persist before eviction. A turn that streamed in this
      // background session may never have been queued (only the active
      // session is mirrored by AgentRunBridge), so flushPersistEntry would
      // no-op and the messages would be lost on restart. Write directly.
      void saveMessages(oldest, victim.messages);
    }
    flushPersistEntry(oldest);
    chats.delete(oldest);
    // Retain readCaches: tiny, and still valid after rehydration.
  }
}
// Initial messages for a session, populated at hydration and consumed when
// the matching Chat is constructed.
const seedMessages = new Map<string, UIMessage[]>();

// Trailing debounce for per-token persistence. Without it we'd serialize the
// full message array and round-trip to the store on every token. Flush on
// idle via `flushPersist`.
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

// Periodic safety flush (every 5s) alongside the debounce. Ensures tail
// messages survive a crash even if the debounced timer hasn't fired yet.
let periodicFlushTimer: ReturnType<typeof setInterval> | undefined;
function ensurePeriodicFlush(): void {
  if (periodicFlushTimer !== undefined) return;
  periodicFlushTimer = setInterval(() => flushPersist(), 5000);
}
ensurePeriodicFlush();

// Per-session throttle so a chain of high-context turns doesn't fire a toast
// per turn. Auto-compact surfaces at most once per 12 seconds.
const AUTO_COMPACT_TOAST_THROTTLE_MS = 12_000;
const lastAutoCompactToastAt = new Map<string, number>();

// Per-session read cache. `edit`/`multi_edit` enforce read-before-edit via
// membership. Module-scoped so restore-checkpoint can clear it: after a
// restore, the model's read history is gone, the cache must follow.
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
    listBrowsers: () => useChatStore.getState().live.listBrowsers(),
    navigateBrowser: (leafId, url) => useChatStore.getState().live.navigateBrowser(leafId, url),
    dispatchBrowser: (leafId, action) =>
      useChatStore.getState().live.dispatchBrowser(leafId, action),
    readBrowser: (leafId, fields) => useChatStore.getState().live.readBrowser(leafId, fields),
    actBrowser: (leafId, index, action, text, submit) =>
      useChatStore.getState().live.actBrowser(leafId, index, action, text, submit),
    screenshotBrowser: (leafId) => useChatStore.getState().live.screenshotBrowser(leafId),
    openTerminal: (cwd) => useChatStore.getState().live.openTerminal(cwd),
    openTerminalAdvanced: (opts) => useChatStore.getState().live.openTerminalAdvanced(opts),
    consolidateTerminalsIntoGroup: (targetTabId) =>
      useChatStore.getState().live.consolidateTerminalsIntoGroup(targetTabId),
    groupLeavesIntoTab: (leafIds, targetTabId) =>
      useChatStore.getState().live.groupLeavesIntoTab(leafIds, targetTabId),
    rotatePaneSplit: (leafId, direction) =>
      useChatStore.getState().live.rotatePaneSplit(leafId, direction),
    closeTerminalLeaf: (leafId) => useChatStore.getState().live.closeTerminalLeaf(leafId),
    runInActiveTerminal: (command) => useChatStore.getState().live.runInActiveTerminal(command),
    listTerminals: () => useChatStore.getState().live.listTerminals(),
    injectIntoTerminal: (target, text) =>
      useChatStore.getState().live.injectIntoTerminal(target, text),
    runInTerminal: (target, command) => useChatStore.getState().live.runInTerminal(target, command),
    isTerminalBusy: (target) => useChatStore.getState().live.isTerminalBusy(target),
    readCache,
    getSessionId: () => sessionId,
    getApiKeys: () => useChatStore.getState().apiKeys,
    getSelectedModelId: () => useChatStore.getState().selectedModelId,
  };

  // `agentMeta` is a single global field the UI renders for the ACTIVE session
  // only (switchSession resets it). These transport callbacks keep firing while
  // a non-active session streams in the background, so every write/toast must
  // be gated by the producing session id, or switching away mid-turn corrupts
  // the now-active session's step label, token counter, compaction badge, and
  // error pill. An error on a background session is not lost: AgentRunBridge
  // re-derives status from that chat when the user switches back to it.
  const isActiveSession = () => useChatStore.getState().activeSessionId === sessionId;

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
        terminals: live.listTerminals(),
        browsers: live.listBrowsers(),
      };
    },
    getPlanMode: () => usePlanStore.getState().active,
    onStep: (step) => {
      if (!isActiveSession()) return;
      useChatStore.getState().patchAgentMeta({ step });
    },
    onUsage: (delta) => {
      if (!isActiveSession()) return;
      // Accumulate per-step usage so the UI can show cache hit ratio.
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
    onCompact: ({ stages }) => {
      if (!isActiveSession()) return;
      const now = Date.now();
      // Reflect every pass in agentMeta so the pulse badge fires each time.
      useChatStore.getState().patchAgentMeta({ lastCompact: { at: now, stages } });
      // Toast is heavier: only on Stage 2 elision or Stage 3 drop, throttled.
      if (stages.elided === 0 && stages.dropped === 0) return;
      const last = lastAutoCompactToastAt.get(sessionId) ?? 0;
      if (now - last < AUTO_COMPACT_TOAST_THROTTLE_MS) return;
      lastAutoCompactToastAt.set(sessionId, now);
      if (stages.dropped > 0) {
        const msg =
          stages.elided > 0
            ? `Auto-compacted: dropped ${stages.dropped} old message${stages.dropped === 1 ? "" : "s"}, elided ${stages.elided} tool result${stages.elided === 1 ? "" : "s"} (context near limit).`
            : `Auto-compacted: dropped ${stages.dropped} old message${stages.dropped === 1 ? "" : "s"} to fit context.`;
        toast(msg, { variant: "warning" });
      } else {
        toast(
          `Auto-compacted: elided ${stages.elided} old tool result${stages.elided === 1 ? "" : "s"} to reclaim context.`,
          { variant: "info" },
        );
      }
    },
    onFinishMeta: (info) => {
      if (!isActiveSession()) return;
      // Surface non-normal stop reasons so the user sees why the agent paused.
      if (info.stopReason === "step-cap") {
        toast("Stopped after reaching the per-turn step limit. Reply to continue.", {
          variant: "warning",
        });
      } else if (info.stopReason === "tool-repetition") {
        toast("Stopped: model was repeating the same tool call. Tell it what you actually need.", {
          variant: "warning",
        });
      } else if (info.stopReason === "no-progress") {
        toast("Stopped: model went idle without making progress. Reply to continue.", {
          variant: "info",
        });
      }
    },
  });

  const initialMessages = seedMessages.get(sessionId);
  seedMessages.delete(sessionId);

  return new Chat<UIMessage>({
    id: sessionId,
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: ({ messages }) => {
      // Queue the completed turn for disk regardless of which session is
      // active. AgentRunBridge only mirrors the ACTIVE session, so a turn
      // that finished in the background would otherwise never be persisted
      // and would be lost on eviction/restart. persistMessages is debounced,
      // so when this session is active the active-session bridge path just
      // shares the same debounce entry (no duplicate write).
      useChatStore.getState().persistMessages(sessionId, messages);
    },
    onError: (e) => {
      // Only reflect the error on the global meta if this is the active
      // session; a background session's error surfaces via AgentRunBridge when
      // the user switches to it (it re-derives status from the chat).
      if (!isActiveSession()) return;
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
      // Fallback: keep current provider rather than guess.
      get().selectedProvider;
    // The transport snapshots `selectedModelId` once per `sendMessages` call,
    // so an in-flight agent run stays bound to whatever it started with. A
    // mid-turn swap only takes effect on the next user prompt. This is
    // intentional: restarting the stream mid-flight would lose partial work
    // and surprise the user.
    set({ selectedModelId: id, selectedProvider: resolved });
  },

  // `mini` was the floating window state. The sidebar replaced it; these
  // alias the sidebar's open/close, kept under the old names for callers.
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
    // Only write when (path, name) actually changed; the sync effect fires
    // on every tabs array re-reference.
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

    // Reuse the most recent untitled "New chat" if present; otherwise prepend a fresh one.
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

    // Lazy-seed the chat with persisted messages on first open; subsequent
    // switches reuse the cached Chat.
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
    lastAutoCompactToastAt.delete(id);
    // Tear down the persistent Rust shell (one per chat) so the child process
    // and IO pipes are released. Without this, deletes leak zombie shells.
    disposeSessionShell(id);
    void deleteSessionData(id);
    void useTodosStore.getState().clearSession(id);
    useSubagentRunStore.getState().clearSession(id);

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
    // Debounce the message-blob write so streaming doesn't hammer the store.
    const existing = pendingPersist.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const entry = pendingPersist.get(id);
      if (!entry) return;
      pendingPersist.delete(id);
      void saveMessages(id, entry.latest);
    }, PERSIST_DEBOUNCE_MS);
    pendingPersist.set(id, { latest: messages, timer });

    // Update sessions only when the derived title actually changes.
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

  showHistoryPicker: false,
  setShowHistoryPicker: (open: boolean) => set({ showHistoryPicker: open }),
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
  if (existing) {
    touchChatLRU(sessionId);
    return existing;
  }
  const c = makeChat(sessionId);
  chats.set(sessionId, c);
  hibernateOldestChat();
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
  // Restore-race guard: a new user message during `c.messages = trimmed`
  // would either be lost or land in an inconsistent state.
  if (restoringSessions.has(sessionId)) return false;
  const c = getOrCreateChat(sessionId);
  // Open a restore checkpoint just before appending the user message. Tools
  // called by the agent capture pre-mutation file state into it.
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
 * Synchronously open a restore checkpoint. For callers that dispatch
 * `chat.sendMessage` directly (composer submit, queue drain). Returns false
 * if a restore is in progress; the caller must then skip the send.
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
 * Sessions mid-restore. Consulted by `openSendCheckpoint` and `sendMessage`
 * so a fast "Restore then Send" can't append during `c.messages = trimmed`.
 */
const restoringSessions = new Set<string>();

/**
 * Roll back to the last user-message checkpoint. Reverts mutated files, trims
 * history, stops a running agent, and clears the read cache so the next turn
 * re-reads. Returns null if there's nothing to restore.
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
      // already stopped
    }

    const outcome = await restoreCheckpoint(sessionId);
    if (!outcome) return null;

    // Trim history to the pre-user-turn baseline.
    const trimmed = c.messages.slice(0, outcome.baselineMessageCount);
    c.messages = trimmed;
    // Persist now so a session switch before the debounced write doesn't
    // lose the truncation.
    flushPersist(sessionId);
    void saveMessages(sessionId, trimmed);

    // Clear read-before-edit knowledge. Trimmed history no longer contains
    // the read_file results, so the next turn must re-read.
    readCaches.get(sessionId)?.clear();

    // Reset transient agent state. Any pending approvals refer to removed messages.
    useChatStore.setState({ agentMeta: IDLE_META });

    return outcome;
  } finally {
    restoringSessions.delete(sessionId);
  }
}
