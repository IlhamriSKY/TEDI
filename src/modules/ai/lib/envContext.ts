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
 * The replay is the whole point. Every prompt cache, explicit (Anthropic
 * `cacheControl`) or implicit (OpenAI, xAI, DeepSeek, Gemini, and any gateway
 * doing automatic prefix caching), keys on an exact byte prefix. This used to
 * inject the env into the newest user message ONLY, while the chat store
 * persists the message WITHOUT it (`toUIMessageStream({ originalMessages })`),
 * so on the next turn that same message came back one text part shorter than
 * when it was sent. The prefix therefore diverged at the previous user turn,
 * every single turn, and the divergence point crawled forward with the
 * conversation: nothing after the system prompt could ever be read back from
 * cache, no matter which provider was in use. Replaying the exact block keeps
 * the whole history byte-stable, so a turn pays only for its own delta.
 *
 * Cost: one stale env (~90 tokens) per past user turn. That buys not re-paying
 * the entire conversation at full write price on every turn.
 *
 * Deliberately keeps the block INSIDE the user message rather than appending it
 * as a trailing message: a trailing one would be a second consecutive `user`
 * message, which the Google provider emits as two consecutive `contents`
 * entries, and Gemini's alternation rule makes that a risk this fix does not
 * need to take.
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
