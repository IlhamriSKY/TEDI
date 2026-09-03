import { type EditorPaneHandle } from "@/modules/editor";
import { type Tab } from "@/modules/tabs";
import { leaves } from "@/modules/terminal";
import { useLiveUrl } from "./useProjectUrl";
import type { SearchAddon } from "@xterm/addon-search";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";

type Params = {
  searchAddons: RefObject<Map<number, SearchAddon>>;
  editorRefs: RefObject<Map<number, EditorPaneHandle>>;
  detectedUrls: RefObject<Map<number, string>>;
  activeId: number;
  activeLeafIdInTab: number | null;
  activeLeafKindCurrent: "terminal" | "editor" | null;
  tabs: Tab[];
  setActiveSearchAddon: Dispatch<SetStateAction<SearchAddon | null>>;
  setActiveEditorHandle: Dispatch<SetStateAction<EditorPaneHandle | null>>;
  /** Preference: open the project's url by itself once it is found running. */
  autoOpenProjectUrl: boolean;
  openPreviewTab: (url: string) => void;
};

/**
 * Surfaces the active leaf's runtime handles to the chrome: on active leaf/tab
 * change it publishes the focused terminal's search addon + detected URL and
 * the focused editor's handle. Also owns the detected-URL state that
 * `detectedBrowserUrl` reduces to the one live address worth offering.
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
  tabs,
  setActiveSearchAddon,
  setActiveEditorHandle,
  autoOpenProjectUrl,
  openPreviewTab,
}: Params): {
  handleSearchReady: (leafId: number, addon: SearchAddon) => void;
  handleDetectedLocalUrl: (leafId: number, url: string) => void;
  handleProjectUrl: (url: string | null) => void;
  detectedBrowserUrl: string | null;
  previewLeafId: number | null;
} {
  const [activeDetectedUrl, setActiveDetectedUrl] = useState<string | null>(null);
  // The open project's own url, resolved from its config by `useProjectUrl`.
  // Reported whether or not it answers - `useLiveUrl` below owns liveness for
  // every source alike. Not per-leaf: it belongs to the workspace, not to
  // whichever terminal happens to be focused.
  const [projectUrl, setProjectUrl] = useState<string | null>(null);

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

  // The newest url printed by *any* terminal, kept so the globe rides detection
  // rather than focus: moving to an editor pane, or to a second terminal that
  // printed nothing, must not hide a server that is still running. State, not
  // the `detectedUrls` ref, because a non-active leaf's detection has to
  // re-render. The leaf id travels with it so a closed leaf drops its url.
  const [lastDetected, setLastDetected] = useState<{ leafId: number; url: string } | null>(null);

  const handleDetectedLocalUrl = useCallback(
    (leafId: number, url: string) => {
      detectedUrls.current.set(leafId, url);
      setLastDetected({ leafId, url });
      if (leafId === activeLeafIdInTab) setActiveDetectedUrl(url);
    },
    [activeLeafIdInTab],
  );

  // Every url worth offering, best first. A LIST rather than one winner,
  // because the sources go stale independently: a stopped `npm run dev` still
  // holds the top slot with :5173, and collapsing early would hide a Laragon
  // vhost that is up and answering. `useLiveUrl` walks this until one replies.
  const previewCandidates = useMemo(() => {
    // A url the focused terminal printed wins over one another leaf printed,
    // which in turn wins over the project's declared one: the focused pane is
    // what the user is looking at right now, and on an SSH leaf it is the
    // tunnelled address, which the config could not have known.
    const fromAnyLeaf =
      lastDetected &&
      tabs.some(
        (t) => t.kind === "pane" && leaves(t.paneTree).some((l) => l.id === lastDetected.leafId),
      )
        ? lastDetected.url
        : null;
    // Not filtered against what is already open: the pages live in the browser
    // extension's own tabs, which core cannot see. Offering a url the user
    // already has open costs one redundant click; suppressing a url whose tab
    // core merely failed to notice would cost them the feature.
    const ordered = [activeDetectedUrl, fromAnyLeaf, projectUrl].filter((u): u is string => !!u);
    return [...new Set(ordered)];
  }, [activeDetectedUrl, lastDetected, projectUrl, tabs]);

  // Only ever the url of a port that is actually answering, so the pill stops
  // offering a dev server the user has since stopped.
  const detectedBrowserUrl = useLiveUrl(previewCandidates);

  // Which pane header carries the globe. It is the leaf that actually PRINTED
  // the url, not whichever pane happens to be focused, so clicking around a
  // split leaves the offer sitting on the terminal that owns it instead of
  // hopping from header to header. Still exactly one globe, because leaf ids are
  // unique. Falls back to the active leaf for the two cases that belong to no
  // pane in view: the project's declared url, and a terminal that printed in
  // ANOTHER tab (the offer should follow the user there rather than vanish).
  const previewLeafId = useMemo(() => {
    if (!detectedBrowserUrl) return null;
    const owner =
      activeDetectedUrl === detectedBrowserUrl
        ? activeLeafIdInTab
        : lastDetected?.url === detectedBrowserUrl
          ? lastDetected.leafId
          : null;
    const activeTab = tabs.find((t) => t.id === activeId);
    const inActiveTab =
      owner !== null &&
      activeTab?.kind === "pane" &&
      leaves(activeTab.paneTree).some((l) => l.id === owner);
    return inActiveTab ? owner : activeLeafIdInTab;
  }, [detectedBrowserUrl, activeDetectedUrl, lastDetected, activeLeafIdInTab, tabs, activeId]);

  // Fires for either source: the project's declared url AND one a terminal
  // printed, so `php artisan serve` / `npm run dev` opens the browser the same
  // way an already-running server does.
  //
  // The ref is what stops the effect from reopening a page the user closed:
  // the detected url stays non-null for as long as the server answers, so
  // without it every close would be undone on the next render. Remembering what
  // has been opened means each url opens at most once per session.
  const autoOpened = useRef<Set<string>>(undefined!);
  if (!autoOpened.current) autoOpened.current = new Set();
  useEffect(() => {
    if (!autoOpenProjectUrl || !detectedBrowserUrl) return;
    if (autoOpened.current.has(detectedBrowserUrl)) return;
    autoOpened.current.add(detectedBrowserUrl);
    // Not activated: loaded and waiting, without yanking focus off the terminal
    // mid-command.
    openPreviewTab(detectedBrowserUrl);
  }, [autoOpenProjectUrl, detectedBrowserUrl, openPreviewTab]);

  const handleSearchReady = useCallback(
    (leafId: number, addon: SearchAddon) => {
      searchAddons.current.set(leafId, addon);
      if (leafId === activeLeafIdInTab) setActiveSearchAddon(addon);
    },
    [activeLeafIdInTab],
  );

  return {
    handleSearchReady,
    handleDetectedLocalUrl,
    handleProjectUrl: setProjectUrl,
    detectedBrowserUrl,
    previewLeafId,
  };
}
