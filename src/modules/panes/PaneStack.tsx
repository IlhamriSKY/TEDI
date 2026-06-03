import type { EditorPaneHandle } from "@/modules/editor";
import { previewEmbedClose } from "@/modules/preview";
import type { PaneTab, Tab } from "@/modules/tabs";
import { leaves, type PaneEdge } from "@/modules/terminal/lib/panes";
import type { TerminalPaneHandle } from "@/modules/terminal";
import type { TediOpenInput, TediSpawnTabInput } from "@/modules/terminal/lib/useTerminalSession";
import type { SshStatus } from "@/modules/ssh/status";
import {
  listConnections,
  onConnectionsChanged,
  type SshConnection,
} from "@/modules/ssh/connections";
import type { AiCliStatus } from "@/modules/terminal/lib/aiCliStatus";
import type { SearchAddon } from "@xterm/addon-search";
import { useEffect, useMemo, useRef, useState } from "react";
import { PaneTreeView, type LeafBundle } from "./PaneTreeView";

type Props = {
  tabs: Tab[];
  activeId: number;
  // Terminal leaf callbacks
  registerTerminalHandle: (leafId: number, handle: TerminalPaneHandle | null) => void;
  onSearchReady: (leafId: number, addon: SearchAddon) => void;
  onCwd: (leafId: number, cwd: string) => void;
  onDetectedLocalUrl: (leafId: number, url: string) => void;
  onExit: (leafId: number, code: number) => void;
  onTediOpen?: (leafId: number, input: TediOpenInput) => void;
  onTediSpawnTab?: (leafId: number, input: TediSpawnTabInput) => void;
  onSshStatus?: (leafId: number, status: SshStatus) => void;
  onAiCliStatus?: (leafId: number, status: AiCliStatus) => void;
  /**
   * Fires once whenever a leaf's PTY acquires a daemon UUID. Forwarded
   * to `App.tsx` which writes it onto the leaf's `ptyId` field so the
   * workspace serializer persists it for restore.
   */
  onPtyId?: (leafId: number, ptyId: string) => void;
  // Editor leaf callbacks
  registerEditorHandle: (leafId: number, handle: EditorPaneHandle | null) => void;
  onDirtyChange: (leafId: number, dirty: boolean) => void;
  onCloseLeaf: (leafId: number) => void;
  // Preview (browser) leaf callbacks
  onPreviewUrlChange: (leafId: number, url: string) => void;
  /** Editor leaf ids rendered as markdown preview instead of source. */
  mdPreviewLeafIds: ReadonlySet<number>;
  // Shared
  onFocusLeaf: (tabId: number, leafId: number) => void;
  /** Drag-and-drop a leaf onto an edge of another leaf in the same tab. */
  onMovePaneLeaf?: (sourceLeafId: number, targetLeafId: number, edge: PaneEdge) => void;
  /** Close button in each pane header. */
  onCloseLeafRequest?: (leafId: number) => void;
  /** Live SSH status per terminal leaf id. Colors the SSH header label, mirroring the tab strip. */
  sshStatuses?: Map<number, SshStatus>;
  /** Live AI CLI status per terminal leaf id. Tints the header icon, mirroring the tab strip. */
  aiCliStatuses?: Map<number, AiCliStatus>;
};

export function PaneStack({
  tabs,
  activeId,
  registerTerminalHandle,
  onSearchReady,
  onCwd,
  onDetectedLocalUrl,
  onExit,
  onTediOpen,
  onTediSpawnTab,
  onSshStatus,
  onAiCliStatus,
  onPtyId,
  registerEditorHandle,
  onDirtyChange,
  onCloseLeaf,
  onPreviewUrlChange,
  mdPreviewLeafIds,
  onFocusLeaf,
  onMovePaneLeaf,
  onCloseLeafRequest,
  sshStatuses,
  aiCliStatuses,
}: Props) {
  // Memoize the filter so the prune effect below sees a stable identity.
  const paneTabs = useMemo(() => tabs.filter((t): t is PaneTab => t.kind === "pane"), [tabs]);

  // Resolve a leaf's `sshConnectionId` to a host for the `ssh:<host>` header
  // label. Loaded here (not per-leaf) and refreshed on connection changes,
  // mirroring the tab strip so both read identically.
  const [sshHosts, setSshHosts] = useState<Map<string, SshConnection>>(() => new Map());
  useEffect(() => {
    const load = () =>
      void listConnections().then((list) => setSshHosts(new Map(list.map((c) => [c.id, c]))));
    load();
    const unsub = onConnectionsChanged(load);
    return () => {
      void unsub.then((fn) => fn());
    };
  }, []);

  // Stable refs for per-leaf callbacks. Re-creating bundles would tear down PTY/editor state.
  const registerTerminalRef = useRef(registerTerminalHandle);
  const searchReadyRef = useRef(onSearchReady);
  const cwdRef = useRef(onCwd);
  const detectedUrlRef = useRef(onDetectedLocalUrl);
  const exitRef = useRef(onExit);
  const tediOpenRef = useRef(onTediOpen);
  const tediSpawnTabRef = useRef(onTediSpawnTab);
  const sshStatusRef = useRef(onSshStatus);
  const aiCliStatusRef = useRef(onAiCliStatus);
  const ptyIdRef = useRef(onPtyId);
  const registerEditorRef = useRef(registerEditorHandle);
  const dirtyChangeRef = useRef(onDirtyChange);
  const closeLeafRef = useRef(onCloseLeaf);
  const previewUrlRef = useRef(onPreviewUrlChange);
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
    tediOpenRef.current = onTediOpen;
  }, [onTediOpen]);
  useEffect(() => {
    tediSpawnTabRef.current = onTediSpawnTab;
  }, [onTediSpawnTab]);
  useEffect(() => {
    sshStatusRef.current = onSshStatus;
  }, [onSshStatus]);
  useEffect(() => {
    aiCliStatusRef.current = onAiCliStatus;
  }, [onAiCliStatus]);
  useEffect(() => {
    ptyIdRef.current = onPtyId;
  }, [onPtyId]);
  useEffect(() => {
    registerEditorRef.current = registerEditorHandle;
  }, [registerEditorHandle]);
  useEffect(() => {
    dirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    closeLeafRef.current = onCloseLeaf;
  }, [onCloseLeaf]);
  useEffect(() => {
    previewUrlRef.current = onPreviewUrlChange;
  }, [onPreviewUrlChange]);

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
        onTediOpen: (input) => tediOpenRef.current?.(leafId, input),
        onTediSpawnTab: (input) => tediSpawnTabRef.current?.(leafId, input),
        onSshStatus: (status) => sshStatusRef.current?.(leafId, status),
        onAiCliStatus: (status) => aiCliStatusRef.current?.(leafId, status),
        onPtyId: (ptyId) => ptyIdRef.current?.(leafId, ptyId),
        setEditorRef: (h) => registerEditorRef.current(leafId, h),
        onDirtyChange: (dirty) => dirtyChangeRef.current(leafId, dirty),
        onCloseLeaf: () => closeLeafRef.current(leafId),
        onPreviewUrlChange: (url) => previewUrlRef.current(leafId, url),
      };
      bundles.current.set(leafId, b);
    }
    return b;
  };

  // Prune per-leaf bundles, and destroy the native browser webview of any
  // preview leaf that has truly disappeared (closed) - NOT one merely remounted
  // by a move/reorder, which keeps the leaf id present here. This is why
  // PreviewPane no longer closes on unmount: it lets a dragged browser pane
  // keep its page instead of reloading.
  const prevPreviewLeaves = useRef<Set<number>>(new Set());
  useEffect(() => {
    const live = new Set<number>();
    const livePreview = new Set<number>();
    for (const t of paneTabs) {
      for (const l of leaves(t.paneTree)) {
        live.add(l.id);
        if (l.leafKind === "preview") livePreview.add(l.id);
      }
    }
    for (const id of bundles.current.keys()) {
      if (!live.has(id)) bundles.current.delete(id);
    }
    for (const id of prevPreviewLeaves.current) {
      if (!livePreview.has(id)) void previewEmbedClose(id).catch(() => {});
    }
    prevPreviewLeaves.current = livePreview;
  }, [paneTabs]);

  return (
    <div className="relative h-full w-full">
      {paneTabs.map((t) => {
        const tabVisible = t.id === activeId;
        return (
          <div
            key={t.id}
            // Hide inactive tabs at the wrapper. Panes stay mounted so PTY and
            // editor state survive tab switches; hidden DOM ignores pointer
            // events so resize handles from inactive tabs don't leak through.
            // The active wrapper paints `bg-background` to cover WebView2's
            // native xterm scrollbar from hidden tabs.
            className={
              tabVisible
                ? "bg-background absolute inset-0"
                : "pointer-events-none invisible absolute inset-0"
            }
            aria-hidden={tabVisible ? "false" : "true"}
          >
            <PaneTreeView
              node={t.paneTree}
              tabVisible={tabVisible}
              activeLeafId={t.activeLeafId}
              onFocusLeaf={(leafId) => onFocusLeaf(t.id, leafId)}
              getBundle={getBundle}
              mdPreviewLeafIds={mdPreviewLeafIds}
              onMovePaneLeaf={onMovePaneLeaf}
              onCloseLeaf={onCloseLeafRequest}
              sshHosts={sshHosts}
              sshStatuses={sshStatuses}
              aiCliStatuses={aiCliStatuses}
            />
          </div>
        );
      })}
    </div>
  );
}
