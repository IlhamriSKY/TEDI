import { type EditorPaneHandle } from "@/modules/editor";
import { useChatStore } from "@/modules/ai";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import { activeLeaf, type Tab } from "@/modules/tabs";
import { type TerminalPaneHandle } from "@/modules/terminal";
import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

type Params = {
  tabs: Tab[];
  activeId: number;
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  hasComposer: boolean;
  activeLeafKindCurrent: "terminal" | "editor" | "preview" | null;
};

/**
 * The "Ask AI about this selection" flow: selection capture from the active
 * terminal/editor leaf, the floating ask popup anchored to the selection rect,
 * and the AI-panel toggle / file-attach helpers that share the
 * no-composer-opens-Settings behavior. Moved verbatim from App with identical
 * dependency arrays; chat-store actions are read here directly. `hasComposer`
 * and `activeLeafKindCurrent` are threaded in from App.
 */
export function useSelectionAskAi({
  tabs,
  activeId,
  terminalRefs,
  editorRefs,
  hasComposer,
  activeLeafKindCurrent,
}: Params): {
  askPopup: { x: number; y: number } | null;
  setAskPopup: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  onAskFromSelection: () => void;
  askFromSelection: () => void;
  handleAttachFileToAgent: (path: string) => void;
  togglePanelAndFocus: () => void;
} {
  const openPanel = useChatStore((s) => s.openPanel);
  const focusInput = useChatStore((s) => s.focusInput);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const attachSelection = useChatStore((s) => s.attachSelection);

  const captureActiveSelection = useCallback((): string | null => {
    const t = tabs.find((x) => x.id === activeId);
    if (!t || t.kind !== "pane") return null;
    const leaf = activeLeaf(t);
    if (!leaf) return null;
    // Private leaves never expose their selection to the AI. Returning
    // null here suppresses the Ask-AI popup and short-circuits attachSelection.
    if (leaf.private) return null;
    if (leaf.leafKind === "terminal") {
      return terminalRefs.current.get(leaf.id)?.getSelection() ?? null;
    }
    return editorRefs.current.get(leaf.id)?.getSelection() ?? null;
  }, [tabs, activeId]);

  const togglePanelAndFocus = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    if (panelOpen) {
      useChatStore.getState().closePanel();
    } else {
      openPanel();
      focusInput(null);
    }
  }, [hasComposer, panelOpen, openPanel, focusInput]);

  const handleAttachFileToAgent = useCallback(
    (path: string) => {
      if (!hasComposer) {
        void openSettingsWindow("models");
        return;
      }
      window.dispatchEvent(new CustomEvent<string>("tedi:ai-attach-file", { detail: path }));
      openPanel();
      focusInput(null);
    },
    [hasComposer, openPanel, focusInput],
  );

  const askFromSelection = useCallback(() => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    const selection = captureActiveSelection();
    if (!selection || !selection.trim()) {
      focusInput(null);
      return;
    }
    const source: "terminal" | "editor" =
      activeLeafKindCurrent === "editor" ? "editor" : "terminal";
    attachSelection(selection, source);
  }, [hasComposer, captureActiveSelection, focusInput, attachSelection, activeLeafKindCurrent]);

  const [askPopup, setAskPopup] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const isInsideAi = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      return !!(
        el.closest("[data-selection-ask-ai]") ||
        el.closest("[data-ai-input-bar]") ||
        el.closest("[data-ai-mini-window]")
      );
    };

    const paneLeafFor = (t: EventTarget | null): HTMLElement | null => {
      const el = t as HTMLElement | null;
      return el?.closest<HTMLElement>("[data-pane-leaf]") ?? null;
    };

    // Anchor the popup to the selection rect when possible so it sits above
    // the highlighted text, not the mouse. Falls back to the mouseup point
    // for terminals where the DOM selection API doesn't expose xterm's
    // selection.
    const anchorFromSelection = (
      pane: HTMLElement,
      fallbackX: number,
      fallbackY: number,
    ): { x: number; y: number } => {
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            return { x: rect.left + rect.width / 2, y: rect.top };
          }
        }
        const xtermSel = pane.querySelector<HTMLElement>(
          ".xterm-selection > div, .xterm-selection-layer canvas",
        );
        if (xtermSel) {
          const rect = xtermSel.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return { x: rect.left + rect.width / 2, y: rect.top };
          }
        }
      } catch {
        // Fall through to mouse coords.
      }
      return { x: fallbackX, y: fallbackY };
    };

    const onDown = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      setAskPopup(null);
    };
    const onUp = (e: MouseEvent) => {
      if (isInsideAi(e.target)) return;
      // Only handle mouseups inside a terminal/editor pane. A stale xterm
      // selection could otherwise pop the button in the status bar,
      // sidebar, or tab strip.
      const pane = paneLeafFor(e.target);
      if (!pane) {
        setAskPopup(null);
        return;
      }
      setTimeout(() => {
        const text = captureActiveSelection();
        if (text && text.trim().length > 0) {
          const { x, y } = anchorFromSelection(pane, e.clientX, e.clientY);
          setAskPopup({ x, y });
        } else {
          setAskPopup(null);
        }
      }, 0);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [captureActiveSelection]);

  const onAskFromSelection = useCallback(() => {
    askFromSelection();
    setAskPopup(null);
  }, [askFromSelection]);

  return {
    askPopup,
    setAskPopup,
    onAskFromSelection,
    askFromSelection,
    handleAttachFileToAgent,
    togglePanelAndFocus,
  };
}
