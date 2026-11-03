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
 * An outside CLI sees one gateway tool and reads these through `tedi help`, but TEDI's
 * own agent still loads each tool with an in-process handler on every step, so
 * prose here is a standing bill - see `server.mjs` on what belongs in a description
 * and what belongs in an error.
 */
export const TOOL_DEFS = {
  state: {
    pack: "tedi",
    annotations: { readOnlyHint: true },
    description:
      "Snapshot of the window. Call it first: it names the leafIds every other tool takes. `panes` " +
      "is EVERY pane in EVERY tab with what identifies it - a terminal's cwd, ssh host, running AI " +
      "CLI, prompt state and last output; an editor's path and dirty flag; an extension pane's " +
      "title, which for a browser pane is the page it is showing. Plus " +
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
      "console output and uncaught errors - the only place a half-rendered window says why. " +
      "`status`: what each extension shows in the status bar, its meters and tooltips, which is the " +
      "only data an extension with no AI tools publishes. `sessions`: saved Claude Code and Codex " +
      "sessions, newest first, each with the command that resumes it.",
    schema: {
      type: "object",
      properties: {
        what: {
          type: "string",
          enum: ["commands", "extensions", "settings", "workspaces", "logs", "status", "sessions"],
        },
        level: {
          type: "string",
          enum: ["log", "info", "warn", "error"],
          description: "logs only.",
        },
        filter: { type: "string", description: "sessions: match the title or folder." },
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
      "the only route to it. Key `themePreset` applies a named theme from `themePresets` there.",
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
      "cannot lose characters, and it waits for the prompt. A pane running a FULL-SCREEN program " +
      "(an AI CLI, vim) accepts a write too - that is how you type into one, and the reply says " +
      "`intoTui`; only a command running on the NORMAL screen is refused, because it is not " +
      "reading input. Starting a known AI CLI here tags the pane, so it gets its badge and its " +
      "status in `<env>`. `submit: false` types the command and stops there, for when the " +
      "answer IS a command and the user should press Enter. USE `capture: true` WHENEVER YOU WANT " +
      "THE OUTPUT ITSELF rather than to show the user a command running - reading a file, listing a " +
      "directory, parsing anything. Without it you are reading the SCREEN, which is a fixed ring of " +
      "wrapped rows: long output scrolls its own beginning away and comes back with holes.",
    schema: {
      type: "object",
      properties: {
        command: { type: "string" },
        leafId: {
          type: "number",
          description: "Omit only when focus is in a terminal, or one is open.",
        },
        capture: {
          type: "boolean",
          description:
            "Run it off-screen on that pane's host and return the exact output (SSH panes; use your Bash tool for a local one).",
        },
        submit: { type: "boolean", description: "Default true. False types without running." },
        timeout: {
          type: "number",
          description:
            "ms for the prompt, default 20000, floored at 1000 - `10` is a tenth of a second, " +
            "not ten seconds. A TUI never returns; you get the buffer.",
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
      "(a PDF still opens in the system browser). Use it to show the user what you are talking " +
      "about; " +
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
      "there. Brings its TAB forward too, which is the only way to reach a pane `state` listed in " +
      "one you are not looking at. Clicking works but moves an editor's caret to the pane's centre.",
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
    // Writes a fresh temp PNG, so not read-only, but it captures rather than
    // changes anything - nothing to destroy. Left pessimistic, a gating client
    // read a screenshot as dangerous as `eval_js`.
    annotations: { destructiveHint: false },
    description:
      "Capture the TEDI window to a PNG and return its path - read that path back to see it. Main " +
      "webview only: a floated pane is a separate webview and comes out blank.",
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
      "so whatever it then tries still raises the user's usual cards. `new`: start a fresh chat. " +
      "`switch`: open one by `sessionId`. `stop`: interrupt the running turn. Use this to hand work " +
      "to it, or to see whether it is already busy on the same thing.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "read", "send", "new", "switch", "stop"] },
        text: { type: "string", description: "send: the prompt." },
        sessionId: { type: "string", description: "read, switch: default the active session." },
        maxChars: { type: "number", description: "read: default 8000." },
      },
      required: ["action"],
    },
  },

  ssh: {
    pack: "tedi",
    annotations: { destructiveHint: false },
    description:
      "Saved SSH connections: list them, open one in a new tab, or `forward` a local port through " +
      "a connected pane (`leafId`, `localPort`, `remoteHost`, `remotePort`). There is no command id for this " +
      "(`run_command` cannot reach it), so this is the only route. `connect` returns the new pane's " +
      "`leafId`, which is what you pass to `sh` to run commands ON THE REMOTE HOST - opening the " +
      "tab is not the job, working in it is. Keys and passphrases stay in the OS keyring and never " +
      "come back here.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "connect", "forward"] },
        id: { type: "string", description: "connect: the connection id from `list`." },
        leafId: { type: "number", description: "forward: a connected SSH pane." },
        localPort: { type: "number", description: "forward: 0 picks a free one." },
        remoteHost: { type: "string", description: "forward." },
        remotePort: { type: "number", description: "forward." },
        private: {
          type: "boolean",
          description: "connect: open it as a private pane the AI cannot see.",
        },
      },
      required: ["action"],
    },
  },

  // Neither of these two has an in-process handler, so they cost TEDI's own agent
  // nothing: it has its own ways to the same things.
  sftp: {
    pack: "tedi",
    annotations: { destructiveHint: true },
    description:
      "Files on the host behind a connected SSH pane, without touching its terminal. Replacing or " +
      "deleting anything needs `confirm`: `home`, `list`, " +
      "`read`, `write`, `stat`, `touch`, `mkdir`, `rename`, `delete` (needs `confirm`), and `upload` / " +
      "`download` to or from a `local` path.",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "home",
            "list",
            "read",
            "write",
            "stat",
            "touch",
            "mkdir",
            "rename",
            "delete",
            "upload",
            "download",
          ],
        },
        leafId: { type: "number", description: "A connected SSH pane, from `state`." },
        remote: { type: "string", description: "Remote path. upload: the remote folder." },
        to: { type: "string", description: "rename: the new remote path." },
        local: { type: "string", description: "upload: local file. download: local folder." },
        content: { type: "string", description: "write." },
        hidden: { type: "boolean", description: "list: include dotfiles." },
        maxChars: { type: "number", description: "read: default 20000." },
        confirm: { type: "boolean", description: "To delete or replace." },
      },
      required: ["action", "leafId"],
    },
  },

  session: {
    pack: "tedi",
    annotations: { destructiveHint: true },
    description:
      "A saved Claude Code or Codex session, by the id from `inspect sessions`: `rename` it (`title`), " +
      "or `delete` its transcript for good (needs `confirm`, refused while it is running). To resume " +
      "one, run the `resume` command that listing gives you in a pane.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["rename", "delete"] },
        id: { type: "string" },
        title: { type: "string", description: "rename." },
        confirm: { type: "boolean", description: "delete: required." },
      },
      required: ["action", "id"],
    },
  },

  worktree: {
    pack: "tedi",
    annotations: { destructiveHint: true },
    // `list` is the only one that changes nothing. `add` and `open` create a
    // tab, `remove` deletes a folder.
    auto: ["list"],
    description:
      "Git worktrees - several checkouts of ONE repository, each on its own branch, so two agents " +
      "work at once without either stashing for the other. `list` them; `add` a branch as a new " +
      "worktree and open it in a tab (creates the branch when it does not exist, runs the repo's " +
      "saved setup command, and `run` types one line at its prompt); `remove` one by path or " +
      "branch; `prune` registrations whose folder is gone; `open` an existing one in a tab. `cwd` " +
      "is any folder in the repository and defaults to the focused terminal's, so a plain " +
      '`{action:"list"}` answers about the project you are looking at. Writes always run from ' +
      "the main worktree, so calling this from inside a worktree is safe.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove", "prune", "open"] },
        cwd: {
          type: "string",
          description: "Any folder in the repository. The focused terminal's when omitted.",
        },
        branch: {
          type: "string",
          description: "add: the branch to be on. remove / open: may name one instead of a path.",
        },
        path: {
          type: "string",
          description:
            "add: where to put it, default `<repo>/.worktrees/<branch>`. remove / open: which one.",
        },
        from: {
          type: "string",
          description: "add: what a CREATED branch starts from. HEAD when omitted.",
        },
        run: {
          type: "string",
          description: "add: one command line typed at the new worktree's first prompt.",
        },
        force: {
          type: "boolean",
          description: "remove: required once the worktree holds uncommitted work.",
        },
      },
      required: ["action"],
    },
  },

  pane: {
    pack: "tedi",
    annotations: { destructiveHint: false },
    // `rotate` only changes how two panes sit next to each other and is
    // idempotent; it ran without a card as `rotate_pane`. Everything else here
    // opens or closes something the user can see.
    auto: ["rotate"],
    description:
      "Arrange panes and terminals: `open` N terminals (as a new tab, or `split` an existing one, " +
      "with an optional `cwd`); `close` one by leafId, or every terminal but the last with `all`; " +
      "`group` two or more leafIds of ANY kind into one split tab (this IS 'join tabs' - TEDI has " +
      "no Chrome-style tab-group menu, never tell the user to use one); `rotate` a pane between " +
      '"row" (beside) and "col" (stacked), which is the only way to change a split\'s orientation, ' +
      "so never tell the user to drag; `consolidate` every terminal into one tab; `rename` a pane " +
      "(`name`, empty resets it); `pin` or unpin its tab (`pinned`); `place` it on the canvas (`x`, " +
      "`y`, `w`, `h`, percent); `panel` opens an extension's " +
      "panel in its own tab (`extensionId`, `panelId`), including one no command opens. `open` " +
      "answers with the `leafId` it made - use that, do not go back to `state` for it. Cap 6 per tab.",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "open",
            "close",
            "group",
            "rotate",
            "consolidate",
            "rename",
            "pin",
            "place",
            "panel",
          ],
        },
        leafId: { type: "number", description: "close / rotate / rename / pin: the pane." },
        name: { type: "string", description: "rename: the new name." },
        x: { type: "number", description: "place." },
        y: { type: "number", description: "place." },
        w: { type: "number", description: "place." },
        h: { type: "number", description: "place." },
        pinned: { type: "boolean", description: "pin: default true." },
        extensionId: { type: "string", description: "panel: from `inspect extensions`." },
        panelId: { type: "string", description: "panel: default its first panel." },
        leafIds: {
          type: "array",
          items: { type: "number" },
          description: "group: two or more panes to dock together.",
        },
        tabId: { type: "number", description: "open+split / group / consolidate: destination." },
        cwd: { type: "string", description: "open: absolute path; omit to inherit." },
        split: {
          type: "boolean",
          description: "open: split an existing tab instead of a new one.",
        },
        dir: {
          type: "string",
          enum: ["row", "col"],
          description: 'open / rotate: "row" = beside, "col" = stacked. Rotate toggles if omitted.',
        },
        count: { type: "number", description: "open: how many, default 1, max 6." },
        all: { type: "boolean", description: "close: every terminal but the last." },
      },
      required: ["action"],
    },
  },

  schedule: {
    pack: "tedi",
    annotations: { destructiveHint: false },
    // Listing what is queued is a read, and an agent about to use a pane should
    // be able to check it without a card. Creating and cancelling change what
    // will run on the user's machine, so both keep theirs.
    auto: ["list"],
    description:
      "Run a command in a TEDI terminal LATER. `list` what is queued, with each one's status and " +
      "how long until it fires; `create` one, `delay` seconds from now or `at` an ISO time; " +
      "`cancel` a pending one by id. It survives restarts and fires into a pane in any tab or " +
      "workspace, so this is how you do anything time-based - `sh` is for now. `submit: false` " +
      "types the command and leaves it for the user to press Enter on.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "cancel"] },
        command: { type: "string", description: "create: the shell command." },
        delay: { type: "number", description: "create: seconds from now." },
        at: { type: "string", description: "create: ISO-8601 time, instead of `delay`." },
        leafId: {
          type: "number",
          description: "create: which terminal. Default: the focused one.",
        },
        submit: {
          type: "boolean",
          description: "create: default true. False types without running.",
        },
        label: { type: "string", description: "create: what the status bar calls it." },
        id: { type: "string", description: "cancel: an id from `list`." },
      },
      required: ["action"],
    },
  },

  notes: {
    pack: "tedi",
    annotations: { destructiveHint: true },
    // Reading the user's list is unattended; every write changes what they see,
    // and a delete loses what they wrote, so all of them keep their card.
    auto: ["read"],
    description:
      "The USER's OWN notes and todo list - the panel they keep in the toolbar, which outlives every " +
      "session. This is NOT your per-turn plan (that is todo_write) and NOT the schedule queue. " +
      "`read` returns both lists with their ids, or one note's full body with `id`. Todos: " +
      "`add_todo`, `edit_todo`, `complete_todo`, `reopen_todo`, `delete_todo`, `clear_done`. " +
      "Notes: `add_note` (`text` title, optional `body`), `edit_note`, `delete_note`. Touch it " +
      "only when the user asks, or to check what they already wrote down.",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "read",
            "add_todo",
            "edit_todo",
            "complete_todo",
            "reopen_todo",
            "delete_todo",
            "clear_done",
            "add_note",
            "edit_note",
            "delete_note",
          ],
        },
        id: { type: "string", description: "The todo or note id from `read`." },
        text: { type: "string", description: "Todo line, or note title." },
        body: { type: "string", description: "add_note / edit_note: the note body." },
      },
      required: ["action"],
    },
  },

  workspace: {
    pack: "tedi",
    // `remove` closes the workspace AND ends every terminal in it.
    annotations: { destructiveHint: true },
    description:
      "Act on a workspace, a saved set of tabs with its own view: `switch` to one, `create` one " +
      "(which switches to it and seeds a terminal), `rename` one, set its `view`, or `remove` one, " +
      "which closes its tabs and ENDS every terminal in it (the last workspace cannot be removed). " +
      "`inspect workspaces` is the READ - it lists every workspace with the id these take. No " +
      "command id reaches any of this, so this is the only route. Every action asks first.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["switch", "create", "rename", "remove", "view"] },
        id: {
          type: "string",
          description: "switch / rename / remove / view: an id from `inspect workspaces`.",
        },
        name: { type: "string", description: "create / rename: max 60 chars." },
        view: { type: "string", enum: ["tabs", "kanban", "canvas"], description: "view." },
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

/**
 * Short names for what people actually type. `positional` names the arguments
 * bare words fill; `select` keeps one key of a JSON answer.
 */
export const ALIASES = {
  new_tab: {
    tool: "pane",
    args: { action: "open" },
    positional: ["cwd"],
    about: "Open a terminal in a new tab",
  },
  split: {
    tool: "pane",
    args: { action: "open", split: true },
    positional: ["cwd"],
    about: "Open a terminal beside the active pane",
  },
  close: { tool: "pane", args: { action: "close" }, positional: ["leafId"], about: "Close a pane" },
  rename: {
    tool: "pane",
    args: { action: "rename" },
    positional: ["leafId", "name"],
    about: "Name a pane",
  },
  pin: { tool: "pane", args: { action: "pin" }, positional: ["leafId"], about: "Pin a pane's tab" },
  unpin: {
    tool: "pane",
    args: { action: "pin", pinned: false },
    positional: ["leafId"],
    about: "Unpin a pane's tab",
  },
  panel: {
    tool: "pane",
    args: { action: "panel" },
    positional: ["extensionId", "panelId"],
    about: "Open an extension's panel",
  },
  panes: { tool: "state", select: "panes", about: "Every pane in every tab" },
  focus: {
    tool: "focus_pane",
    positional: ["leafId"],
    about: "Focus a pane and bring its tab forward",
  },
  term: {
    tool: "read",
    args: { source: "terminal" },
    positional: ["leafId"],
    about: "A terminal's scrollback",
  },
  editors: { tool: "read", args: { source: "editors" }, about: "Every open editor's live buffer" },
  wait: {
    tool: "wait_for_terminal",
    positional: ["leafId"],
    about: "Block until a pane is back at its prompt",
  },
  run: { tool: "run_command", positional: ["id"], about: "Run a command id (see `tedi commands`)" },
  call: {
    tool: "run_command",
    positional: ["extensionId", "id", "args"],
    about: "Call an extension's command or AI tool",
  },
  commands: { tool: "inspect", args: { what: "commands" }, about: "Every command id" },
  extensions: {
    tool: "inspect",
    args: { what: "extensions" },
    about: "Installed extensions and what they add",
  },
  settings: { tool: "inspect", args: { what: "settings" }, about: "Every preference" },
  workspaces: { tool: "inspect", args: { what: "workspaces" }, about: "Every workspace" },
  logs: {
    tool: "inspect",
    args: { what: "logs" },
    about: "Console output for a few seconds (--for <seconds>)",
  },
  status: {
    tool: "inspect",
    args: { what: "status" },
    about: "What extensions show in the status bar",
  },
  sessions: {
    tool: "inspect",
    args: { what: "sessions" },
    positional: ["filter"],
    about: "Saved Claude Code and Codex sessions",
  },
  set: { tool: "set_setting", about: "Change a preference" },
  open: { tool: "open_file", about: "Open a file in the editor" },
  save: { tool: "save_editor", positional: ["leafId"], about: "Save an editor pane" },
  type: { tool: "type_text", about: "Type into whatever has focus" },
  shot: { tool: "screenshot", positional: ["path"], about: "Capture the window to a PNG" },
  eval: { tool: "eval_js", about: "Evaluate JavaScript in the window" },
};

/**
 * What `tedi tools` prints: every verb under what it is for. A reader, human or
 * model, starts here, so a verb missing from it is one nobody finds. `cli-verify`
 * fails when a tool has neither a row here nor a shortcut that has one.
 */
export const CLI_GROUPS = [
  [
    "See what is open",
    [
      "panes",
      "state",
      "term",
      "editors",
      "read",
      "inspect",
      "commands",
      "extensions",
      "settings",
      "workspaces",
      "status",
      "sessions",
      "logs",
    ],
  ],
  [
    "Terminals and panes",
    ["new_tab", "split", "close", "focus", "rename", "pin", "unpin", "sh", "wait", "pane"],
  ],
  ["Editor", ["open", "save"]],
  ["App commands and extensions", ["run", "call", "panel", "extension"]],
  ["Settings and workspaces", ["set", "workspace"]],
  ["SSH", ["ssh", "sftp"]],
  [
    "Built-in agent, notes, schedule, git worktrees",
    ["ai", "session", "notes", "schedule", "worktree"],
  ],
  ["Real input and the window (Misc pack)", ["keys", "type", "click", "drag", "shot", "eval"]],
];

/** Shown by `tedi help <verb>`. Real command lines beat a flag list for getting it right first time. */
export const CLI_EXAMPLES = {
  panes: ["tedi panes"],
  term: ["tedi term 3", "tedi term 3 --lines 500"],
  sh: [
    "tedi sh git status",
    "tedi sh --leaf-id 3 'git commit -m \"fix bug\"'",
    "tedi sh --no-submit 'rm -rf build'",
  ],
  wait: ["tedi wait 3", "tedi wait 3 --text 'ready on' --timeout 120000"],
  new_tab: ["tedi new-tab", "tedi new-tab ./project"],
  split: ["tedi split . --dir col"],
  close: ["tedi close 3"],
  rename: ["tedi rename 3 build"],
  panel: ["tedi panel tedi.sql-explorer"],
  run: ["tedi run tab.new", "tedi run pane.float"],
  call: ['tedi call tedi.sql-explorer sql_query \'{"sql":"select 1"}\''],
  set: ["tedi set theme dark", "tedi set themePreset tokyo-night"],
  open: ["tedi open src/main.ts"],
  pane: [
    "tedi pane open --count 2",
    "tedi pane group --leaf-ids 3,5",
    "tedi pane rotate 3 --dir col",
    "tedi pane place 3 --x 10 --y 10 --w 40 --h 50",
  ],
  workspace: [
    "tedi workspace create Build",
    "tedi workspace switch ws-abc",
    "tedi workspace view ws-abc --view canvas",
  ],
  extension: ["tedi extension disable tedi.sql-explorer"],
  ssh: [
    "tedi ssh list",
    "tedi ssh connect c-abc",
    "tedi ssh forward --leaf-id 3 --local-port 8080 --remote-host localhost --remote-port 80",
  ],
  sftp: [
    "tedi sftp list 3 /var/www",
    "tedi sftp read 3 /etc/hostname",
    "tedi sftp upload 3 /var/www --local ./dist/app.js",
    "tedi sftp delete 3 /tmp/old.log --confirm",
  ],
  ai: ["tedi ai status", "tedi ai send fix the failing test", "tedi ai stop"],
  session: [
    "tedi session rename abc-123 --title 'auth refactor'",
    "tedi session delete abc-123 --confirm",
  ],
  notes: ["tedi notes read", "tedi notes add_todo buy milk", "tedi notes complete_todo t-abc"],
  schedule: [
    "tedi schedule list",
    "tedi schedule create 'npm test' --delay 600",
    "tedi schedule cancel s-abc",
  ],
  worktree: ["tedi worktree list", "tedi worktree add feature-x", "tedi worktree remove feature-x"],
  read: ["tedi read terminal 3", "tedi read dom --selector '[role=dialog]'"],
  inspect: ["tedi inspect sessions auth", "tedi inspect logs error"],
  logs: ["tedi logs --for 10 --level error"],
  keys: ["tedi keys Ctrl+Shift+P Escape"],
  type: ["tedi type hello world"],
  click: ["tedi click 'button[aria-label=\"Close pane\"]'"],
  drag: ["tedi drag '[data-slot=resizable-handle]' 120 0 --nth 1"],
  shot: ["tedi shot ./window.png"],
  eval: ["tedi eval 'document.title'"],
};

const CLI_INTRO = `tedi drives the TEDI window that is already running, from any shell.

Start here:
  tedi panes                          every pane: its leaf id, folder, what is running
  tedi sh --leaf-id 3 'git status'    run a command in that pane and print the output
  tedi term 3                         read a pane's scrollback
  tedi wait 3                         block until it is back at its prompt

Rules:
  tedi help <verb>      arguments and examples; dashes and underscores are the same
  Flags go BEFORE the command in \`sh\`; quote a command that has spaces in an argument.
  Exit status: 0 done, 1 refused or not finished, 2 the command line was wrong.
  Answers are JSON or plain text on stdout, errors on stderr.`;

/** The `tedi tools` text. `tools` is what this surface may run right now, so a verb
 *  whose pack is off is simply not offered. */
export function cliGuide(tools) {
  const first = (s = "") => s.split(/(?<=\.)\s/)[0];
  const on = new Map(tools.map((t) => [t.name, first(t.description)]));
  const label = (v) => ALIASES[v]?.about ?? on.get(v);
  const usable = (v) => on.has(ALIASES[v]?.tool ?? v);
  const rows = (names) => {
    const shown = names.filter(usable);
    const width = Math.max(0, ...shown.map((v) => v.length)) + 2;
    return shown.map((v) => `  ${v.replaceAll("_", "-").padEnd(width)}${label(v)}`).join("\n");
  };
  const sections = CLI_GROUPS.map(([title, names]) => [title, rows(names)]);
  const ext = tools.filter((t) => t.name.startsWith("ext_")).map((t) => t.name);
  if (ext.length) sections.push(["Extensions", rows(ext)]);
  const body = sections
    .filter(([, text]) => text)
    .map(([title, text]) => `${title}\n${text}`)
    .join("\n\n");
  return `${CLI_INTRO}\n\n${body}\n`;
}

/** Every tool name, in table order. */
export const TOOL_NAMES = Object.keys(TOOL_DEFS);

/** A verb as typed -> what it runs, or null. Dashes and underscores are the same. */
export function resolveVerb(verb) {
  const v = String(verb).replaceAll("-", "_");
  if (Object.hasOwn(ALIASES, v)) return { ...ALIASES[v], verb: v };
  if (Object.hasOwn(TOOL_DEFS, v)) return { tool: v, verb: v };
  return v.startsWith("ext_") ? { tool: v, verb: v } : null;
}

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

/**
 * An extension tool's result, read as a media payload, or null for plain data.
 *
 * WHY THIS EXISTS AT ALL. An extension tool hands back arbitrary JSON, and both
 * routes to a model serialise it as text: the in-app agent through
 * `toModelOutput`, an outside CLI through `tools/call`. So an image would arrive
 * as a few hundred KB of base64 the model cannot decode - all cost, no answer.
 * This is the one shape both routes agree to unpack into a real image part.
 *
 * Deliberately narrow: `{ mimeType, data }`, optionally beside a `content`
 * string. A looser guess (any object with a long base64-looking field) would
 * eventually mangle an ordinary result that happened to hold a hash.
 *
 * It lives here because this file is the only module the renderer AND the stdio
 * server both import, and two copies of a wire contract drift.
 */
export function extToolMedia(result) {
  if (!result || typeof result !== "object") return null;
  const { mimeType, data, content } = result;
  if (typeof mimeType !== "string" || typeof data !== "string") return null;
  if (!/^(image|audio)\//.test(mimeType) || data.length === 0) return null;
  return { mimeType, data, text: typeof content === "string" ? content : "" };
}
