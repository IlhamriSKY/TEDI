import type { UIMessage } from "@ai-sdk/react";
import type { ChatTransport } from "ai";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getModelContextLimit, type DynamicModelId, type ProviderId } from "../config";
import { injectContext, type LiveSnapshot, type SentEnvBlocks } from "./envContext";
import { runAgentStream, type AgentUsageDelta } from "./agent";
import { buildMcpToolsAsync } from "../tools/mcp";
import { compactUiMessages } from "./compact";
import { providerHasPromptCache } from "./cache";
import type { CompactStages } from "./compact";
import {
  classifyError,
  describeProviderError,
  newCorrelationId,
  tediError,
  TediErrorCode,
  toChatError,
} from "./errors";
import type { ProviderKeys } from "./keyring";
import { native, type DirEntry } from "./native";
import { subscribeMemoryPathChanges } from "./memoryCache";
import {
  assembleProjectMemory,
  projectMemoryRootOf,
  selectProjectMemoryDocs,
} from "./projectMemory";
import type { ToolContext } from "../tools/tools";

type MemoryCacheEntry = { content: string | null; cachedAt: number; signature?: string };
const projectMemoryCache = new Map<string, MemoryCacheEntry>();

/** Cache key for the per-workspace memory caches. The live workspaceRoot is
 *  already forward-slashed; fold trailing slash + case so it matches the
 *  lowercased key clearMemoryCachesForPath deletes with — otherwise a Windows
 *  drive letter alone guarantees a miss and edits aren't picked up until the
 *  30s TTL. */
function memoryCacheKey(workspaceRoot: string): string {
  return workspaceRoot.replace(/\/$/, "").toLowerCase();
}

function clearMemoryCachesForPath(path: string): void {
  const normalized = path.replace(/\/$/, "").toLowerCase();
  const docRoot = projectMemoryRootOf(normalized);
  if (docRoot !== null) {
    projectMemoryCache.delete(docRoot);
    return;
  }
  const marker = "/.tedi/memory/";
  const idx = normalized.indexOf(marker);
  if (idx === -1) return;
  const workspaceRoot = normalized.slice(0, idx);
  projectMemoryCache.delete(workspaceRoot);
  memoryCache.delete(workspaceRoot);
  const filename = normalized.slice(idx + marker.length);
  if (filename) memoryFileCache.delete(memoryFileCacheKey(workspaceRoot, filename));
}

subscribeMemoryPathChanges(clearMemoryCachesForPath);

/** Read the workspace-root memory docs (AGENTS.md, TEDI.md) as one block, each
 *  under its own "### name" header. ONE readDir serves both: the entries carry
 *  the mtime/size signature that decides whether the 30s cache can be kept, so
 *  adding the second file costs no extra round trip. */
async function readProjectMemory(workspaceRoot: string | null): Promise<string | null> {
  if (!workspaceRoot) return null;
  const root = workspaceRoot.replace(/\/$/, "");
  const key = memoryCacheKey(workspaceRoot);
  const cached = projectMemoryCache.get(key);
  // Cache for 30s. Re-read after that to pick up edits.
  if (cached && Date.now() - cached.cachedAt < 30_000) return cached.content;
  try {
    const found = selectProjectMemoryDocs(await native.readDir(root));
    // The readDir entries carry the signature, so the cache check costs nothing
    // extra and a second doc adds no round trip.
    const signature = memorySignature(found);
    if (cached && cached.signature === signature) {
      projectMemoryCache.set(key, { content: cached.content, cachedAt: Date.now(), signature });
      return cached.content;
    }
    const content = await assembleProjectMemory(root, found, native.readFile);
    projectMemoryCache.set(key, { content, cachedAt: Date.now(), signature });
    return content;
  } catch {
    projectMemoryCache.set(key, { content: null, cachedAt: Date.now() });
    return null;
  }
}

const MEMORY_MAX_BYTES = 32 * 1024;
const memoryCache = new Map<string, MemoryCacheEntry>();
type MemoryFileCacheEntry = { content: string; mtime: number; size: number };
const memoryFileCache = new Map<string, MemoryFileCacheEntry>();

function memorySignature(files: readonly DirEntry[]): string {
  return files.map((f) => `${f.name}:${f.mtime}:${f.size}`).join("|");
}

function memoryFileCacheKey(workspaceRoot: string, name: string): string {
  return `${workspaceRoot}\u0000${name}`;
}

/** Read durable project memory from `.tedi/memory/*.md` (Claude-CLI style),
 *  concatenated oldest-name first under per-file headers and capped in total.
 *  Cached 30s, mirroring readProjectMemory. Null when the folder is absent or empty. */
async function readMemory(workspaceRoot: string | null): Promise<string | null> {
  if (!workspaceRoot) return null;
  const dir = `${workspaceRoot.replace(/\/$/, "")}/.tedi/memory`;
  const cacheWorkspaceRoot = memoryCacheKey(workspaceRoot);
  const cached = memoryCache.get(cacheWorkspaceRoot);
  if (cached && Date.now() - cached.cachedAt < 30_000) return cached.content;
  let content: string | null = null;
  try {
    const files = (await native.readDir(dir))
      .filter((e) => e.name.toLowerCase().endsWith(".md"))
      .sort((a, b) => a.name.localeCompare(b.name));
    const signature = memorySignature(files);
    if (cached && cached.signature === signature) {
      memoryCache.set(cacheWorkspaceRoot, {
        content: cached.content,
        cachedAt: Date.now(),
        signature,
      });
      return cached.content;
    }
    const blocks: string[] = [];
    let budget = MEMORY_MAX_BYTES;
    for (const f of files) {
      if (budget <= 0) break;
      const separatorBytes = blocks.length > 0 ? 2 : 0;
      const header = `### ${f.name}\n`;
      const overhead = separatorBytes + header.length;
      if (budget <= overhead) break;
      const cacheKey = memoryFileCacheKey(cacheWorkspaceRoot, f.name.toLowerCase());
      const fileCached = memoryFileCache.get(cacheKey);
      let raw =
        fileCached && fileCached.mtime === f.mtime && fileCached.size === f.size
          ? fileCached.content
          : null;
      if (raw === null) {
        const r = await native.readFile(`${dir}/${f.name}`);
        if (r.kind !== "text") continue;
        raw =
          r.content.length > MEMORY_MAX_BYTES ? r.content.slice(0, MEMORY_MAX_BYTES) : r.content;
        memoryFileCache.set(cacheKey, { content: raw, mtime: f.mtime, size: f.size });
      }
      const body = raw.trim().slice(0, budget - overhead);
      budget -= overhead + body.length;
      blocks.push(`${header}${body}`);
    }
    content = blocks.length > 0 ? blocks.join("\n\n") : null;
    memoryCache.set(cacheWorkspaceRoot, { content, cachedAt: Date.now(), signature });
    return content;
  } catch {
    content = null; // folder absent -> no memory
  }
  memoryCache.set(cacheWorkspaceRoot, { content, cachedAt: Date.now() });
  return content;
}

type Deps = {
  getKeys: () => ProviderKeys;
  toolContext: ToolContext;
  getPersistedMessages?: () => UIMessage[];
  persistCompactedMessages?: (
    messages: UIMessage[],
    info: { dropped: number; kept: number },
  ) => void;
  getModelId: () => DynamicModelId;
  /** Provider picked alongside the model id; disambiguates ids shared by two
   *  providers (e.g. `deepseek-v4-pro` on both DeepSeek and SumoPod). */
  getSelectedProvider?: () => ProviderId | undefined;
  getCustomInstructions: () => string;
  getAgentPersona: () => { name: string; instructions: string } | null;
  getLive: () => LiveSnapshot;
  getLmstudioBaseURL?: () => string | undefined;
  getOpenaiCompatibleBaseURL?: () => string | undefined;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number; stages: CompactStages }) => void;
  onFinishMeta?: (info: {
    hitStepCap: boolean;
    finishReason: string;
    stopReason: "step-cap" | "tool-repetition" | "no-progress" | "normal";
  }) => void;
  getPlanMode?: () => boolean;
};

/** Max retries for transient provider errors (429, 5xx, network). */
const MAX_RETRIES = 3;
/** Base backoff in ms. With jitter: ~1s, ~2s, ~4s. */
const RETRY_BASE_MS = 1000;
const OVER_CONTEXT_RECOVERY_KEEP_TAIL = 12;

function jitter(ms: number): number {
  return ms * (0.75 + Math.random() * 0.5);
}

function tryRecoverPersistedOverflow(
  messages: UIMessage[],
  contextLimit: number,
): {
  recovered: boolean;
  messages: UIMessage[];
  info: { dropped: number; kept: number };
} {
  const { messages: trimmed, info } = compactUiMessages(messages, {
    contextLimit,
    keepTail: OVER_CONTEXT_RECOVERY_KEEP_TAIL,
    force: true,
  });
  return {
    recovered: info.dropped > 0,
    messages: trimmed,
    info,
  };
}

export function createContextAwareTransport(deps: Deps): ChatTransport<UIMessage> {
  // Per-session record of the `<env>` block each user message was SENT with.
  // Lives here (one transport per chat session) so it is replayed for the whole
  // conversation and dies with it. See `injectContext` for why replaying is
  // what makes any prompt cache hit past turn one.
  const sentEnv: SentEnvBlocks = new Map();

  return {
    async sendMessages({ messages, abortSignal }) {
      const correlationId = newCorrelationId();

      // Snapshot every per-turn knob ONCE, before any await, so a mid-turn
      // settings change cannot leak into this turn or its retries. The whole
      // turn runs against what was live at Send; new values apply next prompt.
      const snapshot = {
        keys: deps.getKeys(),
        modelId: deps.getModelId(),
        provider: deps.getSelectedProvider?.(),
        customInstructions: deps.getCustomInstructions(),
        agentPersona: deps.getAgentPersona(),
        lmstudioBaseURL: deps.getLmstudioBaseURL?.(),
        openaiCompatibleBaseURL: deps.getOpenaiCompatibleBaseURL?.(),
        planMode: deps.getPlanMode?.(),
        chatMode: usePreferencesStore.getState().chatMode,
      };

      const live = deps.getLive();
      // An approval answer is a new `sendMessages` call that CONTINUES the turn
      // (the thread ends on the assistant). It must keep the turn's pin and env
      // block: re-pinning read the cwd live, and with the ai-diff tab active that
      // is the right-most tab's terminal, so an approved relative write could
      // land in another project. The rebuilt <env> also re-priced the turn tail.
      const continuing = messages[messages.length - 1]?.role === "assistant";
      // Pin cwd + workspace root for the turn so a mid-turn tab switch cannot
      // move the agent into another folder - every tool resolves through
      // `ctx.getCwd()`, which otherwise reads the active terminal live. Mutate
      // the stable ctx rather than clone, to keep buildTools' cache hitting.
      if (!continuing) deps.toolContext.pinTurnCwd?.(live.cwd, live.workspaceRoot);
      // Memory reads and MCP loading are independent, so race them together in
      // one batch rather than awaiting memory then MCP - shaves a round of
      // pre-first-token latency off every turn. Pass the same cwd to both MCP
      // calls so the deduped connect (mcpClient.getMcpClient) is cwd-deterministic.
      // Chat mode sends no tools and a one-line system prompt, so all four of
      // these would be loaded, paid for in the prompt, and ignored - and MCP
      // servers would be connected for a turn that cannot call them. Skipping
      // is both the token saving and a latency one.
      const skip = snapshot.chatMode;
      // Both of these land in the SYSTEM PROMPT, so they are read against the
      // session-pinned root, not the live one. Reading them live meant that
      // focusing a terminal in another project dropped the `## PROJECT` block
      // mid-session and re-priced every cached token. Tools stay live via the
      // turn pin above; only the prompt holds still.
      const promptWorkspaceRoot = deps.toolContext.pinSessionWorkspaceRoot(live.workspaceRoot);
      const [projectMemory, memory, mcpTools] = await Promise.all([
        skip ? null : readProjectMemory(promptWorkspaceRoot),
        skip ? null : readMemory(promptWorkspaceRoot),
        skip ? undefined : buildMcpToolsAsync(deps.toolContext),
      ]);

      let requestMessages = messages;

      let lastError: unknown;
      let triedOverflowRecovery = false;
      // retry loop: each attempt depends on the previous failing
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (abortSignal?.aborted) {
          throw toChatError(
            tediError(TediErrorCode.ABORTED, "Request cancelled", { correlationId }),
          );
        }

        try {
          // The <env> block names terminals and cwd: ground truth for tools,
          // noise for a conversation that has none.
          const augmented = snapshot.chatMode
            ? requestMessages
            : injectContext(
                requestMessages,
                live,
                sentEnv,
                // Replaying past env blocks only pays for the byte-stable prefix
                // a prompt cache needs. Without one it is N stale blocks of
                // waste per request, so send just the newest.
                providerHasPromptCache(snapshot.provider ?? "sumopod"),
                !continuing,
              );
          const result = await runAgentStream({
            keys: snapshot.keys,
            modelId: snapshot.modelId,
            provider: snapshot.provider,
            customInstructions: snapshot.customInstructions,
            agentPersona: snapshot.agentPersona,
            toolContext: deps.toolContext,
            onStep: deps.onStep,
            onUsage: deps.onUsage,
            onCompact: deps.onCompact,
            onOverContext: () => {
              // Streaming over-context surfaces after runAgentStream returns, so
              // the synchronous catch below never sees it. Compact persisted
              // history here so the user's next send fits.
              const persisted = deps.getPersistedMessages?.();
              if (!persisted) return;
              const recovery = tryRecoverPersistedOverflow(
                persisted,
                getModelContextLimit(snapshot.modelId),
              );
              if (recovery.recovered) {
                deps.persistCompactedMessages?.(recovery.messages, recovery.info);
              }
            },
            onFinishMeta: deps.onFinishMeta,
            lmstudioBaseURL: snapshot.lmstudioBaseURL,
            openaiCompatibleBaseURL: snapshot.openaiCompatibleBaseURL,
            planMode: snapshot.planMode,
            chatMode: snapshot.chatMode,
            projectMemory,
            memory,
            mcpTools,
            uiMessages: augmented,
            abortSignal,
          });
          return result.toUIMessageStream({
            originalMessages: messages,
            // Without this the SDK default replaces every streaming failure with
            // "An error occurred.", which is what made a plain
            // "model not supported on this account" 400 undiagnosable. Nothing
            // here is server-side, so there is no detail to withhold.
            onError: describeProviderError,
          });
        } catch (err) {
          lastError = err;
          if (abortSignal?.aborted) {
            throw toChatError(
              tediError(TediErrorCode.ABORTED, "Request cancelled", { correlationId }),
            );
          }

          const code = classifyError(err);
          if (code === TediErrorCode.OVER_CONTEXT && !triedOverflowRecovery) {
            triedOverflowRecovery = true;
            const persisted = deps.getPersistedMessages?.() ?? requestMessages;
            const recovery = tryRecoverPersistedOverflow(
              persisted,
              getModelContextLimit(snapshot.modelId),
            );
            if (recovery.recovered) {
              deps.persistCompactedMessages?.(recovery.messages, recovery.info);
              requestMessages = recovery.messages;
              deps.onStep?.("Context full - compacting and retrying");
              continue;
            }
          }
          // Only retry on transient errors. Auth failures, no-key, etc.
          // should fail fast so the user can fix the root cause.
          if (code !== TediErrorCode.RATE_LIMITED && code !== TediErrorCode.PROVIDER_UNAVAILABLE) {
            break;
          }

          if (attempt < MAX_RETRIES) {
            const delay = jitter(RETRY_BASE_MS * Math.pow(2, attempt));
            deps.onStep?.(`Retrying in ${Math.round(delay / 1000)}s`);
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
            continue;
          }
        }
      }

      const finalCode = classifyError(lastError);
      const transient =
        finalCode === TediErrorCode.RATE_LIMITED ||
        finalCode === TediErrorCode.PROVIDER_UNAVAILABLE;
      const message = transient
        ? `Request failed after ${MAX_RETRIES + 1} attempts`
        : (lastError instanceof Error ? lastError.message : String(lastError)) || "Request failed";
      throw toChatError(
        tediError(finalCode, message, {
          detail: String(lastError instanceof Error ? lastError.message : lastError),
          correlationId,
        }),
      );
    },
    async reconnectToStream() {
      // In-process transport: nothing to reconnect to.
      return null;
    },
  };
}
