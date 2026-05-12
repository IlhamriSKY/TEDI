import type { EditorPaneHandle } from "@/modules/editor";
import type { PaneTab, Tab } from "@/modules/tabs";
import { leafIds } from "@/modules/terminal/lib/panes";
import type { TerminalPaneHandle } from "@/modules/terminal";
import type {
  TeraxOpenInput,
  TeraxSpawnTabInput,
} from "@/modules/terminal/lib/useTerminalSession";
import type { SearchAddon } from "@xterm/addon-search";
import { useEffect, useRef } from "react";
import { PaneTreeView, type LeafBundle } from "./PaneTreeView";

type Props = {
  tabs: Tab[];
  activeId: number;
  // Terminal leaf callbacks
  registerTerminalHandle: (
    leafId: number,
    handle: TerminalPaneHandle | null,
  ) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onDetectedLocalUrl: (leafId: number, url: string) => void;
  onExit: (leafId: number, code: number) => void;
  onTeraxOpen?: (leafId: number, input: TeraxOpenInput) => void;
  onTeraxSpawnTab?: (leafId: number, input: TeraxSpawnTabInput) => void;
  // Editor leaf callbacks
  registerEditorHandle: (
    leafId: number,
    handle: EditorPaneHandle | null,
  ) => void;
  onDirtyChange: (leafId: number, dirty: boolean) => void;
  onCloseLeaf: (leafId: number) => void;
  // Shared
  onFocusLeaf: (tabId: number, leafId: number) => void;
};

export function PaneStack({
  tabs,
  activeId,
  registerTerminalHandle,
  onSearchReady,
  onCwd,
  onDetectedLocalUrl,
  onExit,
  onTeraxOpen,
  onTeraxSpawnTab,
  registerEditorHandle,
  onDirtyChange,
  onCloseLeaf,
  onFocusLeaf,
}: Props) {
  const paneTabs = tabs.filter((t): t is PaneTab => t.kind === "pane");

  // Stable refs for all per-leaf callbacks — avoid re-creating bundles each
  // render which would tear down PTY/editor state.
  const registerTerminalRef = useRef(registerTerminalHandle);
  const searchReadyRef = useRef(onSearchReady);
  const cwdRef = useRef(onCwd);
  const detectedUrlRef = useRef(onDetectedLocalUrl);
  const exitRef = useRef(onExit);
  const teraxOpenRef = useRef(onTeraxOpen);
  const teraxSpawnTabRef = useRef(onTeraxSpawnTab);
  const registerEditorRef = useRef(registerEditorHandle);
  const dirtyChangeRef = useRef(onDirtyChange);
  const closeLeafRef = useRef(onCloseLeaf);
  useEffect(() => {
    registerTerminalRef.current = registerTerminalHandle;
  }, [registerTerminalHandle]);
  useEffect(() => {
    searchReadyRef.current = onSearchReady;
  }, [onSearchReady]);
  useEffect(() => {
    cwdRef.current = onCwd;
  }, [onCwd]);
  useEffect(() => {
    detectedUrlRef.current = onDetectedLocalUrl;
  }, [onDetectedLocalUrl]);
  useEffect(() => {
    exitRef.current = onExit;
  }, [onExit]);
  useEffect(() => {
    teraxOpenRef.current = onTeraxOpen;
  }, [onTeraxOpen]);
  useEffect(() => {
    teraxSpawnTabRef.current = onTeraxSpawnTab;
  }, [onTeraxSpawnTab]);
  useEffect(() => {
    registerEditorRef.current = registerEditorHandle;
  }, [registerEditorHandle]);
  useEffect(() => {
    dirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    closeLeafRef.current = onCloseLeaf;
  }, [onCloseLeaf]);

  const bundles = useRef(new Map<number, LeafBundle>());
  const getBundle = (leafId: number): LeafBundle => {
    let b = bundles.current.get(leafId);
    if (!b) {
      b = {
        setTerminalRef: (h) => registerTerminalRef.current(leafId, h),
        onSearchReady: (addon) => searchReadyRef.current(leafId, addon),
        onCwd: (cwd) => cwdRef.current(leafId, cwd),
        onDetectedLocalUrl: (url) => detectedUrlRef.current(leafId, url),
        onExit: (code) => exitRef.current(leafId, code),
        onTeraxOpen: (input) => teraxOpenRef.current?.(leafId, input),
        onTeraxSpawnTab: (input) => teraxSpawnTabRef.current?.(leafId, input),
        setEditorRef: (h) => registerEditorRef.current(leafId, h),
        onDirtyChange: (dirty) => dirtyChangeRef.current(leafId, dirty),
        onCloseLeaf: () => closeLeafRef.current(leafId),
      };
      bundles.current.set(leafId, b);
    }
    return b;
  };

  useEffect(() => {
    const live = new Set<number>();
    for (const t of paneTabs) for (const id of leafIds(t.paneTree)) live.add(id);
    for (const id of bundles.current.keys()) {
      if (!live.has(id)) bundles.current.delete(id);
    }
  }, [paneTabs]);

  return (
    <div className="relative h-full w-full">
      {paneTabs.map((t) => {
        const tabVisible = t.id === activeId;
        return (
          <div key={t.id} className="absolute inset-0">
            <PaneTreeView
              node={t.paneTree}
              tabVisible={tabVisible}
              activeLeafId={t.activeLeafId}
              onFocusLeaf={(leafId) => onFocusLeaf(t.id, leafId)}
              getBundle={getBundle}
            />
          </div>
        );
      })}
    </div>
  );
}
