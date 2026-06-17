import { type EditorPaneHandle } from "@/modules/editor";
import { browserEmbedClose, browserEmbedHide } from "@/modules/browser";
import { type AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import { type SshStatus } from "@/modules/ssh/status";
import { type Tab } from "@/modules/tabs";
import { disposeSession, leaves, type TerminalPaneHandle } from "@/modules/terminal";
import type { SearchAddon } from "@xterm/addon-search";
import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";

type Params = {
  tabs: Tab[];
  liveTabsByWorkspace: RefObject<Map<string, { tabs: Tab[]; activeId: number | null }>>;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
  searchAddons: RefObject<Map<number, SearchAddon>>;
  detectedUrls: RefObject<Map<number, string>>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  setSshStatuses: Dispatch<SetStateAction<Map<number, SshStatus>>>;
  setAiCliStatuses: Dispatch<SetStateAction<Map<number, AiCliStatus>>>;
};

/**
 * Disposes PTY/xterm sessions by pane tree, not React lifecycle. Split and
 * unsplit remount components but the leaf is still live, so reconciling against
 * the live leaf set (current tabs + every cached workspace's tabs) is what
 * decides which sessions to tear down and which per-leaf maps to prune.
 *
 * Workspace switches flow through here too: when the active workspace changes,
 * `tabs` becomes the new workspace's tabs and the prior workspace's leaves
 * would look dead. Treating cached workspaces' leaves as live keeps their
 * sessions attached. Only a closed workspace (cache entry cleared) disposes its
 * sessions. The per-leaf maps + status setters live in App and are passed in;
 * effect moved verbatim with its `[tabs]` dependency.
 */
export function useSessionDisposal({
  tabs,
  liveTabsByWorkspace,
  terminalRefs,
  searchAddons,
  detectedUrls,
  editorRefs,
  setSshStatuses,
  setAiCliStatuses,
}: Params): void {
  const liveLeavesRef = useRef<Set<number>>(new Set());
  const liveBrowserRef = useRef<Set<number>>(new Set());
  // Inactive-workspace preview leaves whose always-on-top webview we've already
  // hidden, so the hide fires once per switch-away instead of on every `tabs`
  // change. Cleared when the leaf returns to the active workspace or closes.
  const hiddenInactiveBrowserRef = useRef<Set<number>>(new Set());
  useEffect(() => {
    const liveTerm = new Set<number>();
    const liveEditor = new Set<number>();
    const liveBrowser = new Set<number>();
    // Browser leaves whose `BrowserPane` is actually MOUNTED right now: only the
    // active workspace's tabs render. A browser leaf that's in `liveBrowser`
    // (kept alive across workspaces) but NOT here has an unmounted pane, so
    // nothing drives its webview's hide.
    const activeBrowser = new Set<number>();
    const collect = (t: Tab, mounted: boolean) => {
      if (t.kind !== "pane") return;
      for (const l of leaves(t.paneTree)) {
        if (l.leafKind === "terminal") liveTerm.add(l.id);
        else if (l.leafKind === "browser") {
          liveBrowser.add(l.id);
          if (mounted) activeBrowser.add(l.id);
        } else if (l.leafKind === "editor") liveEditor.add(l.id);
        // extension-panel leaves own their lifecycle via the React mount +
        // the extension's cleanup callback; nothing to dispose here.
      }
    };
    for (const t of tabs) collect(t, true);
    for (const cached of liveTabsByWorkspace.current.values()) {
      for (const t of cached.tabs) collect(t, false);
    }
    for (const id of liveLeavesRef.current) {
      if (!liveTerm.has(id)) disposeSession(id);
    }
    liveLeavesRef.current = liveTerm;
    // Close a preview's native webview only when its leaf is gone from ALL
    // workspaces (truly closed), mirroring terminal session disposal. Keying off
    // the cross-workspace union avoids destroying a preview just because its
    // workspace became inactive (which would then blank on return).
    for (const id of liveBrowserRef.current) {
      if (!liveBrowser.has(id)) {
        void browserEmbedClose(id).catch(() => {});
        hiddenInactiveBrowserRef.current.delete(id);
      }
    }
    liveBrowserRef.current = liveBrowser;
    // A preview alive in an INACTIVE workspace has an unmounted `BrowserPane`,
    // so its rAF hide loop is gone while the native webview (which composites
    // ABOVE the DOM) stays shown - floating over the now-active workspace. Hide
    // it (without destroying, so switching back doesn't reload). Switching back
    // remounts the pane, which re-shows + repositions via its rAF loop. The
    // latch makes this fire once per switch-away, not on every `tabs` change.
    for (const id of liveBrowser) {
      if (!activeBrowser.has(id)) {
        if (!hiddenInactiveBrowserRef.current.has(id)) {
          hiddenInactiveBrowserRef.current.add(id);
          void browserEmbedHide(id).catch(() => {});
        }
      } else {
        hiddenInactiveBrowserRef.current.delete(id);
      }
    }
    for (const k of [...terminalRefs.current.keys()])
      if (!liveTerm.has(k)) terminalRefs.current.delete(k);
    for (const k of [...searchAddons.current.keys()])
      if (!liveTerm.has(k)) searchAddons.current.delete(k);
    for (const k of [...detectedUrls.current.keys()])
      if (!liveTerm.has(k)) detectedUrls.current.delete(k);
    for (const k of [...editorRefs.current.keys()])
      if (!liveEditor.has(k)) editorRefs.current.delete(k);
    setSshStatuses((prev) => {
      let mutated = false;
      const next = new Map(prev);
      for (const k of next.keys()) {
        if (!liveTerm.has(k)) {
          next.delete(k);
          mutated = true;
        }
      }
      return mutated ? next : prev;
    });
    setAiCliStatuses((prev) => {
      let mutated = false;
      const next = new Map(prev);
      for (const k of next.keys()) {
        if (!liveTerm.has(k)) {
          next.delete(k);
          mutated = true;
        }
      }
      return mutated ? next : prev;
    });
  }, [tabs]);
}
