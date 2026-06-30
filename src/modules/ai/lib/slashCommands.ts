import {
  Add01Icon,
  CalendarAdd01Icon,
  CheckListIcon,
  Clock01Icon,
  EraserIcon,
  HelpCircleIcon,
  Minimize02Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { getModelContextLimit } from "../config";
import { flushPersist, getChat, useChatStore } from "../store/chatStore";
import { showInfoModal, type InfoRow } from "../store/infoModalStore";
import { usePlanStore } from "../store/planStore";
import { discardCheckpoint } from "./checkpoint";
import { compactUiMessages } from "./compact";
import { getMcpServers } from "./mcpConfig";
import { saveMessages } from "./sessions";
import { getLoadedSkills, loadSkills, skillSlug } from "./skills";

/**
 * Outcome of intercepting a slash command.
 * `handled`: ran; composer should not send. `send-prompt`: replace the
 * user text with `prompt` and send. `none`: not a command, send as usual.
 */
export type SlashOutcome =
  | { kind: "handled"; toast?: string; toastVariant?: "success" | "info" | "warning" | "error" }
  | { kind: "send-prompt"; prompt: string; commandName?: string }
  | { kind: "none" };

const INIT_PROMPT = `Scan this workspace and produce TEDI.md at the workspace root with:

- One-paragraph project description.
- Build / test / dev commands.
- Architecture overview (subsystems, data flow, key dirs).
- Conventions worth knowing (naming, patterns, gotchas).
- Paths to entry points.

Use grep/glob/list_directory/read_file to explore. Cap TEDI.md under 200 lines. Use write_file to create it (will go through normal approval).`;

export type SlashCommandMeta = {
  name: string;
  invocation: string;
  label: string;
  description: string;
  icon: typeof SparklesIcon;
  /** Optional argument hint, e.g. `[off]` for `#plan`. */
  argHint?: string;
  /** Show in the `#` picker only, not the `/` picker. For tag-like commands
   *  (`init`, `plan`) that persist on a message or the session. Ephemeral
   *  actions stay slash-only. */
  hashOnly?: boolean;
  /** True for installed-skill commands so the picker groups them separately. */
  isSkill?: boolean;
};

export const SLASH_COMMANDS: Record<string, SlashCommandMeta> = {
  help: {
    name: "help",
    invocation: "/help",
    label: "Show help",
    description: "List every slash command.",
    icon: HelpCircleIcon,
  },
  new: {
    name: "new",
    invocation: "/new",
    label: "New chat",
    description: "Start a fresh chat session.",
    icon: Add01Icon,
  },
  clear: {
    name: "clear",
    invocation: "/clear",
    label: "Clear messages",
    description: "Wipe the current chat history (keeps the session).",
    icon: EraserIcon,
  },
  history: {
    name: "history",
    invocation: "/history",
    label: "Chat history",
    description: "Open the session history picker.",
    icon: Clock01Icon,
  },
  compact: {
    name: "compact",
    invocation: "/compact",
    label: "Compact history",
    description: "Trim older messages to reclaim context (keeps the most recent turns).",
    icon: Minimize02Icon,
  },
  skills: {
    name: "skills",
    invocation: "/skills",
    label: "List skills",
    description: "Show installed skills (invoke one with /<name>).",
    icon: SparklesIcon,
  },
  mcp: {
    name: "mcp",
    invocation: "/mcp",
    label: "List MCP servers",
    description: "Show configured MCP servers and their status.",
    icon: CheckListIcon,
  },
  init: {
    name: "init",
    invocation: "#init",
    label: "Initialize workspace",
    description: "Scan the workspace and write TEDI.md project memory.",
    icon: SparklesIcon,
    hashOnly: true,
  },
  plan: {
    name: "plan",
    invocation: "#plan",
    label: "Plan mode",
    description: "Queue mutations for batch review. `#plan off` to disable.",
    icon: CheckListIcon,
    argHint: "[off]",
    hashOnly: true,
  },
  schedule: {
    name: "schedule",
    invocation: "/schedule",
    label: "Schedule command",
    description: "Schedule a terminal command to run at a specific time.",
    icon: CalendarAdd01Icon,
    argHint: "[time] [command]",
  },
};

/** Commands shown in the `/` picker. Excludes hash-only tag commands. */
export const VISIBLE_SLASH_COMMANDS: SlashCommandMeta[] = Object.values(SLASH_COMMANDS).filter(
  (c) => !c.hashOnly,
);

/** Commands shown in the `#` picker alongside snippets (tag-style commands). */
export const HASH_COMMANDS: SlashCommandMeta[] = Object.values(SLASH_COMMANDS).filter(
  (c) => c.hashOnly,
);

/** Installed skills surfaced as `/` commands (one per skill, named after it) so
 *  users can invoke one directly. Built live from the loaded-skills cache. */
export function skillSlashCommands(): SlashCommandMeta[] {
  // Full description; the picker clamps the display (line-clamp-2) so there's no
  // mid-word code truncation. Drop slugs colliding with a built-in command:
  // tryRunSlashCommand resolves built-ins first, so a collided skill is
  // unreachable — showing it as a duplicate `/` row would only mislead.
  return getLoadedSkills()
    .filter((s) => !(skillSlug(s) in SLASH_COMMANDS))
    .map((s) => ({
    name: skillSlug(s),
    invocation: `/${skillSlug(s)}`,
    label: s.name,
    description: s.description || "Skill",
    icon: SparklesIcon,
    isSkill: true,
    argHint: s.argHint,
  }));
}

export const TEDI_CMD_RE =
  /^<tedi-command\s+name="([a-z0-9-]+)"(?:\s+state="([a-z]+)")?\s*\/>(?:\n+|$)/;

function showHelp(): void {
  showInfoModal({
    id: "slash-help",
    title: "Composer commands",
    subtitle:
      "Type `/` for one-shot commands, `#` for tag commands & snippets, `@` for files. Tab or Enter to insert.",
    sections: [
      {
        title: "Slash commands (one-shot actions)",
        rows: VISIBLE_SLASH_COMMANDS.map((c) => ({
          kbd: c.argHint ? `${c.invocation} ${c.argHint}` : c.invocation,
          label: c.label,
          desc: c.description,
        })),
      },
      {
        title: "Hash commands (tag the message / session)",
        rows: HASH_COMMANDS.map((c) => ({
          kbd: c.argHint ? `${c.invocation} ${c.argHint}` : c.invocation,
          label: c.label,
          desc: c.description,
        })),
      },
      {
        title: "Other triggers",
        rows: [
          {
            kbd: "@",
            label: "Mention picker",
            desc: "Workspace files & folders (fuzzy search, scrollable).",
          },
          {
            kbd: "#handle",
            label: "Snippets",
            desc: "Reusable snippet handles from Settings → Agents.",
          },
        ],
      },
    ],
    footer: "Press Esc to dismiss this dialog.",
  });
}

/** Render a "what's installed" list into the info modal — shared by /skills and
 *  /mcp: a count subtitle when non-empty, a "where to add" hint when empty. */
function showListModal<T>(
  id: string,
  title: string,
  items: T[],
  whenSome: string,
  whenEmpty: string,
  row: (item: T) => InfoRow,
): void {
  showInfoModal({
    id,
    title,
    subtitle: items.length ? whenSome : whenEmpty,
    sections: items.length ? [{ rows: items.map(row) }] : [],
    footer: "Press Esc to dismiss.",
  });
}

/** Modal listing installed skills. Loads fresh so the list is accurate even if
 *  the picker cache hasn't warmed yet. */
function showSkillsList(): void {
  const root = useChatStore.getState().live.getWorkspaceRoot();
  void loadSkills(root).then((skills) =>
    showListModal(
      "slash-skills",
      "Installed skills",
      skills,
      `${skills.length} installed. Invoke one with /<name>, or manage in Settings → Agents → Skills.`,
      "None installed. Add a GitHub repo with SKILL.md files in Settings → Agents → Skills.",
      (s) => ({
        kbd: `/${skillSlug(s)}`,
        label: s.version ? `${s.name} v${s.version}` : s.name,
        desc: s.description || "Skill",
      }),
    ),
  );
}

/** Modal listing configured MCP servers and their enabled state. */
function showMcpList(): void {
  void getMcpServers().then((servers) =>
    showListModal(
      "slash-mcp",
      "MCP servers",
      servers,
      `${servers.filter((s) => s.enabled).length}/${servers.length} enabled. Manage in Settings → Agents → MCP Servers.`,
      "None configured. Add one in Settings → Agents → MCP Servers.",
      (s) => ({
        label: s.name,
        desc: `${s.command} ${s.args.join(" ")}`.trim(),
        // Name turns green when the server is enabled/connected (no kbd, so the
        // row renders as name (left) + command (right) - compact, no dot gutter).
        tone: s.enabled ? "ok" : undefined,
      }),
    ),
  );
}

function clearActiveChat(): SlashOutcome {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return { kind: "handled", toast: "No active session" };
  const chat = getChat(sessionId);
  if (chat) {
    // Optimistic clear so the UI feels instant.
    chat.messages = [];
    // Abort any in-flight stream then re-clear in case a chunk landed in the
    // gap between the assignment above and the abort taking effect. Fire-and-
    // forget so this stays a synchronous slash outcome.
    void chat
      .stop()
      .then(() => {
        if (chat.messages.length > 0) chat.messages = [];
      })
      .catch(() => {
        // Already stopped.
      });
  }
  // Drop the restore checkpoint; without this, Restore after `/clear` would
  // still revert mutations recorded against the cleared turns.
  discardCheckpoint(sessionId);
  // Hard-flush so the on-disk store sees `[]` even if the debounced timer
  // was about to write a stale snapshot.
  flushPersist(sessionId);
  void saveMessages(sessionId, []);
  state.resetAgentMeta();
  return { kind: "handled", toast: "Chat cleared", toastVariant: "success" };
}

function compactActiveChat(): SlashOutcome {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return { kind: "handled", toast: "No active session" };
  const chat = getChat(sessionId);
  if (!chat) return { kind: "handled", toast: "Chat not initialized yet" };
  const before = chat.messages.length;
  const contextLimit = getModelContextLimit(state.selectedModelId);
  // `force` so manual /compact always acts. The 70%-context gate would
  // otherwise make the slash command a silent no-op on most chats.
  const { messages: trimmed, info } = compactUiMessages(chat.messages, {
    contextLimit,
    keepTail: 12,
    force: true,
  });
  if (info.dropped === 0) {
    // Zero-drop here means the chat is shorter than keepTail.
    return {
      kind: "handled",
      toast: `Nothing to compact: only ${before} message${before === 1 ? "" : "s"}, all kept as recent context.`,
    };
  }
  // `chat.messages` is mutable on @ai-sdk/react Chat; assigning a fresh array notifies React.
  chat.messages = trimmed;
  flushPersist(sessionId);
  void saveMessages(sessionId, trimmed);
  // Stamp lastCompact so the context-indicator pulse fires for manual /compact.
  // Classified as Stage-3 "dropped" since it removes whole UI messages.
  state.patchAgentMeta({
    lastCompact: {
      at: Date.now(),
      stages: { lossless: 0, elided: 0, dropped: info.dropped },
    },
  });
  return {
    kind: "handled",
    toast: `Compacted: dropped ${info.dropped}, kept ${info.kept} of ${before}`,
    toastVariant: "success",
  };
}

export function tryRunSlashCommand(input: string): SlashOutcome {
  const trimmed = input.trim();
  const lead = trimmed[0];
  if (lead !== "/" && lead !== "#") return { kind: "none" };
  const [headRaw, ...rest] = trimmed.slice(1).split(/\s+/);
  const head = headRaw.toLowerCase();
  // Hash trigger only fires for registered commands; `#tag` stays free.
  if (lead === "#" && !SLASH_COMMANDS[head]) return { kind: "none" };
  const tail = rest.join(" ").trim();

  switch (head) {
    case "help":
      showHelp();
      return { kind: "handled" };
    case "new": {
      useChatStore.getState().newSession();
      return { kind: "handled", toast: "New chat", toastVariant: "success" };
    }
    case "clear":
      return clearActiveChat();
    case "history": {
      useChatStore.setState({ showHistoryPicker: true });
      return { kind: "handled" };
    }
    case "compact":
      return compactActiveChat();
    case "skills":
      showSkillsList();
      return { kind: "handled" };
    case "mcp":
      showMcpList();
      return { kind: "handled" };
    case "plan": {
      const store = usePlanStore.getState();
      if (tail === "off" || tail === "exit") {
        store.disable();
        return { kind: "handled", toast: "Plan mode off", toastVariant: "info" };
      }
      store.toggle();
      const nowActive = usePlanStore.getState().active;
      return {
        kind: "handled",
        toast: nowActive ? "Plan mode on" : "Plan mode off",
        toastVariant: "info",
      };
    }
    case "init":
      return {
        kind: "send-prompt",
        prompt: INIT_PROMPT,
        commandName: "init",
      };
    case "schedule": {
      if (!tail) return { kind: "none" };
      return {
        kind: "send-prompt",
        prompt: `Schedule a terminal command: ${tail}\n\nUse the schedule_command tool. Parse the time from the input (e.g., "in 5 minutes", "at 3pm", "tomorrow at 9am") and the command to run. If no terminal is specified, use the active terminal.`,
      };
    }
    default: {
      // Installed skill invoked by name, e.g. `/<skill> [task]`.
      if (lead === "/") {
        const skill = getLoadedSkills().find((s) => skillSlug(s) === head);
        if (skill) {
          // Clean body (no absolute path); the agent loads it via the `skill`
          // tool, which lists this skill by name.
          const task = tail ? ` Apply it to: ${tail}` : "";
          return {
            kind: "send-prompt",
            prompt: `Use the "${skill.name}" skill.${task}`,
            commandName: head,
          };
        }
      }
      return { kind: "none" };
    }
  }
}
