/**
 * TEDI's own control surface, served as a REAL MCP server inside the app.
 *
 * The built-in agent used to reach these through bespoke `tedi_*` tools, which
 * made TEDI the one capability in the picker that was not an MCP server - its
 * own category, sitting beside "MCP: chrome-devtools-mcp" and behaving
 * differently for no reason a user could see.
 *
 * This is not a rename. It is the actual protocol: an SDK `Server` answering
 * `tools/list` and `tools/call`, linked to the host's `Client` by
 * `InMemoryTransport`. The picker groups it as `MCP: tedi` because it genuinely
 * IS one, and every rule the host applies to an MCP server - approval on every
 * call, the 64-char tool-name clamp, the per-server group - applies unchanged.
 *
 * WHY IN-MEMORY AND NOT THE STDIO SERVER IN `scripts/mcp/`. That one is the
 * way IN from outside: it spawns node and drives the window over the WebView2
 * DevTools socket. For this agent the window is the one it is already running
 * in, so going through it would mean a subprocess and a socket round trip to
 * reach a function in the same JS realm, it would only work while the automation
 * port is open (off by default), and a page target accepts exactly ONE DevTools
 * client - so the built-in agent would be fighting the user's real CLI session
 * for it. Same protocol, same tools, no transport theatre.
 *
 * ONE DEFINITION, TWO TRANSPORTS - AND NOW ACTUALLY ONE. Names, descriptions and
 * schemas all come from `scripts/mcp/tools.mjs`, the same table the stdio
 * server serves. They used to be declared twice, and the copies drifted: `ssh`
 * meant `{action, id}` there and `{connectionId}` here, so an agent following
 * the advertised contract silently LISTED connections instead of opening one.
 * Only the handlers live here, because only the handlers are genuinely
 * different - these call the functions in their own realm.
 *
 * That is also why this uses the SDK's low-level `Server` rather than
 * `McpServer`: `McpServer` wants Zod, and its object parse STRIPS unknown keys,
 * which is precisely what turned the `ssh` mismatch into a plausible wrong
 * answer instead of an error. `Server` serves the shared JSON Schema verbatim
 * and hands arguments to the handler untouched.
 *
 * `Server` carries an `@deprecated` tag reading "Use `McpServer` instead for the
 * high-level API. Only use `Server` for advanced use cases." Serving a schema
 * that a second, non-TypeScript transport also serves IS that advanced case -
 * the high-level API cannot express it without a Zod round trip that changes the
 * contract. Do not "fix" this back to `McpServer` without also solving that.
 *
 * ONE SET OF SWITCHES. These tools are gated by the SAME pack switches the MCP
 * dialog writes to `mcpDisabledTools`. Turning the Settings pack off has to mean
 * TEDI's own agent loses `set_setting` too - that switch exists so a driving
 * agent cannot hand itself back a capability the user took away, and an
 * in-process bypass would be exactly the hole it was built to close.
 *
 * THE WHOLE CONTROL SURFACE LIVES HERE. Panes, terminals, the browser, settings,
 * commands, extensions and SSH. There is no second, native copy of any of them:
 * one definition means one place to change and one standing token cost.
 *
 * WHAT IS DELIBERATELY NOT HERE. Reading and editing FILES (`read_file`, `edit`,
 * `grep`, ...) and the agent's own hidden shell (`bash_*`) stay native tools.
 * They are not app control: they need the read-before-edit cache, the scope
 * guards and the checkpoints that live in `tools/`. `bash_*` additionally has to
 * stay native because sub-agents receive it and receive no MCP tools at all
 * (`agents/runSubagent.ts`) - serving it from here would leave every worker
 * without a shell.
 *
 * SECURITY: no port, no subprocess, no IPC boundary - strictly less exposed than
 * the stdio path. Nothing here can read a secret: keys live in the OS keyring and
 * `getConnectionSecrets` is not imported. Approval is the host's (`tools/mcp.ts`):
 * every call raises a card except a `readOnlyHint` tool, or an `action` this
 * repo's own table marks `auto` - which is how reading a page stays as
 * unattended as `read_file` while clicking one does not.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_DEFS, validateArgs } from "@mcp/tools.mjs";
import { readSettings, writeSetting } from "@/modules/settings/preferences";
import { controlExtension, listExtensions, runExtensionCommand } from "@/modules/extensions/store";
import { listCommands, runCommand } from "@/modules/shortcuts/lib/commandRegistry";
import { listConnections } from "@/modules/ssh/connections";
import { listWorkspacesForAgent } from "@/modules/workspaces/store";
import { callBridge } from "@/modules/automation/bridge";
import { trustEgressHost, unsafeBrowserUrl } from "./security";
import { checkedShellCommand } from "../tools/shell";
import { TEDI_MCP_SERVER_NAME } from "./mcpConfig";

/** Opening an SSH connection needs a tab, which only the app can make. Injected
 *  rather than imported: this module must not pull in React or the chat store,
 *  which would close an import cycle back through the tool builder. */
export type TediMcpDeps = {
  openSshTab: (connectionId: string, name: string, isPrivate?: boolean) => boolean;
  /** Resolved pack switches, from `getMcpSurface().disabledTools`. Same list the
   *  stdio server filters on. Absent means nothing is switched off. */
  disabledTools?: readonly string[];
};

/**
 * Cap on a single tool result, in characters.
 *
 * The stdio server caps its reads at 20 000 and says so in the schema; this side
 * had no cap at all, so `inspect settings` shipped the entire preference store
 * (custom theme, full terminal palette, every shortcut) and an extension AI tool
 * could return an unbounded query result straight into the context window. Same
 * number, so the same call costs the same on either transport.
 */
const MAX_RESULT_CHARS = 20000;

/** MCP replies are content blocks. Everything here answers with one JSON block. */
function json(value: unknown) {
  let text = JSON.stringify(value, null, 2);
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}\n... truncated at ${MAX_RESULT_CHARS} characters. Ask for something narrower.`;
  }
  return { content: [{ type: "text" as const, text }] };
}

/**
 * A failure the agent should read and act on.
 *
 * `isError` is the part that matters and the part that was missing. Every
 * business failure here used to return `json({ error })` - a SUCCESS envelope
 * whose text happened to contain the word "error". The host checks
 * `result.isError` (`tools/mcp.ts`), found it falsy, and rendered a failed call
 * as a completed one; the model had to notice the word in the JSON. The stdio
 * server got this right by throwing, which its dispatcher turns into `isError`.
 */
function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/**
 * A tool result. Text for almost everything; an image block for a screenshot,
 * which `tools/mcp.ts` forwards as a real file part rather than base64 prose.
 */
type McpResult = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  isError?: boolean;
};

type Handler = (args: Record<string, unknown>, deps: TediMcpDeps) => Promise<McpResult>;

/**
 * Call an app capability by name (`modules/automation/bridge`).
 *
 * Reaching the app by NAME rather than by import is what lets the pane, terminal
 * and browser handlers live in this module at all: it must not import React or
 * the chat store, or the tool builder closes an import cycle back through it.
 * Each capability is registered by the component that owns it, so the stdio
 * driver and this server call the same function rather than two copies of it.
 *
 * Typed at the call site: the bridge is a registry, not an interface.
 */
function bridge<T>(name: string, ...args: unknown[]): Promise<T> {
  return callBridge(name, args) as Promise<T>;
}

/** One row of `termProbe`; `hash`/`hit` are only filled for the scoped leaf. */
type TermRow = { leafId: number; atPrompt: boolean; running: boolean; hash: number; hit: boolean };
/** One row of `termTails`. */
type TailRow = { leafId: number; atPrompt: boolean; running: boolean; text: string };
type EditorRow = { leafId: number; path: string; truncated: boolean; text: string };
type PaneResult = { ok: true; [k: string]: unknown } | { ok: false; error: string };

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Is this a base64 blob, or one of the bridge's failure sentences? Both are
 *  strings and both are long, so length cannot tell them apart - base64 has no
 *  spaces and no punctuation outside `+/=`, and a sentence has both. */
function isBase64Payload(v: unknown): v is string {
  return typeof v === "string" && v.length > 100 && /^[A-Za-z0-9+/=]+$/.test(v);
}

/** An MCP image content block. */
function imageResult(data: string, mimeType = "image/jpeg"): McpResult {
  return { content: [{ type: "image", data, mimeType }] };
}

/**
 * The refusal for a browser pane that exists but has no page behind it.
 *
 * A pane and its PAGE are two different things: the leaf appears in `list` as
 * soon as it is created, while the native webview behind it exists only once a
 * URL has loaded. TEDI also refuses some URLs outright - its own address would
 * recurse - and such a pane renders a "Browser blocked" card and never gets a
 * webview. Every native call then fails, and the Rust-level wording for that is
 * "no open browser pane with that id", which points at the leafId when the
 * leafId is fine. Both real causes are recoverable, so both are named.
 */
function noPageYet(leaf: number): string {
  return `Browser pane ${leaf} has no live page. It is either still loading - retry once - or the URL was refused (TEDI will not load its own address, which would recurse). Open a different URL, or check it with browser({action:"list"}).`;
}

/** Unwrap a `{ok}` result from the app, or throw its reason. The bridge answers
 *  a sentence when the AI panel has never mounted, which is neither shape. */
function unwrap(r: PaneResult | string): Record<string, unknown> {
  if (typeof r === "string") throw new Error(r);
  if (r.ok !== true) throw new Error(r.error);
  return r as Record<string, unknown>;
}

/**
 * Which terminal a call means.
 *
 * An explicitly-passed leafId that is not a terminal is NEVER redirected
 * somewhere else. That would answer a question about pane A with pane B's
 * output, labelled as success - the one failure no error message ever follows.
 * Same rule the stdio driver applies, deliberately.
 */
async function resolveTerminal(leafId: unknown): Promise<number> {
  let rows = await bridge<TermRow[]>("termProbe", null, false);

  // A just-opened pane is in the tab tree before its xterm handle registers, and
  // those are two different sources: `termList` reads the tree, `termProbe` the
  // handle map. So a leafId handed back by `pane {action:"open"}` or `ssh
  // connect` is not addressable for another render tick, and using it in the
  // same turn would be refused as "not a terminal".
  //
  // The wait belongs HERE rather than in the openers, so it covers a pane opened
  // any way at all - by the user, by `run_command`, by a command id.
  if (leafId !== undefined && leafId !== null) {
    const want = Number(leafId);
    if (rows.some((r) => r.leafId === want)) return want;
    const known = await bridge<Array<{ leafId: number }>>("termList");
    if (known.some((t) => t.leafId === want)) {
      for (let i = 0; i < 15; i++) {
        await sleep(100);
        rows = await bridge<TermRow[]>("termProbe", null, false);
        if (rows.some((r) => r.leafId === want)) return want;
      }
    }
    throw new Error(
      `Leaf ${want} is not a terminal. Terminals: ${rows.map((r) => r.leafId).join(", ") || "(none)"}`,
    );
  }
  if (!rows.length) throw new Error('No terminal pane is open. Use `pane` with action "open".');
  const ids = rows.map((r) => r.leafId).join(", ");
  const focused = await bridge<number | null>("focusedLeaf");
  if (focused !== null && rows.some((r) => r.leafId === focused)) return focused;
  if (rows.length === 1) return rows[0].leafId;
  throw new Error(
    `Focus is not in a terminal and ${rows.length} are open - pass leafId. Terminals: ${ids}`,
  );
}

/**
 * Block until a terminal is done, then say why it returned.
 *
 * Two conditions, because a prompt is not always the finish line. With no
 * `needle` it waits for the prompt, which is right for a command. With one it
 * waits for that string to appear, the only workable signal for something that
 * never returns - a dev server printing its port, a TUI reaching a screen.
 *
 * A timeout is REPORTED, not thrown: "it is still going" is an answer.
 */
async function waitTerminal(
  leaf: number,
  needle: string | null,
  timeout: number,
  lines = 8,
): Promise<{ leafId: number; done: boolean; reason: string; tail: string }> {
  const deadline = Date.now() + timeout;
  const finish = async (done: boolean, reason: string) => {
    const t = (await bridge<TailRow[]>("termTails", lines)).find((x) => x.leafId === leaf);
    return { leafId: leaf, done, reason, tail: t?.text ?? "" };
  };
  for (;;) {
    await sleep(250);
    const row = (await bridge<TermRow[]>("termProbe", needle, false, leaf)).find(
      (r) => r.leafId === leaf,
    );
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
 * Handlers, keyed by the name in `TOOL_DEFS`.
 *
 * Anything in that table with no handler here is stdio-only, and stays that way
 * on purpose: `keys`, `type_text`, `click` and `drag` synthesise real input
 * events for an agent that has no other way to reach the UI, `eval_js` is an
 * arbitrary-code escape hatch, and `inspect logs` reads the DevTools console.
 * The agent running INSIDE the window needs none of them and would pay for all
 * of them on every request.
 */
const HANDLERS: Record<string, Handler> = {
  inspect: async ({ what }) => {
    if (what === "commands") return json({ commands: listCommands() });
    if (what === "extensions") return json(listExtensions());
    if (what === "settings") return json(readSettings());
    if (what === "workspaces") return json({ workspaces: listWorkspacesForAgent() });
    // `logs` is in the shared schema because the stdio server reads the DevTools
    // console over CDP. There is no in-realm twin, and inventing one that
    // returned an empty list would read as "nothing was logged".
    return fail(
      'inspect "logs" reads the DevTools console, which only the stdio MCP server can do. From here, use commands, extensions or settings.',
    );
  },

  run_command: async ({ id, extensionId, args }) => {
    if (extensionId) {
      const out = await runExtensionCommand(
        String(extensionId),
        String(id),
        args as Record<string, unknown> | undefined,
      );
      if (!out) {
        return fail(
          `Nothing answers to "${id}" in ${extensionId}. It may be disabled, or the id was declared but never given a handler.`,
        );
      }
      return json(out.kind === "aiTool" ? { result: out.result } : { ok: true, ran: id });
    }
    return runCommand(id as Parameters<typeof runCommand>[0])
      ? json({ ok: true, ran: id })
      : fail(`No handler is registered for "${id}" right now.`);
  },

  set_setting: async ({ key, value }) => {
    const r = await writeSetting(String(key), value);
    return r === true ? json({ ok: true, key, value }) : fail(String(r));
  },

  extension: async ({ action, id }) => {
    const r = await controlExtension(action as Parameters<typeof controlExtension>[0], String(id));
    return r === true ? json({ ok: true, action, id }) : fail(String(r));
  },

  ssh: async ({ action, id, private: isPrivate }, deps) => {
    const conns = await listConnections();
    if (action === "list") {
      return json({
        connections: conns.map((c) => ({
          id: c.id,
          name: c.name,
          host: c.host,
          port: c.port,
          user: c.user,
          authMode: c.authMode,
        })),
      });
    }
    if (!id) return fail('ssh "connect" needs `id` (from `ssh list`).');
    const conn = conns.find((c) => c.id === id);
    if (!conn) return fail(`No saved SSH connection "${id}".`);
    // Snapshot BEFORE, so the new pane can be told from the ones already open.
    const before = new Set(
      (await bridge<Array<{ leafId: number }>>("termList")).map((t) => t.leafId),
    );
    // The boolean was being DISCARDED, so a refused open still answered
    // `{ok:true, opened}`. That is how a stub `openSshTab` (the default deps
    // when a caller forgets to pass them) reported success on a tab that was
    // never created.
    if (!deps.openSshTab(conn.id, conn.name, isPrivate === true)) {
      return fail(`Could not open a tab for "${conn.name}".`);
    }
    // Resolve the new pane's leafId before answering. Opening the tab is not the
    // job - working in it is - and every other tool addresses a pane by leafId,
    // so without this the caller holds a live session it cannot use. A `state`
    // call on the same turn does not substitute: it races the mount.
    //
    // A private pane is deliberately NOT resolvable. It is absent from every
    // listing by design, so `leafId` stays null and the reply says why, rather
    // than reporting a pane that cannot be found.
    let leafId: number | null = null;
    if (isPrivate !== true) {
      for (let i = 0; i < 20; i++) {
        await sleep(100);
        const fresh = (await bridge<Array<{ leafId: number }>>("termList")).find(
          (t) => !before.has(t.leafId),
        );
        if (fresh) {
          leafId = fresh.leafId;
          break;
        }
      }
    }
    return json({
      ok: true,
      opened: conn.name,
      host: conn.host,
      leafId,
      ...(leafId === null
        ? {
            note:
              isPrivate === true
                ? "Opened as a private pane, which no tool can see or address."
                : "The pane did not appear in time; call `state` next turn for its leafId.",
          }
        : { hint: `Run commands on it with sh({ command, leafId: ${leafId} }).` }),
    });
  },

  state: async ({ tail, buttons }) =>
    json(await bridge("state", { tail: Number(tail ?? 3), buttons: buttons === true })),

  read: async ({ source, selector, leafId, nth, lines, maxChars }) => {
    const cap = Number(maxChars ?? MAX_RESULT_CHARS);
    if (source === "terminal") {
      const leaf = await resolveTerminal(leafId);
      const row = (await bridge<TailRow[]>("termTails", Number(lines ?? 200))).find(
        (t) => t.leafId === leaf,
      );
      return json({
        leafId: leaf,
        atPrompt: row?.atPrompt,
        running: row?.running,
        text: (row?.text ?? "").slice(0, cap),
      });
    }
    if (source === "editors") {
      const list = await bridge<EditorRow[]>("editors", cap);
      return list.length ? json(list) : fail("No editor pane is open.");
    }
    if (source === "dom") {
      if (!selector) return fail('read "dom" needs `selector`.');
      const text = await bridge<string | null>("text", String(selector), Number(nth ?? 0));
      return text === null
        ? fail(`Nothing matches "${selector}" (or it is inside a private pane).`)
        : json({ selector, text: text.slice(0, cap) });
    }
    return fail(`Unknown source "${source}". Have: terminal, editors, dom.`);
  },

  /**
   * Run a command in the USER'S terminal and return what it printed.
   *
   * `checkedShellCommand` FIRST, and it is not optional. It applies the shell
   * denylist AND the extension transformer chain (RTK rewrites `git status` into
   * `rtk git status`), then re-checks what the transformer produced - the gap
   * that once let a transformer smuggle a refused command past the denylist. The
   * bridge below is deliberately dumb, so this is the only place that guard can
   * live for this transport, exactly where `run_in_terminal` had it.
   */
  sh: async ({ command, leafId, submit, capture, timeout, lines }) => {
    const vetted = checkedShellCommand(String(command ?? "").replace(/[\r\n]+$/, ""), "terminal");
    if (!vetted.ok) return fail(vetted.error);
    const leaf = await resolveTerminal(leafId);

    /**
     * Off-screen run: its own SSH channel, exact bytes, nothing rendered.
     *
     * The visible path returns the SCROLLBACK, which is a fixed ring of rendered
     * rows - output longer than the ring loses its beginning, and no error says
     * so. Anything whose VALUE is the output (a file, a listing, anything to be
     * parsed) has to come back this way instead.
     *
     * Placed BEFORE the busy check: a separate channel does not touch the pane,
     * so a command running in the foreground is no reason to refuse, and reading
     * a file while a build runs is exactly when this matters.
     */
    if (capture === true) {
      const out = await bridge<string>("sshExec", leaf, vetted.command);
      // The bridge answers a sentence for every failure - not connected, a
      // non-zero exit with the remote's stderr, a closed session.
      return typeof out === "string" && out.startsWith(`Leaf ${leaf} is not a connected SSH pane`)
        ? fail(
            `${out} \`capture\` runs off-screen over an SSH channel, so it needs one. For a LOCAL pane use your bash_run tool, which is the same thing on this machine.`,
          )
        : json({ leafId: leaf, command: vetted.command, captured: true, text: out });
    }
    // Refuse a busy pane for BOTH paths. A write into a running command or a
    // full-screen TUI lands in THAT program's input buffer, appended to whatever
    // the user was already typing - two prompts silently merged into one line.
    if (await bridge<boolean>("termBusy", leaf)) {
      // The refusal names `read` and `wait_for_terminal` because both work on a
      // busy pane - they only look at it. Told merely "it is busy", a caller
      // opens a second pane, or for SSH a second connection, to see output that
      // is already on screen.
      return fail(
        `Terminal ${leaf} is busy (a command is running, or a full-screen TUI is on the alt-screen); writing to it would land in that program's input. To SEE what it is doing use read({source:"terminal", leafId:${leaf}}), or wait_for_terminal({leafId:${leaf}}) to block until it finishes. Only open another pane if you need to run something ALONGSIDE it.`,
      );
    }

    // `submit: false` types without running, which is a RAW PTY write with no
    // bracketed-paste wrapper - so an embedded newline would auto-run every line
    // with no approval at all. Checked after the transformer chain too: an
    // extension that injects one would do exactly that. Submitting is meant to
    // run, so a multi-line command is fine on that path.
    if (submit === false) {
      if (/[\r\n]/.test(vetted.command)) {
        return fail(
          "Refused: typing without running cannot contain a newline - it would auto-run the following lines. Drop `submit: false` to execute it.",
        );
      }
      const typed = await bridge<true | string>("termInject", leaf, vetted.command);
      return typed === true
        ? json({ leafId: leaf, command: vetted.command, typed: true, submitted: false })
        : fail(String(typed));
    }

    const before = (await bridge<TermRow[]>("termProbe", null, true, leaf)).find(
      (r) => r.leafId === leaf,
    );
    const run = await bridge<true | string>("termRun", leaf, vetted.command);
    if (run !== true) return fail(String(run));

    // "The buffer CHANGED and the prompt is back", not just "the prompt is
    // back". Submitting returns before the shell has echoed anything, so a bare
    // prompt check passes instantly against the PREVIOUS prompt and the output
    // gets read before it exists.
    const deadline = Date.now() + Number(timeout ?? 20000);
    let changed = false;
    let timedOut = false;
    for (;;) {
      await sleep(150);
      const now = (await bridge<TermRow[]>("termProbe", null, true, leaf)).find(
        (r) => r.leafId === leaf,
      );
      if (!now) return fail(`Terminal ${leaf} disappeared mid-command.`);
      if (!changed && now.hash !== before?.hash) changed = true;
      if (changed && now.atPrompt && !now.running) break;
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
    }
    const tail = (await bridge<TailRow[]>("termTails", Number(lines ?? 60))).find(
      (t) => t.leafId === leaf,
    );
    return json({
      leafId: leaf,
      command: vetted.command,
      // A TUI never comes back to a prompt, so this is reported rather than
      // thrown: opening one on purpose is legitimate and the buffer is still
      // the answer.
      timedOut,
      text: tail?.text ?? "",
    });
  },

  wait_for_terminal: async ({ leafId, text, timeout }) =>
    json(
      await waitTerminal(
        await resolveTerminal(leafId),
        text ? String(text) : null,
        Number(timeout ?? 60000),
      ),
    ),

  focus_pane: async ({ leafId }) => {
    const ok = await bridge<boolean | string>("focusPaneVerified", Number(leafId));
    return ok === true
      ? json({ ok: true, leafId })
      : fail(
          typeof ok === "string"
            ? ok
            : `Could not focus leaf ${leafId} - it may be in a background tab, or private.`,
        );
  },

  pane: async ({ action, leafId, leafIds, tabId, cwd, split, dir, count, all }) => {
    switch (action) {
      case "open": {
        const n = Math.min(Math.max(Number(count ?? 1), 1), 6);
        const opened: unknown[] = [];
        let intoTab = tabId === undefined ? null : Number(tabId);
        for (let i = 0; i < n; i++) {
          // count>1 keeps the rest in the tab the first one landed in, so a
          // batch is one group rather than N loose tabs.
          const r = unwrap(
            await bridge<PaneResult | string>("paneOpen", {
              cwd: cwd == null ? null : String(cwd),
              mode: split === true || i > 0 ? "split" : "tab",
              splitDir: dir === "col" ? "col" : "row",
              targetTabId: intoTab,
            }),
          );
          intoTab = Number(r.tabId);
          opened.push(r);
        }
        return json({ opened });
      }
      case "close": {
        if (all === true) {
          const terms = await bridge<Array<{ leafId: number }>>("termList");
          let closed = 0;
          // Last to first, so the survivor the app refuses to close is the
          // first terminal rather than an arbitrary one.
          for (const t of terms.slice(1).reverse()) {
            const r = await bridge<PaneResult | string>("paneClose", t.leafId);
            if (typeof r !== "string" && r.ok === true) closed++;
          }
          return json({ ok: true, closed, of: terms.length });
        }
        if (leafId === undefined) return fail("close needs `leafId`, or `all`.");
        return json(unwrap(await bridge<PaneResult | string>("paneClose", Number(leafId))));
      }
      case "group": {
        if (!Array.isArray(leafIds) || leafIds.length < 2) {
          return fail("group needs `leafIds` with two or more panes (ids come from `state`).");
        }
        return json(
          unwrap(
            await bridge<PaneResult | string>(
              "paneGroup",
              leafIds.map(Number),
              tabId === undefined ? undefined : Number(tabId),
            ),
          ),
        );
      }
      case "rotate": {
        if (leafId === undefined) return fail("rotate needs `leafId`.");
        return json(
          unwrap(
            await bridge<PaneResult | string>(
              "paneRotate",
              Number(leafId),
              dir === "row" || dir === "col" ? dir : undefined,
            ),
          ),
        );
      }
      case "consolidate": {
        const terms = await bridge<Array<{ leafId: number; tabId: number }>>("termList");
        if (terms.length < 2) return fail("Fewer than two terminals are open.");
        return json(
          unwrap(
            await bridge<PaneResult | string>(
              "paneConsolidate",
              tabId === undefined ? terms[0].tabId : Number(tabId),
            ),
          ),
        );
      }
      default:
        return fail(`Unknown action "${action}". Have: open, close, group, rotate, consolidate.`);
    }
  },

  browser: async (args) => {
    const action = String(args.action);
    // History and the address bar are ordinary registered commands acting on the
    // focused pane; everything else needs a leaf.
    // `address` focuses the URL bar of whichever pane has focus, which is what
    // that affordance means; there is no per-leaf equivalent and none would make
    // sense. Every other verb takes a leafId and is handled after the pane is
    // resolved below.
    if (action === "address") {
      const id = "browser.focusAddressBar" as Parameters<typeof runCommand>[0];
      return runCommand(id) ? json({ ok: true, ran: id }) : fail(`No handler for "${id}" now.`);
    }
    if (action === "list") return json({ browsers: await bridge("browserList") });

    if (action === "open") {
      const url = String(args.url ?? "");
      const bad = unsafeBrowserUrl(url);
      if (bad) return fail(bad);
      // Runs only once approval resolved, so this records what the user allowed
      // and the same host stops asking for the rest of the session.
      trustEgressHost(url);
      const open = await bridge<Array<{ leafId: number }>>("browserList");
      // Reuse ONE open pane by default. Only when exactly one is open: with two
      // or more, one may be the user's own and hijacking it is worse than an
      // extra tab.
      if (args.newTab !== true && open.length === 1) {
        const nav = await bridge<true | string>("browserNav", open[0].leafId, url);
        if (nav === true) {
          return args.read === true
            ? json({
                leafId: open[0].leafId,
                url,
                reused: true,
                text: await bridge("browserRead", open[0].leafId, false),
              })
            : json({ leafId: open[0].leafId, url, reused: true });
        }
      }
      const tab = await bridge<number | string>("browserOpen", url);
      if (typeof tab !== "number") return fail(String(tab));
      // `openPreview` returns the TAB id; every other action keys off the LEAF
      // id, and the pane mounts a render tick later - so resolve it before
      // handing it back, or the model chains its next call on an id that does
      // not resolve and re-opens the page.
      let leaf = tab;
      for (let i = 0; i < 10; i++) {
        const hit = (await bridge<Array<{ tabId: number; leafId: number }>>("browserList")).find(
          (b) => b.tabId === tab,
        );
        if (hit) {
          leaf = hit.leafId;
          break;
        }
        await sleep(100);
      }
      if (args.read !== true) return json({ leafId: leaf, url });
      // While the webview is still mounting the read answers null; once it
      // exists the native read waits out page load (~3s).
      for (let i = 0; i < 12; i++) {
        const text = await bridge<string>("browserRead", leaf, false);
        if (text) return json({ leafId: leaf, url, text });
        await sleep(200);
      }
      return json({ leafId: leaf, url, text: "" });
    }

    // Resolve AND authorize against the same list, always. `browserList` is
    // privacy-filtered in the app; an explicitly-passed leafId that skipped it
    // would reach a private pane by id.
    const visible = await bridge<Array<{ leafId: number }>>("browserList");
    if (!visible.length) return fail('No browser pane is open. Use action "open" with a `url`.');
    const leaf = args.leafId === undefined ? visible[0].leafId : Number(args.leafId);
    if (!visible.some((b) => b.leafId === leaf)) {
      return fail(
        `No browser pane with leafId ${leaf}. Open ones: ${visible.map((b) => b.leafId).join(", ")}.`,
      );
    }

    if (action === "navigate") {
      const url = String(args.url ?? "");
      const bad = unsafeBrowserUrl(url);
      if (bad) return fail(bad);
      trustEgressHost(url);
      const r = await bridge<true | string>("browserNav", leaf, url);
      return r === true ? json({ ok: true, leafId: leaf, url }) : fail(String(r));
    }
    if (action === "back" || action === "forward" || action === "reload") {
      // Driven per LEAF, not by running the matching command id. A command acts
      // on whichever pane holds focus, and while the agent is working that is
      // the AI panel - so a reload aimed at a named browser either did nothing
      // or hit some other pane, and reported success either way.
      const r = await bridge<true | string>("browserDispatch", leaf, action);
      return r === true ? json({ ok: true, leafId: leaf, action }) : fail(noPageYet(leaf));
    }
    if (action === "read") {
      const text = await bridge<string>("browserRead", leaf, args.fields === true);
      // An empty read is a failure, not an empty page: a pane with no webview
      // reads as "" forever. Refuse with the reason instead (see `noPageYet`).
      if (!text) return fail(noPageYet(leaf));
      return json({ leafId: leaf, text });
    }
    if (action === "console") {
      const entries = await bridge<Array<{ level: string; text: string }> | string>(
        "browserConsole",
        leaf,
      );
      // `browserConsole` answers a sentence for "not a browser pane", which
      // here can only mean the webview is absent - the leaf was authorized
      // against `browserList` two lines up.
      if (typeof entries === "string") return fail(noPageYet(leaf));
      if (!entries.length)
        return json({ leafId: leaf, entries: [], note: "Nothing since the last read." });
      // A page in a render loop logs thousands, and the newest are the ones
      // that explain the current state.
      const kept = entries.slice(-40);
      return json({
        leafId: leaf,
        entries: kept.map((e) => ({ level: e.level, text: e.text })),
        ...(entries.length > kept.length ? { dropped: entries.length - kept.length } : {}),
      });
    }
    if (action === "url") {
      // From the same privacy-filtered snapshot that authorized the leaf above,
      // rather than a second call by raw tab id - the Rust side has no notion
      // of a private pane.
      const hit = (await bridge<Array<{ leafId: number; url?: string }>>("browserList")).find(
        (b) => b.leafId === leaf,
      );
      return json({ leafId: leaf, url: hit?.url ?? null });
    }
    if (action === "screenshot") {
      const shot = await bridge<string>("browserShot", leaf);
      // A real image block, not base64 in text: `tools/mcp.ts` turns it into a
      // file part the model can actually look at.
      //
      // Length alone is NOT the test. Every browser helper answers a SENTENCE
      // rather than null when the AI panel has not mounted, and that sentence is
      // 104 characters - so a `> 100` check would have forwarded the apology as
      // a JPEG. Base64 has no spaces; a failure message always does.
      return isBase64Payload(shot) ? imageResult(shot) : fail(String(shot));
    }

    const act = {
      click: "click",
      hover: "hover",
      type: "type",
      key: "key",
      scroll: "scroll",
      click_at: "clickxy",
    }[action];
    if (!act) return fail(`Unknown action "${action}".`);
    if (
      (action === "click" || action === "hover" || action === "type") &&
      args.index === undefined
    ) {
      return fail(
        `${action} needs \`index\` - call read with \`fields\` first to get the [N] list.`,
      );
    }
    const text =
      action === "scroll"
        ? String(args.to ?? "down")
        : action === "click_at"
          ? `${args.x},${args.y}`
          : String(args.text ?? "");
    const r = await bridge<string>(
      "browserAct",
      leaf,
      Number(args.index ?? 0),
      act,
      text,
      args.submit === true,
    );
    if (r === "ok") return json({ ok: true, leafId: leaf, action });
    return fail(
      r === "not-found"
        ? `No control [${args.index}] on leaf ${leaf} - read with \`fields\` again; the indices reset on every navigation.`
        : r === "option-not-found"
          ? "No <select> option matched - pass the exact label or value from the listed options."
          : // The Rust layer says "no open browser pane with that id" when the
            // WEBVIEW is missing, which reads as "your leafId is wrong" and sent
            // the agent back to `list` - where the pane is, every time. The pane
            // is fine; the page is not.
            /no open browser pane/i.test(String(r))
            ? noPageYet(leaf)
            : String(r),
    );
  },
};

// A handler whose name is not in the shared table would be silently dropped by
// the filter below - an unadvertised, uncallable tool that still looks present
// in this file. Fail at load instead, the same way `server.mjs` does for its half.
{
  const orphan = Object.keys(HANDLERS).filter((n) => !TOOL_DEFS[n]);
  if (orphan.length) {
    throw new Error(
      `tediMcpServer has handlers with no entry in scripts/mcp/tools.mjs: ${orphan.join(", ")}`,
    );
  }
}

/**
 * Build the in-process server and return the transport for the host's `Client`.
 * One linked pair per call; the caller owns the lifetime.
 */
export async function startTediMcpServer(deps: TediMcpDeps) {
  const server = new Server(
    { name: TEDI_MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const off = new Set(deps.disabledTools ?? []);
  /** A disabled tool is neither advertised NOR callable. Both halves matter:
   *  hiding it from `tools/list` alone leaves it reachable by name, which is the
   *  bug the stdio server shipped with. */
  const available = Object.keys(HANDLERS).filter((name) => TOOL_DEFS[name] && !off.has(name));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: available.map((name) => ({
      name,
      description: TOOL_DEFS[name].description,
      inputSchema: TOOL_DEFS[name].schema,
      // Same table, same annotations, so a client sees the identical contract on
      // either transport - which is the whole reason the table is shared.
      ...(TOOL_DEFS[name].annotations ? { annotations: TOOL_DEFS[name].annotations } : {}),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    if (off.has(name)) {
      return fail(
        `"${name}" is switched off for this MCP server. Turn its pack back on in TEDI: header, Install MCP.`,
      );
    }
    const handler = HANDLERS[name];
    if (!handler) return fail(`Unknown tool "${name}". Have: ${available.join(", ")}`);
    // Same shallow check the stdio server runs, from the same table, so a
    // malformed call is refused identically whichever server answers it.
    const bad = validateArgs(name, req.params.arguments);
    if (bad) return fail(bad);
    try {
      return await handler((req.params.arguments ?? {}) as Record<string, unknown>, deps);
    } catch (e) {
      return fail(e instanceof Error ? e.message : `"${name}" failed.`);
    }
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return { server, clientTransport };
}
