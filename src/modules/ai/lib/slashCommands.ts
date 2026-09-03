import {
  CalendarPlus,
  CircleHelp,
  Clock,
  Eraser,
  ListChecks,
  Minimize2,
  Plus,
  Sparkles,
  Target,
  type LucideIcon,
} from "lucide-react";
import { getModelContextLimit } from "../config";
import { flushPersist, getChat, useChatStore } from "../store/chatStore";
import { useGoalStore } from "../store/goalStore";
import { armGoalRun, disarmGoalRun, isGoalRunArmed } from "./goalRunner";
import { showInfoModal, type InfoRow } from "../store/infoModalStore";
import { usePlanStore } from "../store/planStore";
import { discardCheckpoint } from "./checkpoint";
import { compactUiMessages } from "./compact";
import { getMcpServers, TEDI_MCP_SERVER_NAME } from "./mcpConfig";
import { connectedMcpServers } from "./mcpClient";
import { saveMessages } from "./sessions";

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
  icon: LucideIcon;
  /** Optional argument hint, e.g. `[off]` for `>plan`. */
  argHint?: string;
  /** Show in the `>` picker only, not the `/` picker. For tag-like commands
   *  (`init`, `plan`) that persist on a message or the session. Ephemeral
   *  actions stay slash-only. */
  tagOnly?: boolean;
};

export const SLASH_COMMANDS: Record<string, SlashCommandMeta> = {
  help: {
    name: "help",
    invocation: "/help",
    label: "Show help",
    description: "List every slash command.",
    icon: CircleHelp,
  },
  new: {
    name: "new",
    invocation: "/new",
    label: "New chat",
    description: "Start a fresh chat session.",
    icon: Plus,
  },
  clear: {
    name: "clear",
    invocation: "/clear",
    label: "Clear messages",
    description: "Wipe the current chat history (keeps the session).",
    icon: Eraser,
  },
  history: {
    name: "history",
    invocation: "/history",
    label: "Chat history",
    description: "Open the session history picker.",
    icon: Clock,
  },
  compact: {
    name: "compact",
    invocation: "/compact",
    label: "Compact history",
    description: "Trim older messages to reclaim context (keeps the most recent turns).",
    icon: Minimize2,
  },
  mcp: {
    name: "mcp",
    invocation: "/mcp",
    label: "List MCP servers",
    description: "Show configured MCP servers and their status.",
    icon: ListChecks,
  },
  init: {
    name: "init",
    invocation: ">init",
    label: "Initialize workspace",
    description: "Scan the workspace and write TEDI.md project memory.",
    icon: Sparkles,
    tagOnly: true,
  },
  plan: {
    name: "plan",
    invocation: ">plan",
    label: "Plan mode",
    description: "Queue mutations for batch review. `>plan off` to disable.",
    icon: ListChecks,
    argHint: "[off]",
    tagOnly: true,
  },
  schedule: {
    name: "schedule",
    invocation: "/schedule",
    label: "Schedule command",
    description: "Schedule a terminal command to run at a specific time.",
    icon: CalendarPlus,
    argHint: "[time] [command]",
  },
  goal: {
    name: "goal",
    invocation: "/goal",
    label: "Session goal",
    description:
      "Set a goal and let the agent work it end to end, with a timer. `/goal done` to finish, `/goal clear` to stop it.",
    icon: Target,
    argHint: "[text | done | clear]",
  },
};

/** Commands shown in the `/` picker. Excludes tag-only commands. */
export const VISIBLE_SLASH_COMMANDS: SlashCommandMeta[] = Object.values(SLASH_COMMANDS).filter(
  (c) => !c.tagOnly,
);

/** Commands shown in the `>` picker alongside terminals and snippets. */
export const TAG_COMMANDS: SlashCommandMeta[] = Object.values(SLASH_COMMANDS).filter(
  (c) => c.tagOnly,
);

export const TEDI_CMD_RE =
  /^<tedi-command\s+name="([a-z0-9-]+)"(?:\s+state="([a-z]+)")?\s*\/>(?:\n+|$)/;

function showHelp(): void {
  showInfoModal({
    id: "slash-help",
    title: "Composer commands",
    subtitle:
      "Type `/` for one-shot commands, `>` for terminals, tag commands & snippets, `@` for files. Tab or Enter to insert.",
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
        title: "Tag commands (tag the message / session)",
        rows: TAG_COMMANDS.map((c) => ({
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
            kbd: ">",
            label: "Terminal picker",
            desc: "Insert a reference to an open terminal, e.g. #392. Click one in a reply to jump to it.",
          },
          {
            kbd: ">handle",
            label: "Snippets",
            desc: "Reusable snippet handles from Settings → Agents.",
          },
        ],
      },
    ],
    footer: "Press Esc to dismiss this dialog.",
  });
}

/** Render a "what's installed" list into the info modal for /mcp: a count
 *  subtitle when non-empty, a "where to add" hint when empty. */
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

/**
 * Modal listing the MCP servers, live state first.
 *
 * TWO SOURCES, and it needs both. The config file says what the user asked for;
 * the live client table says what the agent actually has. They disagree in two
 * ways that matter here:
 *
 *   - TEDI's OWN server (`tedi`) is in no config at all - it is synthesized per
 *     turn by `buildMcpToolsAsync` - so config alone never mentions the one
 *     server that is always present.
 *   - A configured server that failed to spawn still reads `enabled: true`, so
 *     config alone cannot tell a dead server from a working one.
 */
function showMcpList(): void {
  void getMcpServers().then((servers) => {
    const live = connectedMcpServers();
    // The built-in is listed UNCONDITIONALLY, not just when a client happens to
    // be up. It is synthesized fresh each turn and torn down when idle, so
    // deriving its presence from the live table alone would hide it on exactly
    // the occasion someone types `/mcp` to check whether it is there - before
    // the session's first turn.
    const rows = [
      {
        name: TEDI_MCP_SERVER_NAME,
        enabled: true,
        cmd: "built in - panes, terminals, browser, settings, SSH",
      },
      ...[...live.keys()]
        .filter((n) => n !== TEDI_MCP_SERVER_NAME && !servers.some((s) => s.name === n))
        .sort()
        .map((name) => ({ name, enabled: true, cmd: "connected" })),
      ...servers
        .filter((s) => s.name !== TEDI_MCP_SERVER_NAME)
        .map((s) => ({
          name: s.name,
          enabled: s.enabled,
          cmd: `${s.command} ${s.args.join(" ")}`.trim(),
        })),
    ];
    showListModal(
      "slash-mcp",
      "MCP servers",
      rows,
      `${live.size} connected, ${rows.length} listed. Manage in Settings → Agents → MCP Servers.`,
      "None configured. Add one in Settings → Agents → MCP Servers.",
      (r) => {
        const tools = live.get(r.name);
        return {
          label: r.name,
          // The tool count is the honest proof of "connected": a server that
          // handshook but listed nothing lends the agent nothing.
          desc:
            tools !== undefined
              ? `${tools} tool${tools === 1 ? "" : "s"} · ${r.cmd}`
              : r.enabled
                ? `not connected yet · ${r.cmd}`
                : `off · ${r.cmd}`,
          // Green means CONNECTED now, not merely ticked in a config file.
          tone: tools !== undefined ? "ok" : undefined,
        };
      },
    );
  });
}

function clearActiveChat(): SlashOutcome {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return { kind: "handled", toast: "No active session" };
  // A wiped thread has no turn to continue from, so an armed `/goal` run ends
  // with it. The goal itself stays set.
  disarmGoalRun(sessionId);
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

/**
 * `/goal <text>` sets it AND starts working on it, `/goal done` freezes the
 * timer, `/goal clear` drops it, bare `/goal` reports.
 *
 * Setting a goal used to be `handled`: it wrote a line into the system prompt
 * and then sat there until the user typed something else, which made `/goal`
 * read as a no-op. A goal is a job, so it now sends the opening turn and arms
 * the run loop (see goalRunner), which keeps sending until the model reports
 * the goal met or the turn ceiling stops it.
 */
function runGoalCommand(tail: string): SlashOutcome {
  const sessionId = useChatStore.getState().activeSessionId;
  if (!sessionId) return { kind: "handled", toast: "No active chat", toastVariant: "warning" };
  const store = useGoalStore.getState();
  const arg = tail.trim();
  const current = store.bySession[sessionId];

  if (arg === "done" || arg === "complete") {
    disarmGoalRun(sessionId);
    if (!current || current.completedAt !== null) {
      return { kind: "handled", toast: "No active goal", toastVariant: "info" };
    }
    store.completeGoal(sessionId);
    return { kind: "handled", toast: "Goal done", toastVariant: "success" };
  }
  if (arg === "clear" || arg === "off") {
    disarmGoalRun(sessionId);
    if (!current) return { kind: "handled", toast: "No goal set", toastVariant: "info" };
    store.clearGoal(sessionId);
    return { kind: "handled", toast: "Goal cleared", toastVariant: "info" };
  }
  if (!arg) {
    if (!current) {
      return { kind: "handled", toast: "No goal. Use /goal <text>", toastVariant: "info" };
    }
    const running = isGoalRunArmed(sessionId) ? ", running" : "";
    const state = current.completedAt === null ? `Goal${running}` : "Goal (done)";
    return { kind: "handled", toast: `${state}: ${current.text}`, toastVariant: "info" };
  }
  const goal = store.setGoal(sessionId, arg);
  if (!goal) {
    return { kind: "handled", toast: "Goal text is empty", toastVariant: "warning" };
  }
  armGoalRun(sessionId);
  // The goal itself is already in the system prompt from this turn on; the
  // prompt below is the "start now" the loop needs to have something to
  // continue FROM.
  return {
    kind: "send-prompt",
    prompt: `Work on the session goal now, end to end: ${goal.text}`,
    commandName: "goal",
  };
}

export function tryRunSlashCommand(input: string): SlashOutcome {
  const trimmed = input.trim();
  const lead = trimmed[0];
  if (lead !== "/" && lead !== ">") return { kind: "none" };
  const [headRaw, ...rest] = trimmed.slice(1).split(/\s+/);
  const head = headRaw.toLowerCase();
  // Tag trigger only fires for registered commands; `>anything-else` stays free.
  if (lead === ">" && !SLASH_COMMANDS[head]) return { kind: "none" };
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
    case "goal":
      return runGoalCommand(tail);
    case "schedule": {
      if (!tail) return { kind: "none" };
      return {
        kind: "send-prompt",
        prompt: `Schedule a terminal command: ${tail}\n\nUse the schedule_command tool. Parse the time from the input (e.g., "in 5 minutes", "at 3pm", "tomorrow at 9am") and the command to run. If no terminal is specified, use the active terminal.`,
      };
    }
    default: {
      return { kind: "none" };
    }
  }
}
