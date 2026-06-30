import type { UIMessage } from "@ai-sdk/react";
import type { ChatTransport } from "ai";
import { findLastIndex } from "@/lib/utils";
import type { BrowserInfo, TerminalInfo } from "@/modules/scheduler/types";
import { getModelContextLimit, type DynamicModelId, type ProviderId } from "../config";
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

const TEDI_MD_MAX_BYTES = 32 * 1024;
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
    const content =
      r.content.length > TEDI_MD_MAX_BYTES ? r.content.slice(0, TEDI_MD_MAX_BYTES) : r.content;
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

type LiveSnapshot = {
  cwd: string | null;
  workspaceRoot: string | null;
  activeFile: string | null;
  /** Every terminal in tab order. Surfaced in the per-turn <env> so the AI
   *  can address terminals by ordinal/title without `list_terminals`. */
  terminals: TerminalInfo[];
  /** Every open in-app browser pane, so the AI can see what the user is
   *  viewing (URL + tab/leaf ids) without a tool call. */
  browsers: BrowserInfo[];
};

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
      };

      const live = deps.getLive();
      const [projectMemory, memory, skills] = await Promise.all([
        readTediMd(live.workspaceRoot),
        readMemory(live.workspaceRoot),
        loadSkills(live.workspaceRoot),
      ]);
      const skillsPrompt = formatSkillsPrompt(skills);

      // Load MCP tools and summary (async, parallel). Pass the same cwd to both
      // so the deduped connect (mcpClient.getMcpClient) is cwd-deterministic.
      const mcpCwd = deps.toolContext.getCwd?.() ?? undefined;
      const [mcpTools, mcpSummary] = await Promise.all([
        buildMcpToolsAsync(deps.toolContext),
        getMcpToolsSummary(mcpCwd),
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
          const augmented = injectContext(requestMessages, live);
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

function injectContext(messages: UIMessage[], live: LiveSnapshot): UIMessage[] {
  const block = formatEnvBlock(live);
  if (!block) return messages;
  const lastUserIdx = findLastIndex(messages, (m) => m.role === "user");
  if (lastUserIdx === -1) return messages;

  return messages.map((m, i) => {
    if (i !== lastUserIdx) return m;
    const contextPart = { type: "text" as const, text: block };
    return {
      ...m,
      parts: [contextPart, ...m.parts] as UIMessage["parts"],
    };
  });
}

/** Env block prepended to the latest user message. Short so the cacheable
 *  prefix stays stable. Terminal scrollback is not included; the agent calls
 *  `read_terminal` when needed. */
function formatEnvBlock(live: LiveSnapshot): string | null {
  const lines: string[] = [];
  if (live.workspaceRoot) lines.push(`workspace_root: ${live.workspaceRoot}`);
  if (live.cwd) lines.push(`active_terminal_cwd: ${live.cwd}`);
  if (live.activeFile) lines.push(`active_file: ${live.activeFile}`);
  if (live.terminals.length > 0) {
    // One line per terminal: `#<ord><*> tab=<tabId> leaf=<leafId> <title> <cwd>`.
    // The asterisk marks the focused terminal.
    lines.push("terminals:");
    for (const t of live.terminals) {
      const star = t.isActive ? "*" : " ";
      const cwd = t.cwd ?? "";
      lines.push(
        `  #${t.ordinal}${star} tab=${t.tabId} leaf=${t.leafId} ${t.title}${cwd ? "  " + cwd : ""}`,
      );
    }
  }
  if (live.browsers.length > 0) {
    // In-app browser panes the user is viewing. The asterisk marks the focused
    // one. The agent can open/reuse a browser with `open_browser`.
    lines.push("browsers:");
    for (const b of live.browsers) {
      const star = b.isActive ? "*" : " ";
      lines.push(`  ${star} tab=${b.tabId} leaf=${b.leafId} ${b.url || "(blank)"}`);
    }
  }
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>\n\n`;
}
