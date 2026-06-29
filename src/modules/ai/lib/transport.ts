import type { UIMessage } from "@ai-sdk/react";
import type { ChatTransport } from "ai";
import { findLastIndex } from "@/lib/utils";
import type { BrowserInfo, TerminalInfo } from "@/modules/scheduler/types";
import { type DynamicModelId } from "../config";
import { runAgentStream, type AgentUsageDelta } from "./agent";
import { formatSkillsPrompt, loadSkills } from "./skills";
import type { CompactStages } from "./compact";
import { classifyError, newCorrelationId, tediError, TediErrorCode, toChatError } from "./errors";
import type { ProviderKeys } from "./keyring";
import { native } from "./native";
import type { ToolContext } from "../tools/tools";

const TEDI_MD_MAX_BYTES = 32 * 1024;
type MemoryCacheEntry = { content: string | null; cachedAt: number };
const projectMemoryCache = new Map<string, MemoryCacheEntry>();

async function readTediMd(workspaceRoot: string | null): Promise<string | null> {
  if (!workspaceRoot) return null;
  const path = `${workspaceRoot.replace(/\/$/, "")}/TEDI.md`;
  const cached = projectMemoryCache.get(workspaceRoot);
  // Cache for 30s. Re-read after that to pick up edits.
  if (cached && Date.now() - cached.cachedAt < 30_000) return cached.content;
  try {
    const r = await native.readFile(path);
    if (r.kind !== "text") {
      projectMemoryCache.set(workspaceRoot, {
        content: null,
        cachedAt: Date.now(),
      });
      return null;
    }
    const content =
      r.content.length > TEDI_MD_MAX_BYTES ? r.content.slice(0, TEDI_MD_MAX_BYTES) : r.content;
    projectMemoryCache.set(workspaceRoot, {
      content,
      cachedAt: Date.now(),
    });
    return content;
  } catch {
    projectMemoryCache.set(workspaceRoot, {
      content: null,
      cachedAt: Date.now(),
    });
    return null;
  }
}

const MEMORY_MAX_BYTES = 32 * 1024;
const memoryCache = new Map<string, MemoryCacheEntry>();

/** Read durable project memory from `.tedi/memory/*.md` (Claude-CLI style),
 *  concatenated oldest-name first under per-file headers and capped in total.
 *  Cached 30s, mirroring readTediMd. Null when the folder is absent or empty. */
async function readMemory(workspaceRoot: string | null): Promise<string | null> {
  if (!workspaceRoot) return null;
  const dir = `${workspaceRoot.replace(/\/$/, "")}/.tedi/memory`;
  const cached = memoryCache.get(workspaceRoot);
  if (cached && Date.now() - cached.cachedAt < 30_000) return cached.content;
  let content: string | null = null;
  try {
    const files = (await native.readDir(dir))
      .filter((e) => e.name.toLowerCase().endsWith(".md"))
      .sort((a, b) => a.name.localeCompare(b.name));
    const blocks: string[] = [];
    let budget = MEMORY_MAX_BYTES;
    for (const f of files) {
      if (budget <= 0) break;
      const r = await native.readFile(`${dir}/${f.name}`);
      if (r.kind !== "text") continue;
      const body = r.content.length > budget ? r.content.slice(0, budget) : r.content;
      budget -= body.length;
      blocks.push(`### ${f.name}\n${body.trim()}`);
    }
    content = blocks.length > 0 ? blocks.join("\n\n") : null;
  } catch {
    content = null; // folder absent -> no memory
  }
  memoryCache.set(workspaceRoot, { content, cachedAt: Date.now() });
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
  getModelId: () => DynamicModelId;
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

function jitter(ms: number): number {
  return ms * (0.75 + Math.random() * 0.5);
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
      const augmented = injectContext(messages, live);

      let lastError: unknown;
      // retry loop: each attempt depends on the previous failing
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (abortSignal?.aborted) {
          throw toChatError(
            tediError(TediErrorCode.ABORTED, "Request cancelled", { correlationId }),
          );
        }

        try {
          const result = await runAgentStream({
            keys: snapshot.keys,
            modelId: snapshot.modelId,
            customInstructions: snapshot.customInstructions,
            agentPersona: snapshot.agentPersona,
            toolContext: deps.toolContext,
            onStep: deps.onStep,
            onUsage: deps.onUsage,
            onCompact: deps.onCompact,
            onFinishMeta: deps.onFinishMeta,
            lmstudioBaseURL: snapshot.lmstudioBaseURL,
            openaiCompatibleBaseURL: snapshot.openaiCompatibleBaseURL,
            planMode: snapshot.planMode,
            projectMemory,
            memory,
            skillsPrompt,
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
