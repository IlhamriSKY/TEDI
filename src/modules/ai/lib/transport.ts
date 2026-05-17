import type { UIMessage } from "@ai-sdk/react";
import type { ChatTransport } from "ai";
import { type DynamicModelId } from "../config";
import { runAgentStream, type AgentUsageDelta } from "./agent";
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
  // Cache for 30s - cheap re-read after that to pick up edits.
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

type LiveSnapshot = {
  cwd: string | null;
  terminal: string | null;
  workspaceRoot: string | null;
  activeFile: string | null;
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
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  getPlanMode?: () => boolean;
};

export function createContextAwareTransport(deps: Deps): ChatTransport<UIMessage> {
  return {
    async sendMessages({ messages, abortSignal }) {
      const live = deps.getLive();
      const projectMemory = await readTediMd(live.workspaceRoot);
      const augmented = injectContext(messages, live);
      const result = await runAgentStream({
        keys: deps.getKeys(),
        modelId: deps.getModelId(),
        customInstructions: deps.getCustomInstructions(),
        agentPersona: deps.getAgentPersona(),
        toolContext: deps.toolContext,
        onStep: deps.onStep,
        onUsage: deps.onUsage,
        onCompact: deps.onCompact,
        onFinishMeta: deps.onFinishMeta,
        lmstudioBaseURL: deps.getLmstudioBaseURL?.(),
        openaiCompatibleBaseURL: deps.getOpenaiCompatibleBaseURL?.(),
        planMode: deps.getPlanMode?.(),
        projectMemory,
        uiMessages: augmented,
        abortSignal,
      });
      return result.toUIMessageStream({
        // Provide originalMessages so the SDK can assign a stable response
        // message ID for retry/edit flows in the Chat UI.
        originalMessages: messages,
      });
    },
    async reconnectToStream() {
      // Direct in-process transport: nothing to reconnect to.
      return null;
    },
  };
}

function injectContext(messages: UIMessage[], live: LiveSnapshot): UIMessage[] {
  const block = formatEnvBlock(live);
  if (!block) return messages;
  const lastUserIdx = lastIndex(messages, (m) => m.role === "user");
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

/** Minimal env block, prepended to the latest user message. Kept short so the
 *  cacheable conversation prefix stays as stable as possible across turns.
 *  Terminal scrollback is NOT auto-included anymore — the agent should ask
 *  the user to paste recent output when it genuinely needs it. */
function formatEnvBlock(live: LiveSnapshot): string | null {
  const lines: string[] = [];
  if (live.workspaceRoot) lines.push(`workspace_root: ${live.workspaceRoot}`);
  if (live.cwd) lines.push(`active_terminal_cwd: ${live.cwd}`);
  if (live.activeFile) lines.push(`active_file: ${live.activeFile}`);
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>\n\n`;
}

function lastIndex<T>(arr: T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) return i;
  return -1;
}

/** Match both the new <env> block and the legacy <terminal-context> block so
 *  message-history rendering can strip them cleanly. */
export const CONTEXT_BLOCK_RE =
  /^(?:<env>[\s\S]*?<\/env>|<terminal-context[^>]*>[\s\S]*?<\/terminal-context>)\n*/;

export function stripContextBlock(text: string): string {
  return text.replace(CONTEXT_BLOCK_RE, "");
}
