import { registerBridge } from "@/modules/automation/bridge";

import { type EditorPaneHandle } from "@/modules/editor";
import { activeLeaf, type Tab } from "@/modules/tabs";
import {
  hasLeaf,
  leafIds,
  leaves,
  respawnSession,
  type PaneLeaf,
  type TerminalPaneHandle,
  type TediOpenInput,
  type TediSpawnTabInput,
} from "@/modules/terminal";
import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { isQuitting } from "./useQuitGuard";
import { type TabsApi } from "./tabsApi";

/**
 * How many ROWS to ask xterm for, always.
 *
 * `getBuffer(n)` returns the last n ROWS and strips the trailing blank ones, and
 * on a pane that has not scrolled those last rows ARE the blanks - so a narrow
 * read hands back "", which a change-detector reads as "nothing happened". Read
 * wide, trim after.
 */
const TERMINAL_BUFFER_ROWS = 200;

/** Last `n` lines of a buffer, trailing blank run trimmed. */
function tailLines(s: string, n: number): string {
  return s.trimEnd().split("\n").slice(-n).join("\n");
}

/** 32-bit FNV-1a. Small, stable, and enough to answer "did this change?". */
function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

type Params = {
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  tabsRef: RefObject<Tab[]>;
  activeLeafIdInTab: number | null;
  setActiveEditorHandle: Dispatch<SetStateAction<EditorPaneHandle | null>>;
  handleClose: (id: number) => void;
  requestCloseLeaf: (leafId: number) => void;
} & Pick<
  TabsApi,
  | "setLeafCwd"
  | "setLeafPtyId"
  | "focusPane"
  | "closePaneByLeaf"
  | "openFileTab"
  | "splitActivePane"
  | "newTab"
  | "setEditorLeafDirty"
>;

/**
 * The PaneStack wiring: handle registration plus the per-leaf lifecycle
 * callbacks (cwd / ptyId / focus / exit / dirty / close). Moved verbatim from
 * App with identical dependency arrays. `handleClose` is threaded in from
 * `useTabActions` because the editor/pane-header close paths share it.
 */
export function usePaneHandles({
  terminalRefs,
  editorRefs,
  tabsRef,
  activeLeafIdInTab,
  setActiveEditorHandle,
  setLeafCwd,
  setLeafPtyId,
  focusPane,
  closePaneByLeaf,
  openFileTab,
  splitActivePane,
  newTab,
  setEditorLeafDirty,
  handleClose,
  requestCloseLeaf,
}: Params): {
  registerTerminalHandle: (leafId: number, h: TerminalPaneHandle | null) => void;
  registerEditorHandle: (leafId: number, h: EditorPaneHandle | null) => void;
  handleTerminalCwd: (leafId: number, cwd: string) => void;
  handlePtyId: (leafId: number, ptyId: string) => void;
  handleFocusLeaf: (tabId: number, leafId: number) => void;
  handleLeafExit: (leafId: number, _code: number) => void;
  handleTediOpen: (_leafId: number, input: TediOpenInput) => void;
  handleTediSpawnTab: (_leafId: number, input: TediSpawnTabInput) => void;
  handleEditorDirty: (leafId: number, dirty: boolean) => void;
  handleEditorCloseLeaf: (leafId: number) => void;
  handlePaneHeaderClose: (leafId: number) => void;
} {
  const registerTerminalHandle = useCallback((leafId: number, h: TerminalPaneHandle | null) => {
    if (h) terminalRefs.current.set(leafId, h);
    else terminalRefs.current.delete(leafId);
  }, []);

  // The automation surface for a driving agent (`scripts/mcp/`, and the MCP
  // server Claude Code talks to). Gated on `TEDI_DEBUG_PORT` like the rest of
  // `window.__tedi` (see `shortcuts/lib/commandRegistry.ts`).
  //
  // These handles are the driver's only way to SEE a pane. xterm renders to a
  // WebGL canvas, so nothing in the DOM carries terminal text; CodeMirror
  // virtualises, so scraping `.cm-content` returns only the rendered window of a
  // long file and quietly looks like the whole thing. Both already know how to
  // read themselves, so this exposes what exists rather than reimplementing it.
  //
  // PRIVATE LEAVES ARE INVISIBLE HERE. Marking a pane private means "the AI never
  // learns of its existence, cwd or scrollback" (`terminal/lib/panes.ts`), which
  // `app/lib/terminalSnapshot.ts` already enforces for TEDI's built-in agent. An
  // agent driving from outside is no different, so every read AND write below
  // goes through `publicLeaves()` first.
  //
  // `termWrite` goes straight to the PTY: whole, instant, and immune to the
  // first-keystroke loss a freshly focused terminal inflicts on synthetic key
  // events. It deliberately bypasses xterm's `onData`, so the AI-CLI detector
  // never fires - drive that path with real keys instead (`d.command()`).
  useEffect(() => {
    /**
     * Every non-private leaf in EVERY tab, read from the live tab tree.
     *
     * Not from the DOM: a background tab's panes are just as real as the focused
     * one's, and only the model knows a pane's cwd, url, ssh host, owning
     * extension or running agent. This is what lets a driver find the pane a
     * build is running in without switching tabs to look.
     */
    const publicLeaves = (): {
      tabId: number;
      tabTitle: string;
      leaf: PaneLeaf;
      active: boolean;
    }[] =>
      tabsRef.current.flatMap((t) =>
        t.kind === "pane"
          ? leaves(t.paneTree)
              .filter((l) => !l.private)
              .map((l) => ({
                tabId: t.id,
                tabTitle: t.title,
                leaf: l,
                active: t.activeLeafId === l.id,
              }))
          : [],
      );
    const isPublic = (leafId: number): boolean => publicLeaves().some((p) => p.leaf.id === leafId);

    /** What distinguishes this pane from another of the same kind. */
    const identity = (leaf: PaneLeaf): Record<string, unknown> => {
      switch (leaf.leafKind) {
        case "terminal":
          return {
            ordinal: leaf.terminalOrdinal,
            cwd: leaf.cwd,
            ssh: leaf.sshConnectionId,
            // Which AI CLI is running in this pane, if any. Survives a reattach,
            // so it answers "is one of my siblings already working here?".
            agent: leaf.activeTool,
            atPrompt: terminalRefs.current.get(leaf.id)?.isAtPrompt(),
            running: terminalRefs.current.get(leaf.id)?.isProcessRunning(),
          };
        case "editor":
          return { path: leaf.path, dirty: leaf.dirty, ssh: leaf.sshHostLabel };
        case "browser":
          return { url: leaf.url, pageTitle: leaf.title };
        case "extension-panel":
          return { extensionId: leaf.extensionId, panelId: leaf.panelId, state: leaf.state };
        case "ai":
          // Which conversation this pane is a view onto. Without it an agent can
          // see that an AI pane exists but not which session it holds, so it
          // cannot line the pane up against `ai read`/`ai status`, which are
          // addressed BY session id.
          return { sessionId: leaf.sessionId };
        // `board` and `scm` genuinely carry no state - they rebuild from the
        // live tab tree and the workspace root - so `{}` is the honest answer
        // for them, not a gap.
        default:
          return {};
      }
    };

    registerBridge({
      panes: () =>
        publicLeaves().map(({ tabId, tabTitle, leaf, active }) => ({
          tabId,
          tabTitle,
          leafId: leaf.id,
          kind: leaf.leafKind,
          active,
          name: leaf.customTitle,
          ...identity(leaf),
        })),
      terminals: (maxLines = 200) =>
        [...terminalRefs.current.entries()]
          .filter(([leafId]) => isPublic(leafId))
          .map(([leafId, h]) => ({
            leafId,
            atPrompt: h.isAtPrompt(),
            running: h.isProcessRunning(),
            text: h.getBuffer(maxLines) ?? "",
          })),
      termWrite: (leafId: number, data: string) => {
        const h = isPublic(leafId) ? terminalRefs.current.get(leafId) : undefined;
        if (!h) return false;
        h.write(data);
        return true;
      },
      focusLeaf: (leafId: number) => {
        if (!isPublic(leafId)) return false;
        const h = terminalRefs.current.get(leafId) ?? editorRefs.current.get(leafId);
        if (!h) return false;
        h.focus();
        return true;
      },
      /**
       * Focus a pane and CONFIRM the keystrokes will land there.
       *
       * `focusLeaf` alone answers "the handle existed", which is not the same
       * claim: a handle exists for panes in BACKGROUND tabs too, and `.focus()`
       * on a hidden element does nothing. Verifying against the DOM is what makes
       * the answer mean what `focus_pane` promises, and it is why that tool could
       * not simply be bridged as-is.
       *
       * The `isPublic` gate is spelled out here rather than delegated. Every
       * capability that touches a leaf must carry it IN ITS OWN BODY -
       * `driver-verify` checks that structurally, because the regression that
       * actually happens is a new accessor written without the filter, and a
       * check that followed delegation could not see one.
       */
      focusPaneVerified: (leafId: number) => {
        if (!isPublic(leafId)) return false;
        const h = terminalRefs.current.get(leafId) ?? editorRefs.current.get(leafId);
        if (!h) return false;
        h.focus();
        const el = document.activeElement?.closest("[data-pane-leaf]:not([data-pane-private])");
        return el ? Number(el.getAttribute("data-pane-leaf")) === leafId : false;
      },
      /**
       * Every terminal's flags plus the LAST `lines` lines.
       *
       * REDUCED HERE, and that is the point. Every text read must ask xterm for
       * `TERMINAL_BUFFER_ROWS` rows (asking for fewer returns "" on a pane that
       * has not scrolled), so a caller that trims on its own side ships the whole
       * ~20 KB buffer of every open pane across the transport just to keep three
       * lines. `sh` and `wait_for_terminal` poll this several times a second.
       */
      termTails: (lines = 200) =>
        [...terminalRefs.current.entries()]
          .filter(([leafId]) => isPublic(leafId))
          .map(([leafId, h]) => ({
            leafId,
            atPrompt: h.isAtPrompt(),
            running: h.isProcessRunning(),
            text: tailLines(h.getBuffer(TERMINAL_BUFFER_ROWS) ?? "", lines),
          })),
      /**
       * The poll projection for `sh` and `wait_for_terminal`: flags, optionally
       * a 32-bit FNV-1a of each buffer, and optionally whether `needle` appears.
       *
       * BOTH REDUCTIONS HAPPEN HERE, which is the point. `sh` only needs to know
       * whether a buffer CHANGED and `wait_for_terminal` only whether a string
       * APPEARED; answering either on the far side means shipping every open
       * pane's ~20 KB scrollback across the transport several times a second.
       *
       * `wantHash` exists so the commonest poll of all - waiting for a prompt -
       * touches no buffer at all. It reads two booleans that do not come from
       * the buffer, so building one (and hashing it) several times a second, per
       * pane, for the life of the command, is pure work on the UI thread.
       */
      termProbe: (
        needle: string | null = null,
        wantHash = true,
        onlyLeafId: number | null = null,
      ) =>
        [...terminalRefs.current.entries()]
          .filter(([leafId]) => isPublic(leafId))
          .map(([leafId, h]) => {
            // `onlyLeafId` scopes the EXPENSIVE half. The flags are cheap and the
            // caller still needs every pane's (it picks a target from this list),
            // but building and hashing a 200-row buffer is not - and `sh` polls
            // this ~7x a second for the life of a command while watching exactly
            // one pane. Without the scope the reduction merely moved that cost
            // off the socket and onto the UI thread, for every open terminal.
            const wantsText = onlyLeafId === null || onlyLeafId === leafId;
            const text =
              wantsText && (needle || wantHash) ? (h.getBuffer(TERMINAL_BUFFER_ROWS) ?? "") : "";
            return {
              leafId,
              atPrompt: h.isAtPrompt(),
              running: h.isProcessRunning(),
              hash: wantHash && wantsText ? fnv1a(text) : 0,
              hit: needle && wantsText ? text.includes(needle) : false,
            };
          }),
      // `maxChars` because a driver reading a 20k-line file into a tool result
      // helps nobody; it has the file on disk. This is for seeing the LIVE,
      // possibly unsaved buffer, which is the part disk cannot answer.
      editors: (maxChars = 20000) =>
        [...editorRefs.current.entries()]
          .filter(([leafId]) => isPublic(leafId))
          .map(([leafId, h]) => {
            const content = h.getContent() ?? "";
            return {
              leafId,
              path: h.getPath(),
              truncated: content.length > maxChars,
              text: content.slice(0, maxChars),
            };
          }),
      editorSave: (leafId: number) => {
        const h = isPublic(leafId) ? editorRefs.current.get(leafId) : undefined;
        if (!h) return false;
        void h.save();
        return true;
      },
    });
  }, []);

  const registerEditorHandle = useCallback(
    (leafId: number, h: EditorPaneHandle | null) => {
      if (h) editorRefs.current.set(leafId, h);
      else editorRefs.current.delete(leafId);
      if (leafId === activeLeafIdInTab) setActiveEditorHandle(h);
    },
    [activeLeafIdInTab],
  );

  const handleTerminalCwd = useCallback(
    (leafId: number, cwd: string) => setLeafCwd(leafId, cwd),
    [setLeafCwd],
  );

  // Fires once whenever a terminal leaf acquires a daemon-side PTY UUID.
  // Stamping it onto the leaf lets the workspace serializer persist it
  // so the next launch can `pty_attach` instead of spawning fresh.
  const handlePtyId = useCallback(
    (leafId: number, ptyId: string) => setLeafPtyId(leafId, ptyId),
    [setLeafPtyId],
  );

  const handleFocusLeaf = useCallback(
    (tabId: number, leafId: number) => focusPane(tabId, leafId),
    [focusPane],
  );

  const handleLeafExit = useCallback(
    (leafId: number, _code: number) => {
      // Quitting: the shells are being killed on purpose (force quit), so every
      // Exit here is our own doing. Reshaping the layout now would persist a
      // torn-down workspace over the user's real one - and the last-terminal
      // branch below would spawn a FRESH shell that then outlives the GUI,
      // which is the exact opposite of "close all terminals".
      if (isQuitting()) return;
      const all = tabsRef.current;
      const tab = all.find((t) => t.kind === "pane" && hasLeaf(t.paneTree, leafId));
      if (!tab || tab.kind !== "pane") return;
      const terminalLeafCount = (() => {
        let n = 0;
        for (const t of all) {
          if (t.kind !== "pane") continue;
          for (const l of leaves(t.paneTree)) if (l.leafKind === "terminal") n++;
        }
        return n;
      })();
      // Respawn if this is the only terminal leaf left, so the UI isn't
      // empty.
      const targetLeaf = leaves(tab.paneTree).find((l) => l.id === leafId);
      const cwd = targetLeaf?.leafKind === "terminal" ? targetLeaf.cwd : undefined;
      if (terminalLeafCount === 1 && leafIds(tab.paneTree).length === 1) {
        void respawnSession(leafId, cwd);
      } else {
        closePaneByLeaf(leafId);
      }
    },
    [closePaneByLeaf],
  );

  const handleTediOpen = useCallback(
    (_leafId: number, input: TediOpenInput) => {
      openFileTab(input.file);
    },
    [openFileTab],
  );

  // OSC 8889: shell asks TEDI to open a new terminal tab at `cwd` and run
  // `cmd`. Used by tools like Laravel's `php artisan dev:serve` to keep
  // dev processes inside TEDI instead of spawning cmd.exe windows.
  //
  // If `split` is set, splits the last spawned pane in the same tab
  // instead of opening a new tab. Lets `dev:serve` cluster
  // Vite/Reverb/Queue into one tab with horizontal splits.
  const lastSpawnedTabIdRef = useRef<number | null>(null);
  const handleTediSpawnTab = useCallback(
    (_leafId: number, input: TediSpawnTabInput) => {
      const cwd = input.cwd;
      const cmd = input.cmd;

      const writeIntoLeaf = (leafId: number) => {
        if (!cmd) return;
        setTimeout(() => {
          const t = terminalRefs.current.get(leafId);
          if (!t) return;
          t.write(`${cmd}\r`);
          t.focus();
        }, 120);
      };

      // Split path requires a previous spawned tab still alive.
      if (input.split) {
        const lastTabId = lastSpawnedTabIdRef.current;
        const lastTab = lastTabId !== null ? tabsRef.current.find((x) => x.id === lastTabId) : null;
        if (lastTab && lastTab.kind === "pane") {
          const newLeafId = splitActivePane(lastTabId!, input.split);
          if (newLeafId !== null) {
            writeIntoLeaf(newLeafId);
            return;
          }
          // Split refused (e.g. MAX_PANES_PER_TAB). Fall through to new tab.
        }
      }

      const tabId = newTab(cwd);
      lastSpawnedTabIdRef.current = tabId;
      if (!cmd) return;
      // Wait for the new PTY to be ready before injecting the command.
      setTimeout(() => {
        const tab = tabsRef.current.find((x) => x.id === tabId);
        if (!tab || tab.kind !== "pane") return;
        const leaf = activeLeaf(tab);
        if (!leaf || leaf.leafKind !== "terminal") return;
        const t = terminalRefs.current.get(leaf.id);
        if (!t) return;
        t.write(`${cmd}\r`);
        t.focus();
      }, 120);
    },
    [newTab, splitActivePane],
  );

  const handleEditorDirty = useCallback(
    (leafId: number, dirty: boolean) => setEditorLeafDirty(leafId, dirty),
    [setEditorLeafDirty],
  );

  const handleEditorCloseLeaf = useCallback(
    (leafId: number) => {
      // `:q` in a split pane should close only that pane.
      const tab = tabsRef.current.find((t) => t.kind === "pane" && hasLeaf(t.paneTree, leafId));
      if (!tab || tab.kind !== "pane") return;
      if (leafIds(tab.paneTree).length > 1) {
        closePaneByLeaf(leafId);
      } else {
        handleClose(tab.id);
      }
    },
    [closePaneByLeaf, handleClose],
  );

  // Pane header close button: drop the leaf when it shares a tab, otherwise
  // close the whole tab (mirrors the tab-strip leaf close semantics). Both
  // routes confirm first when a terminal is running a process.
  const handlePaneHeaderClose = useCallback(
    (leafId: number) => {
      const tab = tabsRef.current.find((t) => t.kind === "pane" && hasLeaf(t.paneTree, leafId));
      if (!tab || tab.kind !== "pane") return;
      if (leafIds(tab.paneTree).length > 1) {
        requestCloseLeaf(leafId);
      } else {
        handleClose(tab.id);
      }
    },
    [requestCloseLeaf, handleClose],
  );

  return {
    registerTerminalHandle,
    registerEditorHandle,
    handleTerminalCwd,
    handlePtyId,
    handleFocusLeaf,
    handleLeafExit,
    handleTediOpen,
    handleTediSpawnTab,
    handleEditorDirty,
    handleEditorCloseLeaf,
    handlePaneHeaderClose,
  };
}
