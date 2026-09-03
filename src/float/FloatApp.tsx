import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { Streamdown } from "streamdown";
import { EditorPane, type EditorPaneHandle } from "@/modules/editor";
import { decodeFloatParams, floatEv, type FloatCards } from "@/modules/panes/floatProtocol";
import { BoardColumns } from "@/modules/workspaces/WorkspaceBoard";
import type { PaneEntry } from "@/modules/tabs/lib/entries";
import { FloatTableProvider, markdownComponents } from "@/components/ai-elements/markdown-code";
import { ExtensionPanelMount } from "@/modules/extensions/components/ExtensionPanelMount";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toast";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { safeUrlTransform } from "@/lib/markdownSafety";
import { FloatTerminal } from "./FloatTerminal";
import { Minus, Square, X } from "lucide-react";

/**
 * Root of a floating pane window. Reads the leaf params from its URL and renders
 * a live terminal mirror or a file editor, under a compact custom titlebar
 * (the window ships with decorations off, like Settings/Debug).
 */
export function FloatApp() {
  const params = decodeFloatParams(window.location.search);
  const leafId = params?.leafId;
  const editorRef = useRef<EditorPaneHandle | null>(null);

  // Every close routes through here: for an editor, persist the buffer first so
  // the main pane (which remounts + re-reads the file on dock-back) picks up the
  // float's edits. The float capability grants close() but not destroy(), and the
  // window is frameless on Win/Linux, so dock-back and the custom titlebar X are
  // the close paths we control (a raw OS Alt+F4 bypasses this - best effort).
  const closeWindow = useCallback(async () => {
    if (params?.kind === "editor") {
      try {
        await editorRef.current?.save();
      } catch {
        /* best-effort: don't block the close on a save failure */
      }
    }
    void getCurrentWindow().close();
  }, [params?.kind, leafId]);

  // "Dock back into TEDI" from the main pane closes this window (saving first).
  useEffect(() => {
    if (leafId === undefined) return;
    const un = listen(floatEv.close(leafId), () => void closeWindow());
    return () => void un.then((fn) => fn());
  }, [leafId, closeWindow]);

  return (
    <div className="bg-background text-foreground flex h-screen w-screen flex-col overflow-hidden">
      <TitleBar title={params?.title ?? "Floating pane"} onClose={closeWindow} />
      {/* One TooltipProvider + ErrorBoundary for every kind: this bare window has
          no app root, so Radix tooltips (editor find bars, table controls) would
          otherwise throw, and a render crash would white-screen the window. */}
      <div className="relative min-h-0 flex-1">
        <ErrorBoundary label="floating pane" resetKeys={[leafId]}>
          <TooltipProvider>
            {params?.kind === "terminal" ? (
              <FloatTerminal leafId={params.leafId} remotePty={params.remotePty} />
            ) : params?.kind === "table" && params.markdown ? (
              <FloatTableView markdown={params.markdown} />
            ) : params?.kind === "editor" && params.path ? (
              <EditorPane ref={editorRef} path={params.path} aiDisabled={params.privateLeaf} />
            ) : params?.kind === "board" ? (
              <FloatBoard leafId={params.leafId} />
            ) : params?.kind === "extension-panel" && params.extensionId && params.panelId ? (
              <FloatExtensionPanel
                extensionId={params.extensionId}
                panelId={params.panelId}
                reuseKey={params.reuseKey}
              />
            ) : (
              <div className="text-muted-foreground flex h-full items-center justify-center text-[12px]">
                This pane can't be floated.
              </div>
            )}
          </TooltipProvider>
        </ErrorBoundary>
      </div>
      {/* Toast listeners are per-webview: without a Toaster here, a floated
          editor's "Format failed" would fire into nothing. */}
      <Toaster />
    </div>
  );
}

/**
 * The workspace Board popped out into a float window.
 *
 * Unlike every other floated kind this one is neither a re-parented webview nor
 * a self-contained view it can rebuild: the board IS the tab tree, and this
 * window has no tab tree. So it mirrors like a terminal - the main-window board
 * stays mounted and pushes its cards over on every change, and this end renders
 * them through the SAME `BoardColumns` the pane uses, so the two windows cannot
 * drift apart.
 *
 * HELLO is sent twice for the same host-not-ready race the terminal float has
 * (the window can be up before the main window has registered its listener).
 * Re-sending is harmless here: the payload is a full snapshot, not a delta.
 */
function FloatBoard({ leafId }: { leafId: number }) {
  const [cards, setCards] = useState<FloatCards>({ entries: [], titles: {} });
  useEffect(() => {
    const un = listen<FloatCards>(floatEv.cards(leafId), (e) => {
      if (e.payload) setCards(e.payload);
    });
    void emit(floatEv.hello(leafId));
    const retry = window.setTimeout(() => void emit(floatEv.hello(leafId)), 250);
    return () => {
      window.clearTimeout(retry);
      void un.then((fn) => fn());
      // Tell the host to drop its mirror; the Rust `Destroyed` event is the
      // guaranteed fallback when the window dies without getting here.
      void emit(floatEv.bye(leafId));
    };
  }, [leafId]);

  return (
    <BoardColumns
      cards={cards.entries as PaneEntry[]}
      titles={cards.titles}
      onOpen={(tabId, focusLeafId) =>
        void emit(floatEv.focus(leafId), { tabId, leafId: focusLeafId })
      }
    />
  );
}

/**
 * An extension panel popped out into a float window.
 *
 * Panel renderers live in per-webview registries and only the main window boots
 * extensions, so this window activates the one it needs itself - there is no
 * mirror to receive. The extension then runs as a second live copy against the
 * same `ctx.storage`, which is the contract panels are expected to handle (the
 * API Client refreshes its tree whenever the panel mounts).
 */
function FloatExtensionPanel({
  extensionId,
  panelId,
  reuseKey,
}: {
  extensionId: string;
  panelId: string;
  reuseKey?: string;
}) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // Dynamic: keeps the extension host + loader out of the float window's
        // first paint, which is a terminal or an editor far more often.
        const loader = await import("@/modules/extensions/loader");
        const ext = (await loader.listInstalled()).find((e) => e.id === extensionId);
        if (!ext) throw new Error(`${extensionId} is not installed.`);
        if (!ext.enabled) throw new Error(`${ext.manifest.name} is disabled.`);
        await loader.activate(ext); // no-op if this window already activated it
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [extensionId]);

  if (error) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center px-6 text-center text-[12px]">
        {error}
      </div>
    );
  }
  return (
    <ExtensionPanelMount
      extensionId={extensionId}
      panelId={panelId}
      surface="pane"
      reuseKey={reuseKey}
    />
  );
}

/** A markdown table popped out into a float window. Re-renders the table markdown
 *  through the shared pipeline so it looks identical to the inline table;
 *  `FloatTableProvider` hides the (now-redundant) open-in-pane control. The
 *  TooltipProvider its controls need is supplied once by FloatApp for all kinds. */
function FloatTableView({ markdown }: { markdown: string }) {
  return (
    <FloatTableProvider value={true}>
      <div className="h-full overflow-auto p-2">
        <Streamdown
          components={markdownComponents}
          controls={{ table: false }}
          urlTransform={safeUrlTransform}
        >
          {markdown}
        </Streamdown>
      </div>
    </FloatTableProvider>
  );
}

function TitleBar({ title, onClose }: { title: string; onClose?: () => void }) {
  const win = getCurrentWindow();
  return (
    <div
      data-tauri-drag-region
      className="border-border/60 bg-card flex h-8 shrink-0 items-center gap-2 border-b px-2 select-none"
    >
      <span
        className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]"
        data-tauri-drag-region
      >
        {title}
      </span>
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => void win.minimize()}
        className="text-muted-foreground/70 hover:bg-muted hover:text-foreground flex size-5 items-center justify-center rounded"
      >
        <Minus size={13} strokeWidth={2} />
      </button>
      <button
        type="button"
        aria-label="Toggle maximize"
        onClick={() => void win.toggleMaximize()}
        className="text-muted-foreground/70 hover:bg-muted hover:text-foreground flex size-5 items-center justify-center rounded"
      >
        <Square size={11} strokeWidth={2} />
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose ?? (() => void win.close())}
        className="text-muted-foreground/70 hover:bg-destructive/15 hover:text-destructive flex size-5 items-center justify-center rounded"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}
