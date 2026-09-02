/**
 * The DOM half of the automation surface, in the app instead of in a string.
 *
 * WHY THIS FILE EXISTS. `scripts/mcp/driver.mjs` built these answers by
 * INJECTING JavaScript over the WebView2 DevTools Protocol - the only route it
 * had before the local socket existed. That made them CDP-only, and CDP is
 * Windows-only: `preview::apply_webview2_browser_args_env`, the one place
 * `--remote-debugging-port` is ever appended, is `#[cfg(target_os = "windows")]`.
 * So on macOS and Linux the always-on `tedi` MCP pack's headline tools - `state`
 * (whose own description says "Call it first"), `read source:"terminal"`,
 * `read source:"dom"`, `run_command`, `wait_for_terminal`, `sh`, `focus_pane`,
 * `inspect commands` - could not run at all, and the error told the user to turn
 * on an automation channel their platform never opens.
 *
 * ONE IMPLEMENTATION, NOT TWO. These are registered as ordinary bridge
 * capabilities, and `driver.mjs` now CALLS them by name rather than carrying its
 * own copy. That direction matters: `transport.mjs` prefers the socket on EVERY
 * platform, so a second implementation here would immediately take over on
 * Windows too, and any field-level drift between the two would be a silent wrong
 * answer rather than an error.
 *
 * The reads are transcribed verbatim, traps included. In particular
 * `focusedLeaf` must keep asking the DOM what has focus rather than reading the
 * store's `activeLeafId`: those are different questions, and the privacy filter
 * has to sit on the MATCHED element so focus resting in a private pane answers
 * null instead of naming it.
 */
import { callBridge, registerBridge } from "./bridge";

/** Last `n` lines of a buffer, trailing blank run trimmed. */
function tail(s: string, n: number): string {
  return String(s ?? "")
    .trimEnd()
    .split("\n")
    .slice(-n)
    .join("\n");
}

/**
 * Index of a splitter BETWEEN TWO PANES among all resize handles, or -1.
 *
 * The obvious version - "the first handle inside the leaf's closest panel group"
 * - is wrong in a way that only shows up with ONE pane open: a single leaf
 * renders no group at all, so `closest` walks up to the app's outer layout and
 * the answer comes back 0, which is the SIDEBAR's handle. Dragging that
 * collapses the sidebar and takes every later explorer and editor step with it,
 * silently. So identify the group by its own children: only pane panels carry
 * `id="pane-<leafId>"`, where the outer layout's are `sidebar` / `workspace` /
 * `right-slot`.
 */
function paneHandle(): number {
  const inPaneGroup = (h: Element): boolean => {
    const g = h.closest("[data-slot=resizable-panel-group]");
    if (!g) return false;
    // Panels belonging to THIS group, not to one nested inside it: a split
    // inside a split gives every level its own pane- panels, so ownership has to
    // be decided by the panel's own nearest group.
    const mine = [...g.querySelectorAll('[data-slot=resizable-panel][id^="pane-"]')].filter(
      (p) => p.closest("[data-slot=resizable-panel-group]") === g,
    );
    return mine.length >= 2;
  };
  return [...document.querySelectorAll("[data-slot=resizable-handle]")].findIndex(inPaneGroup);
}

/**
 * Leaf id holding keyboard focus, or null.
 *
 * xterm keeps focus in a hidden textarea inside the leaf, so this identifies the
 * pane a script just typed into without inferring it from "the newest one",
 * which is wrong the moment focus moves back to an older pane.
 *
 * `:not([data-pane-private])` is the privacy filter and it has to be on the
 * MATCHED element, not applied afterwards: focus resting in a private pane used
 * to return that pane's id, which every `sh` / `read terminal` / `save_editor`
 * call then used as its default target.
 */
function focusedLeaf(): number | null {
  const el = document.activeElement?.closest("[data-pane-leaf]:not([data-pane-private])");
  return el ? Number(el.getAttribute("data-pane-leaf")) : null;
}

/**
 * Text of a selector, which is how a take reads a pane back.
 *
 * CodeMirror's lines are read directly rather than through `innerText`: TEDI
 * hides an inactive tab with `visibility: hidden` so its PTYs keep streaming,
 * and `innerText` returns "" for anything hidden, which would make a perfectly
 * loaded editor look empty. `.cm-line` also gives real line breaks.
 *
 * NOT for terminals: those render to a WebGL canvas and have no DOM text.
 */
function domText(selector: string, nth = 0): string | null {
  const el = document.querySelectorAll(selector)[Number(nth)] as HTMLElement | undefined;
  if (!el) return null;
  // A selector that happens to land inside a private pane is the DOM route
  // around the privacy rule: `.cm-content` reads a private editor's buffer line
  // by line. Refuse by ancestry rather than by selector, so no future selector
  // reopens it.
  if (el.closest?.("[data-pane-private]")) return null;
  const lines = el.classList?.contains("cm-content") ? el.querySelectorAll(".cm-line") : [];
  if (lines.length) return [...lines].map((l) => l.textContent).join("\n");
  return el.innerText || el.textContent || "";
}

type TerminalRow = { leafId: number; atPrompt?: boolean; running?: boolean; text: string };

/** How many ROWS to ask xterm for. Asking for fewer returns "" on a pane that
 *  has not scrolled, because `getBuffer(n)` takes the last n rows and strips the
 *  trailing blanks - which on a fresh pane ARE those rows. */
const BUFFER_ROWS = 200;

/**
 * Window state, in one call.
 *
 * `state` is the verb an agent is told to call before every move, so it folds the
 * DOM read and the `panes`/`terminals` read into a SINGLE answer; it used to be
 * four separate round trips plus a full 200-row buffer per pane.
 *
 * Degrades instead of throwing: this is the verb reached for when something is
 * already wrong, and the DOM half stays useful when the pane registry is not up.
 */
async function state({ tail: tailLines = 3, buttons = false } = {}): Promise<
  Record<string, unknown>
> {
  const q = (s: string): Element[] => [...document.querySelectorAll(s)];
  const kindOf = (el: Element): string =>
    el.querySelector(".xterm-screen")
      ? "terminal"
      : el.querySelector(".cm-content")
        ? "editor"
        : "browser";
  const modal = document.querySelector(
    "[role=dialog][data-state=open],[role=alertdialog][data-state=open]",
  );
  const a = document.activeElement as HTMLInputElement | null;
  const focusLeafEl = a?.closest("[data-pane-leaf]");

  // A tab's innerText is '<leaf number>\n<name>' per leaf, so a split tab
  // repeats the same name once per pane and the FIRST line is a bare number.
  // Drop the numeric lines, dedupe the rest, keep the first element per id (the
  // group wrapper, which covers every leaf in it).
  const seen = new Map<string, string>();
  for (const e of q("[data-tab-id]")) {
    const id = e.getAttribute("data-tab-id");
    if (!id || seen.has(id)) continue;
    const lines = ((e as HTMLElement).innerText || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^\d+$/.test(l));
    seen.set(id, [...new Set(lines)].join(" | ").slice(0, 48));
  }

  const out: Record<string, unknown> = {
    window: { w: window.innerWidth, h: window.innerHeight },
    sidebar: Math.round(
      document.querySelector("[data-testid=sidebar]")?.getBoundingClientRect().width ?? 0,
    ),
    tabs: [...seen].map(([id, label]) => ({ id: Number(id), label })),
    leaves: q("[data-pane-leaf]:not([data-pane-private])").map((e) => ({
      id: Number(e.getAttribute("data-pane-leaf")),
      kind: kindOf(e),
    })),
    focusLeaf:
      focusLeafEl && !focusLeafEl.hasAttribute("data-pane-private")
        ? Number(focusLeafEl.getAttribute("data-pane-leaf"))
        : null,
    focus: a ? a.tagName + (a.placeholder ? ` "${a.placeholder}"` : "") : null,
    dialog: modal
      ? `${modal.getAttribute("role")}: ${(modal.textContent || "").trim().slice(0, 60)}`
      : null,
    toasts: q("button").filter((b) =>
      /^dismiss$/i.test((b.getAttribute("aria-label") || b.textContent || "").trim()),
    ).length,
    // -1 when only one pane is open, which is the honest answer: there is no
    // splitter between panes to drag yet.
    paneHandle: paneHandle(),
  };

  // Opt-in. With Source Control open this is 60+ aria-labels, several hundred
  // tokens of the agent's context on a verb it is told to call constantly. It is
  // a DISCOVERY list - useful once, then never again.
  if (buttons) {
    out.buttons = [
      ...new Set(
        q("button[aria-label]").map((b) =>
          // Collapse the per-file controls: 'Stage src/app/App.tsx' and its 60
          // siblings are one control, and listing each buries the rest of the UI.
          (b.getAttribute("aria-label") ?? "").replace(/\s\S*[\\/]\S*$/, " <path>"),
        ),
      ),
    ].sort();
  }

  // Tails merged INTO the pane list rather than sitting in a list of their own:
  // one row per pane carrying both what the pane IS and what it last printed.
  try {
    const list = (await callBridge("terminals", [BUFFER_ROWS])) as TerminalRow[];
    const panes = (await callBridge("panes")) as Array<{ leafId: number }>;
    const tails = new Map(list.map((t) => [t.leafId, tail(t.text, tailLines)]));
    out.panes = panes.map((p) => (tails.has(p.leafId) ? { ...p, tail: tails.get(p.leafId) } : p));
  } catch (err) {
    // `panes` and `terminals` are registered from a React effect, so very early
    // in startup they genuinely are not there yet. Degrade rather than throw:
    // the DOM half above (the RENDERED layout) is exactly what is useful when
    // something is already wrong.
    out.panes = [];
    out.tediError = err instanceof Error ? err.message : String(err);
  }
  return out;
}

registerBridge({ state, text: domText, focusedLeaf, paneHandle });
