/**
 * What each TEDI tool DOES. One implementation, reached three ways: `tedi <verb>`, the
 * stdio MCP server (`server.mjs`) and TEDI's own agent (`ai/tools/tedi.ts`).
 *
 * WHY ONE. There used to be two sets of handlers, and they drifted the way the two
 * schemas once did. `sh` from outside typed into a pane running a build while its own
 * description said that was refused; `read terminal` with nothing named answered from
 * whichever pane mounted last, where the in-app one asked which you meant.
 *
 * ZERO IMPORTS, for the reason `tools.mjs` has none: this file ships beside `server.mjs`
 * with no `node_modules`, and the app bundle imports it too, with no `node:` builtins.
 * Anything that needs Node (real input, a temp file) stays in `server.mjs`.
 *
 * A handler takes `call(capability, ...args)` and arguments `validateArgs` has passed.
 * It answers with data or a one-line sentence, or throws a sentence. Turning data into a
 * table, JSON or an MCP block is the caller's job, so no caller ever parses JSON back.
 */
import { WindowInput } from "./input.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The cap `read` applies when not told otherwise. */
const MAX_CHARS = 20000;

const clip = (text, cap) =>
  text.length > cap ? `${text.slice(0, cap)}\n\n[truncated at ${cap} chars]` : text;

/** A capability's `{ok}` answer, or its reason. Some answer a bare sentence instead. */
function unwrap(r) {
  if (typeof r === "string") throw new Error(r);
  if (!r || r.ok !== true) throw new Error(String(r?.error ?? r ?? "no answer from TEDI"));
  const { ok: _ok, ...rest } = r;
  return rest;
}

/** Rows holding `filter` anywhere, so one word narrows any list. */
export function narrowed(list, filter) {
  if (!filter) return list;
  const needle = String(filter).toLowerCase();
  return list.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
}

/** A value this long is a palette or a layout, and asking for the list should not cost it. */
const FOLD_SETTING_AT = 200;

function settingsAnswer(all, filter) {
  const needle = filter ? String(filter).toLowerCase() : null;
  return Object.fromEntries(
    Object.entries(all).flatMap(([key, value]) => {
      if (needle) return key.toLowerCase().includes(needle) ? [[key, value]] : [];
      const size = JSON.stringify(value ?? null).length;
      return [[key, size > FOLD_SETTING_AT ? `(${size} chars: filter "${key}" shows it)` : value]];
    }),
  );
}

/** Names only: an extension's tool schemas are most of this answer, and asking which
 *  extensions exist should not cost them. A filter asks about one, and gets them. */
function extensionsAnswer(all, filter) {
  const rows = narrowed(all, filter);
  if (filter) return rows;
  return rows.map(({ aiTools, commands, panels, ...e }) => ({
    ...e,
    aiTools: (aiTools ?? []).map((t) => t.name),
    commands: (commands ?? []).map((c) => c.id),
    panels: (panels ?? []).map((p) => p.id),
  }));
}

/**
 * Which terminal a call means.
 *
 * A leafId that is not a terminal is never redirected, and nothing named with several
 * open is a question, not a guess: answering about pane A with pane B's output, labelled
 * as success, is the one failure no error message ever follows.
 */
export async function resolveTerminal(call, leafId) {
  let rows = await call("termProbe", null, false);
  if (leafId !== undefined && leafId !== null) {
    const want = Number(leafId);
    if (rows.some((r) => r.leafId === want)) return want;
    // A just-opened pane is in the tab tree before its xterm handle registers, so an id
    // `pane open` just handed back is not addressable for another render tick. The wait
    // lives here to cover a pane opened any way at all.
    const known = await call("termList");
    if (known.some((t) => t.leafId === want)) {
      for (let i = 0; i < 15; i++) {
        await sleep(100);
        rows = await call("termProbe", null, false);
        if (rows.some((r) => r.leafId === want)) return want;
      }
    }
    throw new Error(
      `Leaf ${want} is not a terminal. Terminals: ${rows.map((r) => r.leafId).join(", ") || "(none)"}`,
    );
  }
  if (!rows.length) throw new Error('No terminal pane is open. Use `pane` with action "open".');
  const focused = await call("focusedLeaf");
  if (focused !== null && rows.some((r) => r.leafId === focused)) return focused;
  if (rows.length === 1) return rows[0].leafId;
  throw new Error(
    `Focus is not in a terminal and ${rows.length} are open - pass leafId. Terminals: ${rows.map((r) => r.leafId).join(", ")}`,
  );
}

/**
 * Block until a terminal is done. With no `needle` that is the prompt; with one, that
 * string appearing, the only signal for something that never returns. A timeout is
 * reported, not thrown: "it is still going" is an answer.
 */
async function waitTerminal(call, leaf, needle, timeout, lines = 8) {
  const deadline = Date.now() + timeout;
  const finish = async (done, reason) => {
    const t = (await call("termTails", lines, leaf)).find((x) => x.leafId === leaf);
    return { leafId: leaf, done, reason, tail: t?.text ?? "" };
  };
  for (;;) {
    await sleep(250);
    const row = (await call("termProbe", needle, false, leaf)).find((r) => r.leafId === leaf);
    if (!row) return finish(false, "the pane closed");
    if (needle) {
      if (row.hit) return finish(true, `"${needle}" appeared`);
    } else if (row.atPrompt && !row.running) {
      return finish(true, "back at the prompt");
    }
    if (Date.now() > deadline) return finish(false, "timeout");
  }
}

/**
 * Whether a pane that is not at a prompt is reading its own input. A full-screen program
 * is; so is a known AI CLI, which may draw on the normal screen and otherwise looks
 * exactly like a build running there.
 */
async function readsInput(call, leaf) {
  if (await call("termAltScreen", leaf)) return true;
  return (await call("panes")).some((p) => p.leafId === leaf && p.agent);
}

/**
 * Whether the pane's last line ends the way a prompt does. shortcut: a prompt with text to the
 * right of its cursor reads as busy, and a command whose output ends in `>` reads as idle; a
 * capability exposing the shell-integration state would answer this properly.
 */
async function endsLikePrompt(call, leaf) {
  const row = (await call("termTails", 1, leaf)).find((t) => t.leafId === leaf);
  return /[$#%>❯➜λ»]$/.test((row?.text ?? "").trimEnd());
}

/** Run a command in the user's terminal and return what it printed. */
async function sh(call, a) {
  const command = String(a.command ?? "").replace(/[\r\n]+$/, "");
  const leaf = await resolveTerminal(call, a.leafId);

  // Before the busy check: its own SSH channel never touches the pane, and reading a file
  // while a build runs is exactly when this matters.
  if (a.capture === true) {
    const text = await call("sshExec", leaf, command);
    if (typeof text === "string" && text.startsWith(`Leaf ${leaf} is not a connected SSH pane`)) {
      throw new Error(
        `${text} \`capture\` runs off-screen over an SSH channel, so it needs one. For a LOCAL pane use your own shell tool, which is the same thing on this machine.`,
      );
    }
    return { leafId: leaf, command, captured: true, text };
  }

  // A command on the normal screen is not reading stdin, so a write lands in its input, and a
  // half-typed line would merge with it. Neither signal is enough alone: `atPrompt` guesses from
  // the prompt's text and reads false on an idle `$ ` or `❯ `, and `running` needs OSC 133, which
  // pwsh never sends for a command written to the PTY. So what the pane last printed decides.
  const probed = (await call("termProbe", null, false, leaf)).find((r) => r.leafId === leaf);
  let intoTui = false;
  if (probed && (probed.running || !probed.atPrompt)) {
    intoTui = await readsInput(call, leaf);
    if (!intoTui && (probed.running || !(await endsLikePrompt(call, leaf)))) {
      throw new Error(
        `Terminal ${leaf} is busy (not at a prompt: a command is running, or a line is half typed); a write would land in the middle of that. To SEE what it is doing use read({source:"terminal", leafId:${leaf}}), or wait_for_terminal({leafId:${leaf}}) to block until it finishes. Only open another pane if you need to run something ALONGSIDE it.`,
      );
    }
  }

  // A raw PTY write with no bracketed paste, so an embedded newline would run the
  // following lines with nobody asking.
  if (a.submit === false) {
    if (/[\r\n]/.test(command)) {
      throw new Error(
        "Refused: typing without running cannot contain a newline - it would auto-run the following lines. Drop `submit: false` to execute it.",
      );
    }
    const typed = await call("termInject", leaf, command);
    if (typed !== true) throw new Error(String(typed));
    return { leafId: leaf, command, typed: true, submitted: false };
  }

  const before = (await call("termProbe", null, true, leaf)).find((r) => r.leafId === leaf);
  const run = await call("termRun", leaf, command);
  if (run !== true) throw new Error(String(run));

  // "The buffer CHANGED and the prompt is back", not just "the prompt is back": submitting
  // returns before the shell has echoed anything, so a bare prompt check passes against
  // the PREVIOUS prompt and reads the output before it exists. The floor is because `10`
  // meaning ten seconds is the obvious misread of a millisecond argument.
  const deadline = Date.now() + Math.max(1000, Number(a.timeout) || 20000);
  let changed = false;
  let quiet = 0;
  let lastHash = before?.hash;
  let timedOut = false;
  let startedTui = false;
  if (intoTui) {
    // No prompt is coming from a program reading its own input. One settle is what "it
    // landed" looks like there.
    await sleep(400);
  } else {
    for (;;) {
      await sleep(150);
      const now = (await call("termProbe", null, true, leaf)).find((r) => r.leafId === leaf);
      if (!now) throw new Error(`Terminal ${leaf} disappeared mid-command.`);
      if (!changed && now.hash !== before?.hash) changed = true;
      // It opened a full-screen program. That worked, and waiting for a prompt would burn
      // the timeout and then report one on a launch that succeeded.
      if (now.alt) {
        startedTui = true;
        break;
      }
      quiet = now.hash === lastHash ? quiet + 1 : 0;
      lastHash = now.hash;
      // A prompt nothing recognises never reads as one, and pwsh reports nothing running. Output
      // that has stopped for about a second AND a last line shaped like a prompt is that prompt;
      // `Start-Sleep 5` goes quiet too, with the command still on its last line.
      if (
        changed &&
        !now.running &&
        (now.atPrompt || (quiet >= 7 && (await endsLikePrompt(call, leaf))))
      ) {
        break;
      }
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
    }
  }
  const tail = (await call("termTails", a.lines ?? 60, leaf)).find((t) => t.leafId === leaf);
  return {
    leafId: leaf,
    command,
    timedOut,
    ...(intoTui ? { intoTui: true } : {}),
    ...(startedTui ? { startedTui: true } : {}),
    text: tail?.text ?? "",
  };
}

async function pane(call, a) {
  const leaf = () => {
    if (a.leafId === undefined) throw new Error(`${a.action} needs \`leafId\`.`);
    return a.leafId;
  };
  switch (a.action) {
    case "open": {
      const count = Math.min(Math.max(Number(a.count ?? 1), 1), 6);
      const opened = [];
      let tabId = a.tabId ?? null;
      for (let i = 0; i < count; i++) {
        // count>1 keeps the rest in the tab the first landed in: one group, not N tabs.
        const r = unwrap(
          await call("paneOpen", {
            cwd: a.cwd ?? null,
            mode: a.split === true || i > 0 ? "split" : "tab",
            splitDir: a.dir ?? "row",
            targetTabId: tabId,
          }),
        );
        tabId = r.tabId;
        opened.push(r);
        // The next open reads committed state, and against a stale pane count the updater
        // refuses a split this has already answered for.
        if (i < count - 1) await sleep(60);
      }
      return { opened };
    }
    case "close": {
      if (a.all === true) {
        const terms = await call("termList");
        let closed = 0;
        // Last to first, so the survivor the app refuses to close is the first terminal.
        for (const t of terms.slice(1).reverse()) {
          const r = await call("paneClose", t.leafId);
          if (r?.ok === true) closed++;
        }
        return `closed ${closed} of ${terms.length} terminals`;
      }
      if (a.leafId === undefined) throw new Error("close needs `leafId`, or `all`.");
      const r = unwrap(await call("paneClose", a.leafId));
      return `closed leaf ${a.leafId}${r.closedTab ? " (and its tab)" : ""}`;
    }
    case "group":
      if (!Array.isArray(a.leafIds) || a.leafIds.length < 2) {
        throw new Error("group needs `leafIds` with two or more panes (see `state`).");
      }
      return unwrap(await call("paneGroup", a.leafIds, a.tabId));
    case "rotate": {
      const r = unwrap(await call("paneRotate", leaf(), a.dir));
      return `leaf ${a.leafId} is now ${r.orientation}${r.changed ? "" : " (already)"}`;
    }
    case "consolidate": {
      const terms = await call("termList");
      if (terms.length < 2) throw new Error("Fewer than two terminals are open.");
      return unwrap(await call("paneConsolidate", a.tabId ?? terms[0].tabId));
    }
    case "rename":
      unwrap(await call("paneRename", leaf(), a.name ?? ""));
      return a.name ? `leaf ${a.leafId} is now "${a.name}"` : `leaf ${a.leafId} name reset`;
    case "pin":
      unwrap(await call("panePin", leaf(), a.pinned !== false));
      return `${a.pinned === false ? "unpinned" : "pinned"} the tab of leaf ${a.leafId}`;
    case "place": {
      const rect = Object.fromEntries(
        ["x", "y", "w", "h"].filter((k) => typeof a[k] === "number").map((k) => [k, a[k]]),
      );
      unwrap(await call("panePlace", leaf(), rect));
      return `leaf ${a.leafId} placed`;
    }
    case "panel":
      if (!a.extensionId) throw new Error("panel needs `extensionId`.");
      return unwrap(await call("panelOpen", a.extensionId, a.panelId ?? null));
    default:
      throw new Error(
        `Unknown action: ${a.action}. Have: open, close, group, rotate, consolidate, rename, pin, place, panel.`,
      );
  }
}

async function workspace(call, a) {
  if (!["switch", "create", "rename", "remove", "view"].includes(a.action)) {
    throw new Error(`Unknown action: ${a.action}. Have: switch, create, rename, remove, view.`);
  }
  if (a.action === "create") {
    const r = unwrap(await call("workspaceCreate", a.name ?? ""));
    return `created workspace ${r.wsId} and switched to it`;
  }
  if (!a.id) throw new Error(`workspace "${a.action}" needs \`id\` (from \`inspect workspaces\`).`);
  switch (a.action) {
    case "switch":
      unwrap(await call("workspaceSwitch", a.id));
      return `switched to workspace ${a.id}`;
    case "remove":
      unwrap(await call("workspaceRemove", a.id));
      return `removed workspace ${a.id}`;
    case "rename":
      if (!a.name) throw new Error('workspace "rename" needs `name`.');
      unwrap(await call("workspaceRename", a.id, a.name));
      return `renamed workspace ${a.id} to ${a.name}`;
    default:
      if (!a.view) throw new Error('workspace "view" needs `view`.');
      unwrap(await call("workspaceView", a.id, a.view));
      return `workspace ${a.id} now shows ${a.view}`;
  }
}

async function ssh(call, a) {
  if (a.action === "list") return call("sshConnections");
  if (a.action === "forward") {
    if (a.leafId === undefined || !a.remoteHost || !a.remotePort) {
      throw new Error("forward needs `leafId`, `remoteHost` and `remotePort`.");
    }
    return unwrap(await call("sshForward", a.leafId, a.localPort ?? 0, a.remoteHost, a.remotePort));
  }
  if (a.action !== "connect") {
    throw new Error(`Unknown action: ${a.action}. Have: list, connect, forward.`);
  }
  if (!a.id) throw new Error("connect needs `id` (from `ssh list`).");
  // A number is the new pane's leafId; `true` is a private open, whose id the app withholds
  // by design; anything else is the failure sentence.
  const r = await call("sshConnect", a.id, a.private === true);
  if (typeof r !== "number" && r !== true) throw new Error(String(r));
  return a.private === true
    ? `opened SSH connection ${a.id} as a private pane (no tool can see or address it)`
    : `opened SSH connection ${a.id} as leaf ${r} - run commands on it with sh({ command, leafId: ${r} })`;
}

async function ai(call, a) {
  switch (a.action) {
    case "status":
      return call("ai");
    case "read": {
      const r = await call("aiMessages", a.sessionId ?? null, a.maxChars ?? 8000);
      if (r?.error) throw new Error(String(r.error));
      return r;
    }
    case "send": {
      if (!a.text) throw new Error("send needs `text`.");
      const r = await call("aiSend", a.text);
      if (r !== true) throw new Error(String(r));
      return `queued for the built-in agent: ${a.text.slice(0, 80)}`;
    }
    case "new":
      return `started chat ${await call("aiNew")}`;
    case "switch": {
      if (!a.sessionId) throw new Error("switch needs `sessionId` (from `ai status`).");
      const r = await call("aiSwitch", a.sessionId);
      if (r !== true) throw new Error(String(r));
      return `switched to chat ${a.sessionId}`;
    }
    case "stop":
      await call("aiStop");
      return "stopped the built-in agent";
    default:
      throw new Error(`Unknown action: ${a.action}. Have: status, read, send, new, switch, stop.`);
  }
}

async function schedule(call, a) {
  if (a.action === "list") return call("schedules");
  // A refusal comes back as a sentence, so it reaches the caller as the reason.
  const answer = (r) => {
    if (typeof r === "string") throw new Error(r);
    return r;
  };
  if (a.action === "cancel") {
    if (!a.id) throw new Error("cancel needs `id` (from `schedule list`).");
    return answer(await call("scheduleCancel", a.id));
  }
  if (a.action !== "create") {
    throw new Error(`Unknown action: ${a.action}. Have: list, create, cancel.`);
  }
  return answer(
    await call("scheduleCreate", {
      command: a.command,
      delay: a.delay,
      at: a.at,
      leafId: a.leafId,
      submit: a.submit,
      label: a.label,
    }),
  );
}

/** One per tool that needs nothing but capabilities. `server.mjs` adds the Node-only rest. */
/** The window's real input, over the `devtools` capability every transport answers. */
const windowInput = (call) =>
  new WindowInput({ send: (method, params = {}) => call("devtools", method, params) });

export const HANDLERS = {
  keys: async (call, a) => {
    await windowInput(call).keys(...a.chords);
    return `pressed ${a.chords.join(" ")}`;
  },
  type_text: async (call, a) => {
    await windowInput(call).type(a.text, { delay: a.delay ?? 10 });
    return `typed ${a.text.length} chars`;
  },
  click: async (call, a) => {
    await windowInput(call).click(a.selector, { nth: a.nth ?? 0 });
    return `clicked ${a.selector}`;
  },
  drag: async (call, a) => {
    await windowInput(call).drag(a.selector, a.dx, a.dy, { nth: a.nth ?? 0 });
    return `dragged ${a.selector} by ${a.dx},${a.dy}`;
  },
  /** The image itself; `server.mjs` writes it to a file instead, for a client that reads paths. */
  screenshot: async (call) => ({
    data: await windowInput(call).capture(),
    mimeType: "image/png",
  }),
  state: (call, a) => call("state", { tail: a.tail ?? 3, buttons: a.buttons === true }),

  inspect: async (call, a) => {
    switch (a.what) {
      case "commands":
        return narrowed(await call("listCommands"), a.filter);
      case "extensions":
        return extensionsAnswer(await call("extensions"), a.filter);
      case "settings":
        return settingsAnswer(await call("settings"), a.filter);
      case "workspaces":
        return narrowed(await call("workspaces"), a.filter);
      case "status":
        return narrowed(await call("statusItems"), a.filter);
      case "sessions":
        return call("agentSessions", a.filter ?? null);
      default:
        throw new Error(
          `Unknown "what": ${a.what}. Have: commands, extensions, settings, workspaces, logs, status, sessions.`,
        );
    }
  },

  read: async (call, a) => {
    const cap = a.maxChars ?? MAX_CHARS;
    switch (a.source) {
      case "terminal": {
        const leaf = await resolveTerminal(call, a.leafId);
        const row = (await call("termTails", a.lines ?? 200, leaf)).find((t) => t.leafId === leaf);
        return {
          leafId: leaf,
          atPrompt: row?.atPrompt,
          running: row?.running,
          text: clip(row?.text ?? "", cap),
        };
      }
      case "editors":
        return call("editors", cap);
      case "dom": {
        if (!a.selector) throw new Error('read source:"dom" needs a `selector`.');
        const text = await call("text", a.selector, a.nth ?? 0);
        if (text === null) {
          throw new Error(`Nothing matches "${a.selector}" (or it is inside a private pane).`);
        }
        return { selector: a.selector, text: clip(text, cap) };
      }
      default:
        throw new Error(`Unknown source: ${a.source}. Have: terminal, editors, dom.`);
    }
  },

  run_command: async (call, a) => {
    if (a.extensionId) {
      const out = await call("runExtensionCommand", a.extensionId, a.id, a.args ?? {});
      if (!out) {
        throw new Error(
          `Nothing answers to "${a.id}" in ${a.extensionId}. Its extension may be disabled, ` +
            `or the id was declared but never given a handler. ` +
            `\`inspect extensions\` lists the commands and AI tools it really has.`,
        );
      }
      // An AI tool's answer IS the point of calling it; a command has none.
      return out.kind === "aiTool" ? out.result : `ran ${a.extensionId}:${a.id}`;
    }
    // Strict: an id with no handler must throw, not report "ran" for what never ran.
    await call("runCommandStrict", a.id);
    return `ran ${a.id}`;
  },

  set_setting: async (call, a) => {
    const r = await call("setSetting", a.key, a.value);
    if (r !== true) throw new Error(String(r));
    return `${a.key} = ${JSON.stringify(a.value)}`;
  },

  extension: async (call, a) => {
    const r = await call("extControl", a.action, a.id);
    if (r !== true) throw new Error(String(r));
    // Not `${a.action}d`, which produced "reloadd" and "uninstalld".
    return `${a.action}: ${a.id}`;
  },

  wait_for_terminal: async (call, a) =>
    waitTerminal(
      call,
      await resolveTerminal(call, a.leafId),
      a.text ?? null,
      a.timeout ?? 60000,
      a.lines,
    ),

  sh,

  open_file: async (call, a) => {
    if (!a.path) throw new Error("open_file needs an absolute `path`.");
    if ((await call("openFile", a.path)) !== true) throw new Error(`Could not open "${a.path}".`);
    return `opened ${a.path}`;
  },

  save_editor: async (call, a) => {
    const leaf = a.leafId ?? (await call("focusedLeaf"));
    if (!(await call("editorSave", leaf))) throw new Error(`Leaf ${leaf} is not an editor.`);
    return `saved leaf ${leaf}`;
  },

  focus_pane: async (call, a) => {
    const ok = await call("focusPaneVerified", a.leafId);
    if (ok === true) return `focused leaf ${a.leafId}`;
    throw new Error(
      typeof ok === "string"
        ? ok
        : `Could not focus leaf ${a.leafId} - no such pane, or it is private. A pane in a background tab is fine: focusing one brings its tab forward.`,
    );
  },

  ai,
  workspace,
  ssh,
  schedule,
  pane,

  sftp: (call, a) => call("sftp", a.leafId, a),

  session: async (call, a) => {
    const r = await call("agentSession", a);
    if (!r || r.ok !== true) throw new Error(String(r?.error ?? r));
    return r;
  },

  // These two format their own answer in the app, so there is nothing to keep in step.
  worktree: (call, a) => call("worktree", a),
  notes: (call, a) => call("notes", a),
  lsp: (call, a) => call("lsp", a),
  skill: (call, a) => call("skills", a.name ?? null, a.root ?? null),
};
