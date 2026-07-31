import type { UIMessage } from "@ai-sdk/react";
import type { ChatTransport } from "ai";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { getModelContextLimit, type DynamicModelId, type ProviderId } from "../config";
import { injectContext, type LiveSnapshot, type SentEnvBlocks } from "./envContext";
import { runAgentStream, type AgentUsageDelta } from "./agent";
import { formatSkillsPrompt, loadSkills } from "./skills";
import { buildMcpToolsAsync, getMcpToolsSummary } from "../tools/mcp";
import { compactUiMessages } from "./compact";
import type { CompactStages } from "./compact";
import { classifyError, newCorrelationId, tediError, TediErrorCode, toChatError } from "./errors";
import type { ProviderKeys } from "./keyring";
import { native, type DirEntry } from "./native";
import { subscribeMemoryPathChanges } from "./memoryCache";
import type { ToolContext } from "../tools/tools";

// Preload budget for the workspace-root memory file (TEDI.md). It lands in the
// cacheable system-prompt prefix every turn, so an exhaustive doc (this repo's
// own TEDI.md is >100 KB) would dominate the prompt even for a "hi". Bound it to
// a compact head; the full doc stays one read_file away (see boundProjectMemory).
const TEDI_MD_PRELOAD_BYTES = 12 * 1024;
const PROJECT_MEMORY_TRUNCATION_NOTE =
  "\n\n[TEDI.md is large; only its header is preloaded here. Full architecture reference (backend/frontend internals, PTY daemon, module layout) is on disk - use read_file on TEDI.md when a task needs subsystem depth.]";

/** Bound the preloaded project-memory doc so it does not dominate the prompt.
 *  Under budget: return trimmed as-is. Over budget: cut at the last markdown
 *  section header (\n#{1,6} ) at or before the budget so it never severs a table
 *  or sentence, then append a read-on-demand pointer. Falls back to a paragraph
 *  break, then a hard slice, when no header sits in range.
 *  Note: head-truncation, not section-aware pruning; good enough because the
 *  useful head (identity, stack, commands, backend map) leads the doc. */
function boundProjectMemory(content: string, budget = TEDI_MD_PRELOAD_BYTES): string {
  const trimmed = content.trim();
  if (trimmed.length <= budget) return trimmed;
  const window = trimmed.slice(0, budget);
  let sectionCut = -1;
  for (const m of window.matchAll(/\n#{1,6} /g)) sectionCut = m.index ?? sectionCut;
  const cut = sectionCut > 0 ? sectionCut : window.lastIndexOf("\n\n");
  const head = (cut > 0 ? trimmed.slice(0, cut) : window).trimEnd();
  return head + PROJECT_MEMORY_TRUNCATION_NOTE;
}
type FileSignature = { mtime: number; size: number };
type ProjectMemoryCacheEntry = {
  content: string | null;
  cachedAt: number;
  signature?: FileSignature;
};
type FolderMemoryCacheEntry = { content: string | null; cachedAt: number; signature?: string };
const projectMemoryCache = new Map<string, ProjectMemoryCacheEntry>();

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
  if (normalized.endsWith("/tedi.md")) {
    const workspaceRoot = normalized.slice(0, -"/tedi.md".length);
    projectMemoryCache.delete(workspaceRoot);
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

async function readFileSignature(path: string): Promise<FileSignature | null> {
  const slash = path.replace(/\\/g, "/");
  const idx = slash.lastIndexOf("/");
  const dir = idx === -1 ? "." : path.slice(0, idx);
  const name = idx === -1 ? path : slash.slice(idx + 1);
  try {
    const entries = await native.readDir(dir);
    const match = entries.find((entry) => entry.name === name);
    return match ? { mtime: match.mtime, size: match.size } : null;
  } catch {
    return null;
  }
}

async function readTediMd(workspaceRoot: string | null): Promise<string | null> {
  if (!workspaceRoot) return null;
  const key = memoryCacheKey(workspaceRoot);
  const path = `${workspaceRoot.replace(/\/$/, "")}/TEDI.md`;
  const cached = projectMemoryCache.get(key);
  // Cache for 30s. Re-read after that to pick up edits.
  if (cached && Date.now() - cached.cachedAt < 30_000) return cached.content;
  try {
    const signature = await readFileSignature(path);
    if (
      cached &&
      signature &&
      cached.signature &&
      cached.signature.mtime === signature.mtime &&
      cached.signature.size === signature.size
    ) {
      projectMemoryCache.set(key, {
        content: cached.content,
        cachedAt: Date.now(),
        signature,
      });
      return cached.content;
    }
    const r = await native.readFile(path);
    if (r.kind !== "text") {
      projectMemoryCache.set(key, {
        content: null,
        cachedAt: Date.now(),
        signature: signature ?? undefined,
      });
      return null;
    }
    const content = boundProjectMemory(r.content);
    projectMemoryCache.set(key, {
      content,
      cachedAt: Date.now(),
      signature: signature ?? undefined,
    });
    return content;
  } catch {
    projectMemoryCache.set(key, {
      content: null,
      cachedAt: Date.now(),
    });
    return null;
  }
}

const MEMORY_MAX_BYTES = 32 * 1024;
const memoryCache = new Map<string, FolderMemoryCacheEntry>();
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
 *  Cached 30s, mirroring readTediMd. Null when the folder is absent or empty. */
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

      // Snapshot every per-turn knob ONCE, BEFORE any await, so a mid-turn
      // settings change (model/provider swap, key rotation, persona switch,
      // plan toggle) can't leak into a retry attempt or even into the first
      // attempt of this same turn. The whole turn, including every backoff
      // retry, runs against the values that were live when the user pressed
      // Send. New values take effect on the next user prompt.
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
      // Pin cwd + workspace root to this turn's snapshot so a mid-turn tab
      // switch can't move the agent (or its sub-agents) into another folder:
      // every tool resolves paths through `ctx.getCwd()`, which otherwise reads
      // the *currently active* terminal live. Mutate the stable session context
      // (re-pinned each turn) rather than cloning, so buildTools' per-ctx cache
      // keeps hitting. The UI/<env> read live cwd directly, so they stay live.
      deps.toolContext.pinTurnCwd?.(live.cwd, live.workspaceRoot);
      // Memory reads and MCP loading are independent, so race them together in
      // one batch rather than awaiting memory then MCP - shaves a round of
      // pre-first-token latency off every turn. Pass the same cwd to both MCP
      // calls so the deduped connect (mcpClient.getMcpClient) is cwd-deterministic.
      const mcpCwd = deps.toolContext.getCwd?.() ?? undefined;
      // Chat mode sends no tools and a one-line system prompt, so all five of
      // these would be loaded, paid for in the prompt, and ignored - and MCP
      // servers would be connected for a turn that cannot call them. Skipping
      // is both the token saving and a latency one.
      const skip = snapshot.chatMode;
      const [projectMemory, memory, skills, mcpTools, mcpSummary] = await Promise.all([
        skip ? null : readTediMd(live.workspaceRoot),
        skip ? null : readMemory(live.workspaceRoot),
        skip ? [] : loadSkills(live.workspaceRoot),
        skip ? undefined : buildMcpToolsAsync(deps.toolContext),
        skip ? null : getMcpToolsSummary(mcpCwd),
      ]);
      const skillsPrompt = formatSkillsPrompt(skills);

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
          // The <env> block names terminals, cwd, and browser panes: ground
          // truth for tools, noise for a conversation that has none.
          const augmented = snapshot.chatMode
            ? requestMessages
            : injectContext(requestMessages, live, sentEnv);
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
            skillsPrompt,
            mcpTools,
            mcpSummary,
            uiMessages: augmented,
            abortSignal,
          });
          return result.toUIMessageStream({
            originalMessages: messages,
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
              deps.onStep?.("Context full - compacting and retrying…");
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
            deps.onStep?.(`Retrying in ${Math.round(delay / 1000)}s…`);
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
