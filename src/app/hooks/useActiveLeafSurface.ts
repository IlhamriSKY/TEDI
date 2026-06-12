import { type EditorPaneHandle } from "@/modules/editor";
import { BROWSER_NAV_EVENT, type BrowserNavEvent } from "@/modules/browser";
import { type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal";
import { listen } from "@tauri-apps/api/event";
import type { SearchAddon } from "@xterm/addon-search";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { type TabsApi } from "./tabsApi";

function sameOrigin(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.host === ub.host && ua.protocol === ub.protocol;
  } catch {
    return a === b;
  }
}

type Params = {
  searchAddons: RefObject<Map<number, SearchAddon>>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  detectedUrls: RefObject<Map<number, string>>;
  activeId: number;
  activeLeafIdInTab: number | null;
  activeLeafKindCurrent: "terminal" | "editor" | "browser" | null;
  isTerminalLike: boolean;
  tabs: Tab[];
  setActiveSearchAddon: Dispatch<SetStateAction<SearchAddon | null>>;
  setActiveEditorHandle: Dispatch<SetStateAction<EditorPaneHandle | null>>;
} & Pick<TabsApi, "setBrowserLeafTitle">;

/**
 * Surfaces the active leaf's runtime handles to the chrome: on active leaf/tab
 * change it publishes the focused terminal's search addon + detected URL and
 * the focused editor's handle. Also owns the detected-URL state (consumed only
 * by `detectedBrowserUrl`) and keeps browser-pane titles in sync via
 * BROWSER_NAV_EVENT.
 *
 * `activeSearchAddon` / `activeEditorHandle` stay in App (read by the chrome
 * derivations and the editor bridge, and `activeEditorHandle` is also set by
 * `usePaneHandles`), so their setters are threaded in. The per-leaf maps live
 * in App too. Effects/handlers moved verbatim with identical dependency arrays.
 */
export function useActiveLeafSurface({
  searchAddons,
  editorRefs,
  detectedUrls,
  activeId,
  activeLeafIdInTab,
  activeLeafKindCurrent,
  isTerminalLike,
  tabs,
  setActiveSearchAddon,
  setActiveEditorHandle,
  setBrowserLeafTitle,
}: Params): {
  handleSearchReady: (leafId: number, addon: SearchAddon) => void;
  handleDetectedLocalUrl: (leafId: number, url: string) => void;
  detectedBrowserUrl: string | null;
} {
  const [activeDetectedUrl, setActiveDetectedUrl] = useState<string | null>(null);

  // On active leaf or tab change, surface its search addon, editor handle,
  // and detected URL to the chrome.
  useEffect(() => {
    setActiveSearchAddon(
      activeLeafIdInTab !== null && activeLeafKindCurrent === "terminal"
        ? (searchAddons.current.get(activeLeafIdInTab) ?? null)
        : null,
    );
    setActiveEditorHandle(
      activeLeafIdInTab !== null && activeLeafKindCurrent === "editor"
        ? (editorRefs.current.get(activeLeafIdInTab) ?? null)
        : null,
    );
    setActiveDetectedUrl(
      activeLeafIdInTab !== null && activeLeafKindCurrent === "terminal"
        ? (detectedUrls.current.get(activeLeafIdInTab) ?? null)
        : null,
    );
  }, [activeId, activeLeafIdInTab, activeLeafKindCurrent]);

  const handleDetectedLocalUrl = useCallback(
    (leafId: number, url: string) => {
      detectedUrls.current.set(leafId, url);
      if (leafId === activeLeafIdInTab) setActiveDetectedUrl(url);
    },
    [activeLeafIdInTab],
  );

  const detectedBrowserUrl = useMemo(() => {
    if (!isTerminalLike || !activeDetectedUrl) return null;
    const alreadyOpen = tabs.some(
      (t) =>
        t.kind === "pane" &&
        leaves(t.paneTree).some(
          (l) => l.leafKind === "browser" && sameOrigin(l.url, activeDetectedUrl),
        ),
    );
    return alreadyOpen ? null : activeDetectedUrl;
  }, [isTerminalLike, activeDetectedUrl, tabs]);

  // Browser panes report their live document.title via BROWSER_NAV_EVENT,
  // keyed by the browser leaf id. Apply it to the leaf so the tab/pane label
  // follows the page. (The URL side is handled inside BrowserPane via reconcile,
  // which must not re-navigate - so it's deliberately not touched here.)
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<BrowserNavEvent>(BROWSER_NAV_EVENT, (e) => {
      const p = e.payload;
      if (!p || p.kind !== "title" || typeof p.title !== "string") return;
      setBrowserLeafTitle(p.tabId, p.title);
    }).then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, [setBrowserLeafTitle]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: SearchAddon) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafIdInTab) setActiveSearchAddon(addon);
    },
    [activeLeafIdInTab],
  );

  return { handleSearchReady, handleDetectedLocalUrl, detectedBrowserUrl };
}
