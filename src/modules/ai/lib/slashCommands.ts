import {
  CalendarPlus,
  CircleHelp,
  Clock,
  Eraser,
  ListChecks,
  Minimize2,
  Plus,
  Repeat,
  Sparkles,
  Target,
  type LucideIcon,
} from "lucide-react";
import { getModelContextLimit } from "../config";
import { flushPersist, getChat, openSendCheckpoint, useChatStore } from "../store/chatStore";
import { useGoalStore } from "../store/goalStore";
import { useTodosStore } from "../store/todoStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  MAX_GOAL_TURNS,
  armGoalRun,
  disarmGoalRun,
  isGoalRunArmed,
  pauseGoalRun,
} from "./goalRunner";
import { showInfoModal, type InfoRow } from "../store/infoModalStore";
import { usePlanStore } from "../store/planStore";
import { discardCheckpoint } from "./checkpoint";
import { compactUiMessages } from "./compact";
import { getMcpServers, getMcpServersEnabled, TEDI_MCP_SERVER_NAME } from "./mcpConfig";
import { connectedMcpServers } from "./mcpClient";
import { saveMessages } from "./sessions";
import { MAX_LOOP_RUNS, formatInterval, loopOf, parseInterval, startLoop, stopLoop } from "./loop";

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
  loop: {
    name: "loop",
    invocation: "/loop",
    label: "Repeat a prompt",
    description:
      "Send a prompt now and again every interval (min 1m), e.g. `/loop 10m check the CI run`. `/loop stop` ends it.",
    icon: Repeat,
    argHint: "[interval prompt | stop]",
  },
  goal: {
    name: "goal",
    invocation: "/goal",
    label: "Session goal",
    description:
      "Set a goal the agent works on until an independent check says it is met. Bare `/goal` resumes; `pause`, `done`, `clear`.",
    icon: Target,
    argHint: "[text | pause | done | clear]",
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
  void Promise.all([getMcpServers(), getMcpServersEnabled()]).then(([servers, serversOn]) => {
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
          // The master switch wins: a server ticked on under it is not started.
          enabled: serversOn && s.enabled,
          cmd: `${s.command} ${s.args.join(" ")}`.trim(),
        })),
    ];
    showListModal(
      "slash-mcp",
      "MCP servers",
      rows,
      serversOn
        ? `${live.size} connected, ${rows.length} listed. Manage in Settings → Agents → MCP Servers.`
        : `MCP servers are OFF: only the built-in one runs. Turn them on in Settings → Agents → MCP Servers.`,
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
  // The plan belonged to the wiped thread; a stale "5/5 done" strip over an
  // empty chat is a lie, and the goal gate would read it as open work.
  void useTodosStore.getState().clearSession(sessionId);
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
      stages: { lossless: 0, reasoning: 0, elided: 0, dropped: info.dropped },
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
/** Why a goal cannot run right now, or null. A loop needs tools and has to be
 *  able to apply what it does. */
function goalBlocker(): string | null {
  if (usePreferencesStore.getState().chatMode) {
    return "Chat mode has no tools, so a goal cannot run. Turn chat mode off first.";
  }
  if (usePlanStore.getState().active) {
    return "Plan mode only queues edits, so a goal would never finish. `>plan off` first.";
  }
  return null;
}

/**
 * Resume a paused goal: shared by bare `/goal`, `/goal resume` and the strip's
 * play button. Returns an error to show, or null when it resumed.
 *
 * If the turn that paused it failed before the model said anything, the thread
 * ends on a USER message and the settle effect (which acts only after an
 * assistant turn) would never move: re-send that turn instead.
 */
export function resumeGoal(sessionId: string): string | null {
  const goal = useGoalStore.getState().bySession[sessionId];
  if (!goal || goal.completedAt !== null) return "No open goal to resume";
  if (isGoalRunArmed(sessionId)) return "The goal is already running";
  const blocker = goalBlocker();
  if (blocker) return blocker;
  const chatState = useChatStore.getState();
  // The error that paused it must not pause it again on the first settle.
  if (chatState.agentMeta.status === "error") {
    chatState.patchAgentMeta({ status: "idle", error: null });
  }
  armGoalRun(sessionId);
  const chat = getChat(sessionId);
  const last = chat?.messages[chat.messages.length - 1];
  if (chat && last?.role === "user" && chat.status !== "submitted" && chat.status !== "streaming") {
    if (openSendCheckpoint(sessionId)) void chat.sendMessage();
  }
  return null;
}

function runGoalCommand(tail: string): SlashOutcome {
  const sessionId = useChatStore.getState().activeSessionId;
  if (!sessionId) return { kind: "handled", toast: "No active chat", toastVariant: "warning" };
  const store = useGoalStore.getState();
  const arg = tail.trim();
  const current = store.bySession[sessionId];
  const open = !!current && current.completedAt === null;

  if (arg === "pause" || arg === "stop") {
    if (!isGoalRunArmed(sessionId)) {
      return { kind: "handled", toast: "No goal is running", toastVariant: "info" };
    }
    pauseGoalRun(sessionId, "paused by you");
    return { kind: "handled", toast: "Goal paused. /goal to resume", toastVariant: "info" };
  }
  // Bare `/goal` RESUMES a paused goal (after Stop, an error, the turn budget,
  // or a restart), keeping its clock. It used to only report, so "re-run /goal
  // to continue" meant retyping the goal and restarting its timer.
  if (arg === "resume" || (!arg && open && !isGoalRunArmed(sessionId))) {
    const err = resumeGoal(sessionId);
    return err
      ? { kind: "handled", toast: err, toastVariant: "warning" }
      : { kind: "handled", toast: `Goal resumed: ${current!.text}`, toastVariant: "info" };
  }

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
    const run = useGoalStore.getState().runs[sessionId];
    const state = open
      ? `Goal, running (turn ${run?.turns ?? 0}/${MAX_GOAL_TURNS})`
      : "Goal (done)";
    return { kind: "handled", toast: `${state}: ${current.text}`, toastVariant: "info" };
  }
  const blocker = goalBlocker();
  if (blocker) return { kind: "handled", toast: blocker, toastVariant: "warning" };
  const goal = store.setGoal(sessionId, arg);
  if (!goal) {
    return { kind: "handled", toast: "Goal text is empty", toastVariant: "warning" };
  }
  armGoalRun(sessionId);
  // The goal is in the system prompt from this turn on, with the instructions
  // for driving it; the opening turn is the goal itself. Plain text on purpose:
  // it titles the session, and a wrapper ("work on it end to end") both became
  // the title and read as a fan-out cue to `wantsForcedFanout`.
  return { kind: "send-prompt", prompt: goal.text, commandName: "goal" };
}

/** `/loop <interval> <prompt>` starts, `/loop stop` ends, bare `/loop` reports. */
function runLoopCommand(tail: string): SlashOutcome {
  const sessionId = useChatStore.getState().activeSessionId;
  if (!sessionId) return { kind: "handled", toast: "No active chat", toastVariant: "warning" };
  const arg = tail.trim();
  if (arg === "stop" || arg === "off" || arg === "clear") {
    return stopLoop(sessionId)
      ? { kind: "handled", toast: "Loop stopped", toastVariant: "info" }
      : { kind: "handled", toast: "No loop running", toastVariant: "info" };
  }
  if (!arg) {
    const l = loopOf(sessionId);
    return {
      kind: "handled",
      toast: l
        ? `Every ${formatInterval(l.everyMs)} (${l.runs}/${MAX_LOOP_RUNS} runs): ${l.prompt}`
        : "No loop. Usage: /loop 10m <prompt>",
      toastVariant: "info",
    };
  }
  const [first, ...rest] = arg.split(/\s+/);
  const everyMs = parseInterval(first);
  const prompt = rest.join(" ").trim();
  if (everyMs === null || !prompt) {
    return {
      kind: "handled",
      toast: "Usage: /loop <interval> <prompt>, interval like 5m, 1h or 1h30m (at least 1m)",
      toastVariant: "warning",
    };
  }
  startLoop(sessionId, everyMs, prompt, useChatStore.getState);
  return {
    kind: "handled",
    toast: `Looping every ${formatInterval(everyMs)}. /loop stop to end it.`,
    toastVariant: "success",
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
      // ON, not a toggle: typing `>plan` to make sure it is on used to turn it
      // OFF and silently drop every queued edit. `>plan off` is the way out.
      const wasOn = store.active;
      store.enable();
      return {
        kind: "handled",
        toast: wasOn ? "Plan mode is already on (`>plan off` to leave it)" : "Plan mode on",
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
    case "loop":
      return runLoopCommand(tail);
    case "schedule": {
      if (!tail) {
        return {
          kind: "handled",
          toast: "Usage: /schedule <when> <command>, e.g. /schedule in 10m pnpm test",
          toastVariant: "info",
        };
      }
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
