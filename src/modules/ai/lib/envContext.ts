import type { UIMessage } from "@ai-sdk/react";
import { findLastIndex } from "@/lib/utils";
import type { BrowserInfo, TerminalInfo } from "@/modules/scheduler/types";

/**
 * The per-turn `<env>` block and where it goes in the message list.
 *
 * Split out of `transport.ts` so the placement rule is testable on its own
 * (`scripts/prompt-cache-verify.ts`): it is the single thing that decides
 * whether ANY prompt cache can hit on turn two, and it is not obvious.
 */

export type LiveSnapshot = {
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

/** `<env>` blocks already SENT, keyed by user-message id. One per chat session;
 *  see `injectContext` for why replaying them matters. */
export type SentEnvBlocks = Map<string, string>;

/**
 * Prefix each user message with the `<env>` block it was SENT with, and the
 * newest one with a freshly-measured block.
 *
 * The replay is the whole point. Every prompt cache keys on an exact byte
 * prefix. Injecting into the newest user message only made the prefix diverge
 * EVERY turn, because the store persists that message without the env, so it
 * came back shorter than it was sent. Nothing after the system prompt could ever
 * be read from cache, on any provider. Replaying the exact block costs one stale
 * env (~90 tokens) per past turn and keeps the history byte-stable.
 *
 * The block stays INSIDE the user message: a trailing one would be a second
 * consecutive `user` message, which Gemini's alternation rule rejects.
 */
export function injectContext(
  messages: UIMessage[],
  live: LiveSnapshot,
  sentEnv: SentEnvBlocks,
): UIMessage[] {
  const lastUserIdx = findLastIndex(messages, (m) => m.role === "user");
  if (lastUserIdx === -1) return messages;

  // Forget ids that left the conversation (history compaction, a deleted turn,
  // a rebuilt session) so the map cannot grow without bound.
  const present = new Set(messages.map((m) => m.id));
  for (const id of sentEnv.keys()) {
    if (!present.has(id)) sentEnv.delete(id);
  }

  const fresh = formatEnvBlock(live);
  if (fresh) sentEnv.set(messages[lastUserIdx].id, fresh);

  return messages.map((m) => {
    if (m.role !== "user") return m;
    const block = sentEnv.get(m.id);
    if (!block) return m;
    return {
      ...m,
      parts: [{ type: "text" as const, text: block }, ...m.parts] as UIMessage["parts"],
    };
  });
}

/** Env block prepended to a user message. Short so the cacheable prefix stays
 *  stable. Terminal scrollback is not included; the agent calls `read_terminal`
 *  when needed. */
export function formatEnvBlock(live: LiveSnapshot): string | null {
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
