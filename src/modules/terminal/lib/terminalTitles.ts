import { create } from "zustand";
import { isSpinnerLeadChar } from "./aiCliDetector";

/**
 * Strip a leading agent status glyph from a window title. Running agents
 * (Claude Code, Codex, …) prefix the OSC 0/2 title with a cycling spark/spinner
 * glyph (e.g. "✳ Investigate double dots"), which looks like a stray dot next to
 * the folder name in the Workspaces panel. We drop that leading glyph (plus any
 * whitespace / variation selectors around it) so the title reads as plain task
 * text. Reuses the detector's curated spinner alphabet, which already excludes
 * the middle-dot `·` used as a path separator, so real titles stay intact.
 */
function stripLeadingStatusGlyph(s: string): string {
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    const code = s.charCodeAt(i);
    const isVarSelector = code >= 0xfe00 && code <= 0xfe0f;
    if (ch === " " || ch === "\t" || isVarSelector || isSpinnerLeadChar(ch)) {
      i++;
      continue;
    }
    break;
  }
  return s.slice(i);
}

/**
 * Per-leaf terminal title, taken from the program's OSC 0/2 window-title escape
 * (captured via xterm `onTitleChange`). A running agent (Claude Code, Codex, …)
 * or a TUI (vim, lazygit, …) sets this; TEDI surfaces it next to the folder name
 * in the Workspaces panel's terminal list. Keyed by pane-leaf id.
 *
 * Reactive store rather than the `onAiCliStatus` callback chain: the only
 * consumer is the sidebar, so a small module-scoped store avoids prop-drilling
 * a title callback through TerminalPane → PaneStack → PaneTreeView → App.
 * Written by `useTerminalSession`; the entry is cleared on session disposal.
 */
type TerminalTitlesState = {
  titles: Record<number, string>;
  setTitle: (leafId: number, title: string) => void;
  clearTitle: (leafId: number) => void;
};

export const useTerminalTitles = create<TerminalTitlesState>((set) => ({
  titles: {},
  setTitle: (leafId, raw) => {
    const title = stripLeadingStatusGlyph(raw.trim());
    set((s) => {
      // Empty title clears the entry (a program can reset OSC 2 to "").
      if (!title) {
        if (!(leafId in s.titles)) return s;
        const next = { ...s.titles };
        delete next[leafId];
        return { titles: next };
      }
      if (s.titles[leafId] === title) return s;
      return { titles: { ...s.titles, [leafId]: title } };
    });
  },
  clearTitle: (leafId) =>
    set((s) => {
      if (!(leafId in s.titles)) return s;
      const next = { ...s.titles };
      delete next[leafId];
      return { titles: next };
    }),
}));
