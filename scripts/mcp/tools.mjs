/**
 * THE tool table. Name -> pack + description + JSON Schema, and nothing else.
 *
 * WHY THIS FILE EXISTS. TEDI serves the same control surface over two
 * transports: a stdio JSON-RPC server an outside AI CLI drives (`server.mjs`), and
 * an in-process MCP server TEDI's own agent talks to
 * (`src/modules/ai/lib/tediMcpServer.ts`). Both used to declare their own
 * tools. The rule was already written down - "the duplication worth removing is
 * the definition, not the transport" - and then not followed: descriptions were
 * hand-copied and the schemas drifted. `ssh` ended up meaning `{action, id}`
 * on one side and `{connectionId}` on the other, so the documented call
 * silently LISTED connections instead of opening one - and `driver-verify`
 * could not see it, because it compared tool NAMES with a regex over source text.
 *
 * So: one table, imported by both. Handlers stay separate, because they really
 * are different - one drives the window over CDP, the other calls the same
 * functions inside its own JS realm.
 *
 * ZERO IMPORTS, AND IT MUST STAY THAT WAY. `server.mjs` ships as a bundle resource
 * with no `node_modules` beside it, and this file is ALSO imported by the app
 * bundle, which has no `node:` builtins. Data only.
 *
 * JSON SCHEMA, NOT ZOD, for that reason - and it is the better choice anyway.
 * The MCP SDK's low-level `Server` serves these verbatim, while the
 * `McpServer`/Zod path silently STRIPS unknown keys, which is exactly how the
 * `ssh` mismatch produced a plausible wrong answer instead of an error.
 *
 * `pack` is the switch that governs the tool; `src/modules/mcpInstall/packs.ts`
 * builds its categories from this field rather than keeping a second name list.
 * The tool list is loaded into EVERY request of every connected CLI for the whole
 * session, so prose here is a standing bill on every turn - see the notes in
 * `server.mjs` on what belongs in a description and what belongs in an error.
 */
export const TOOL_DEFS = {
  state: {
    pack: "tedi",
    annotations: { readOnlyHint: true },
    description:
      "Snapshot of the window. Call it first: it names the leafIds every other tool takes. `panes` " +
      "is EVERY pane in EVERY tab with what identifies it - a terminal's cwd, ssh host, running AI " +
      "CLI, prompt state and last output; an editor's path and dirty flag; a browser's url. Plus " +
      "tabs, focus, open modal, toast count, and `paneHandle` for `drag`. Private panes are absent " +
      "by design. One round trip; call it freely.",
    schema: {
      type: "object",
      properties: {
        tail: { type: "number", description: "Terminal lines per pane, default 3." },
        buttons: {
          type: "boolean",
          description: "Also every clickable aria-label. Long; fetch once.",
        },
      },
    },
  },

  inspect: {
    pack: "tedi",
    annotations: { readOnlyHint: true },
    description:
      "List what TEDI has. `commands`: ids for `run_command`. `extensions`: what is installed, " +
      "whether each is ENABLED, and its commands/panels/AI tools - a disabled extension and an " +
      "absent one look identical in the UI. `settings`: every preference the app is running on " +
      "(write with `set_setting`). `workspaces`: every workspace, which one is ACTIVE, and each " +
      "one's view - tabs, kanban or canvas; `state` only ever describes the active one. `logs`: " +
      "console output and uncaught errors - the only place a half-rendered window says why.",
    schema: {
      type: "object",
      properties: {
        what: {
          type: "string",
          enum: ["commands", "extensions", "settings", "workspaces", "logs"],
        },
        level: {
          type: "string",
          enum: ["log", "info", "warn", "error"],
          description: "logs only.",
        },
      },
      required: ["what"],
    },
  },

  read: {
    pack: "tedi",
    annotations: { readOnlyHint: true },
    description:
      "Read one surface. `terminal`: a pane's scrollback, and the ONLY way to see a terminal - xterm " +
      "draws to a WebGL canvas, so DOM tools return nothing for one. `editors`: every open editor's " +
      "path and LIVE buffer, unsaved edits included; never scrape `.cm-content` instead, CodeMirror " +
      "virtualises and a long file comes back short and plausible. `dom`: text of a selector - " +
      "dialogs, the file tree, the AI reply, the status bar.",
    schema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["terminal", "editors", "dom"] },
        selector: { type: "string", description: "dom: required." },
        leafId: { type: "number", description: "terminal: default focused." },
        nth: { type: "number" },
        lines: { type: "number", description: "terminal, default 200." },
        maxChars: { type: "number", description: "default 20000." },
      },
      required: ["source"],
    },
  },

  run_command: {
    pack: "tedi",
    description:
      "Run a command by id, bypassing the Command Palette and its fuzzy match. The reliable way to " +
      "split panes, open tabs, toggle the sidebar, open Source Control, zoom. Ids from `inspect " +
      "commands`. With `extensionId` it also reaches what an EXTENSION declared - both its " +
      "commands AND its AI tools, which take `args` and RETURN DATA (that is how you send an API " +
      "Client request or run a SQL Explorer query, rather than just opening the panel). Ids and " +
      "argument names for both come from `inspect extensions`.",
    schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "A command id, e.g. pane.splitRight." },
        extensionId: {
          type: "string",
          description: "Set for an extension's command or AI tool.",
        },
        args: { type: "object", description: "Arguments, for an extension AI tool." },
      },
      required: ["id"],
    },
  },

  set_setting: {
    pack: "settings",
    annotations: { destructiveHint: false },
    description:
      "Change one TEDI preference; keys and current values from `inspect settings`. Applies live and " +
      "persists. The Settings page is a separate webview no tool here can read or click, so this is " +
      "the only route to it.",
    schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "e.g. theme, editorFontSize, vimMode." },
        // A plain string, coerced against the preference's own type on arrival.
        // A union `type: [...]` is legal JSON Schema and the obvious choice, but
        // not every AI CLI's schema converter accepts one, and this tool exists
        // so that ALL of them can drive TEDI.
        value: {
          type: "string",
          description: 'As text: "dark", "true", "14"; JSON for a list or object.',
        },
      },
      required: ["key", "value"],
    },
  },

  extension: {
    pack: "settings",
    description:
      "Turn an installed extension on or off, reload, update or uninstall it; ids from `inspect " +
      "extensions`. INSTALLING IS NOT HERE - it runs third-party code under a permission set the " +
      "user must review, so send them to that dialog with `run_command settings.open`.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["enable", "disable", "reload", "update", "uninstall"] },
        id: { type: "string", description: "e.g. tedi.sql-explorer." },
      },
      required: ["action", "id"],
    },
  },

  wait_for_terminal: {
    pack: "tedi",
    annotations: { readOnlyHint: true },
    description:
      "Block until a terminal pane finishes; returns why it stopped plus its last lines. USE THIS " +
      "INSTEAD OF POLLING `read`. No `text`: waits for the shell prompt, right for a command. " +
      "`text`: waits for that string to appear - the only signal that works for something that never " +
      "returns (dev server, TUI, another AI CLI asking a question). A timeout is reported, not " +
      "thrown.",
    schema: {
      type: "object",
      properties: {
        leafId: { type: "number", description: "Default: focused." },
        text: { type: "string" },
        timeout: { type: "number", description: "ms, default 60000." },
      },
    },
  },

  sh: {
    pack: "tedi",
    description:
      "Run a shell command in a TEDI terminal pane and return its output - the USER'S shell, cwd, " +
      "env and SSH session. Use your own Bash tool for ordinary work. Written to the PTY, so it " +
      "cannot lose characters, and it waits for the prompt. That bypasses xterm input, so TEDI's " +
      "AI-CLI detector never fires: launch an AI CLI with `type_text` + `keys`, or the pane is not " +
      "recognised as running one.",
    schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        leafId: {
          type: "number",
          description: "Omit only when focus is in a terminal, or one is open.",
        },
        timeout: {
          type: "number",
          description: "ms for the prompt, default 20000. A TUI never returns; you get the buffer.",
        },
        lines: { type: "number", description: "default 60." },
      },
      required: ["command"],
    },
  },

  open_file: {
    pack: "tedi",
    annotations: { destructiveHint: false },
    description:
      "Open a file in TEDI's editor by absolute path, exactly as clicking it in the explorer would " +
      "(a PDF still opens in a browser pane). Use it to show the user what you are talking about; " +
      "clicking the tree only reaches paths already expanded into view.",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path." } },
      required: ["path"],
    },
  },

  save_editor: {
    pack: "tedi",
    annotations: { destructiveHint: false },
    description: "Save an editor pane to disk. Use after `type_text` into an editor.",
    schema: {
      type: "object",
      properties: { leafId: { type: "number", description: "Default: the focused pane." } },
    },
  },

  keys: {
    pack: "misc",
    description:
      'Press real key chords in order, e.g. ["Ctrl+Shift+P", "Escape"]. Modifiers: Ctrl, Alt, Shift, ' +
      "Meta/Cmd, Mod (Ctrl, or Cmd on macOS). Needed for anything the app takes off the keyboard " +
      "rather than the command registry: Ctrl+S, Ctrl+/ to comment, Enter to send in the AI " +
      "composer. Also how you close a menu you opened.",
    schema: {
      type: "object",
      properties: { chords: { type: "array", items: { type: "string" } } },
      required: ["chords"],
    },
  },

  type_text: {
    pack: "misc",
    description:
      "Type text as real keystrokes into whatever has focus - an editor, a search box, the AI " +
      "composer. Sends no Enter. For a shell command prefer `sh`, which is instant and cannot drop " +
      "the first character.",
    schema: {
      type: "object",
      properties: {
        text: { type: "string" },
        delay: { type: "number", description: "ms between characters (default 10)." },
      },
      required: ["text"],
    },
  },

  click: {
    pack: "misc",
    description:
      "Real mouse click at a selector's centre. Scrolls it into view first, and refuses with the " +
      "reason when something covers it. Controls carry `aria-label`, not `title` - list them with " +
      "`state buttons:true`. Tree rows carry `data-fs-path`.",
    schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        nth: { type: "number", description: "Which match (default 0)." },
      },
      required: ["selector"],
    },
  },

  focus_pane: {
    pack: "tedi",
    annotations: { destructiveHint: false },
    description:
      "Give a pane keyboard focus without clicking into it, so the next `keys`/`type_text` lands " +
      "there. Clicking works too but moves an editor's caret to wherever the pane's centre was.",
    schema: { type: "object", properties: { leafId: { type: "number" } }, required: ["leafId"] },
  },

  drag: {
    pack: "misc",
    annotations: { destructiveHint: false },
    description:
      "Drag a selector by (dx, dy) with real pointer moves. How panes and the sidebar get resized. " +
      "Take the pane splitter's index from `state.paneHandle`; never guess an nth, and -1 means only " +
      "one pane is open.",
    schema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        dx: { type: "number" },
        dy: { type: "number" },
        nth: { type: "number" },
      },
      required: ["selector", "dx", "dy"],
    },
  },

  screenshot: {
    pack: "misc",
    description:
      "Capture the TEDI window to a PNG and return its path - read that path back to see it. Main " +
      "webview only: browser preview panes and floated panes are separate native webviews and come " +
      "out blank.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Where to write it. Default: a temp file." },
      },
    },
  },

  ai: {
    pack: "ai",
    annotations: { destructiveHint: false },
    description:
      "TEDI's OWN built-in agent, which runs in the app beside you. `status`: what it is doing " +
      "right now, its pending approvals, token usage and sessions. `read`: its live conversation. " +
      "`send`: queue a prompt for it, exactly as the composer would - it does NOT bypass approval, " +
      "so whatever it then tries still raises the user's usual cards. Use this to hand work to it, " +
      "or to see whether it is already busy on the same thing.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "read", "send"] },
        text: { type: "string", description: "send: the prompt." },
        sessionId: { type: "string", description: "read: default the active session." },
        maxChars: { type: "number", description: "read: default 8000." },
      },
      required: ["action"],
    },
  },

  ssh: {
    pack: "tedi",
    annotations: { destructiveHint: false },
    description:
      "Saved SSH connections: list them, or open one in a new tab. There is no command id for this " +
      "(`run_command` cannot reach it), so this is the only route. Keys and passphrases stay in the " +
      "OS keyring and never come back here.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "connect"] },
        id: { type: "string", description: "connect: the connection id from `list`." },
        private: {
          type: "boolean",
          description: "connect: open it as a private pane the AI cannot see.",
        },
      },
      required: ["action"],
    },
  },

  browser: {
    pack: "browser",
    annotations: { destructiveHint: false },
    description:
      "Drive TEDI's native browser panes. `open` a url, `list` the panes, `navigate`, `read` the " +
      "rendered page text, or `console` for its output and errors. A preview pane is a SEPARATE " +
      "native webview, so no DOM tool here can see one - this is the only route. Start with `open`: " +
      "a pane that has never loaded a page has no webview yet and reads come back empty.",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "open",
            "list",
            "navigate",
            "url",
            "read",
            "console",
            "back",
            "forward",
            "reload",
            "address",
          ],
        },
        leafId: { type: "number", description: "Which browser pane; default the first." },
        url: { type: "string", description: "open / navigate." },
      },
      required: ["action"],
    },
  },

  eval_js: {
    pack: "misc",
    description:
      "Evaluate JavaScript in the TEDI window and return the result (promises awaited). The escape " +
      "hatch for anything the tools above do not model - a store, a computed style, an element " +
      "count. `__TAURI_INTERNALS__.invoke` is reachable from here, so every Rust command is too.",
    schema: {
      type: "object",
      properties: { expression: { type: "string" } },
      required: ["expression"],
    },
  },
};

/** Every tool name, in table order. */
export const TOOL_NAMES = Object.keys(TOOL_DEFS);

/** Tool names belonging to `pack`. */
export function toolsInPack(pack) {
  return TOOL_NAMES.filter((n) => TOOL_DEFS[n].pack === pack);
}

/**
 * Check `args` against a tool's schema. Null when it passes, else a sentence
 * naming what is wrong.
 *
 * Deliberately shallow: required keys, primitive `type`, and `enum`. That is the
 * set of mistakes an agent actually makes, and it is what the two servers were
 * each doing BY HAND and inconsistently - the stdio side wrote `if (!a.id) throw`
 * per tool and skipped most of them, while the in-process side got Zod
 * validation for free and so behaved differently for the identical call. One
 * shallow check both sides share beats two different deeper ones.
 *
 * Not a JSON Schema implementation. No $ref, no allOf, no nested objects - if
 * this table ever needs those, it has grown past what a tool schema should be.
 */
export function validateArgs(name, args) {
  const schema = TOOL_DEFS[name]?.schema;
  if (!schema) return null;
  const a = args ?? {};
  for (const key of schema.required ?? []) {
    if (a[key] === undefined || a[key] === null) return name + ' needs "' + key + '".';
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const v = a[key];
    if (v === undefined || v === null) continue;
    if (spec.enum && !spec.enum.includes(v)) {
      return (
        name +
        "." +
        key +
        " must be one of: " +
        spec.enum.join(", ") +
        " (got " +
        JSON.stringify(v) +
        ")."
      );
    }
    if (spec.type && spec.type !== "object" && spec.type !== "array" && typeof v !== spec.type) {
      return name + "." + key + " must be a " + spec.type + " (got " + typeof v + ").";
    }
  }
  return null;
}
