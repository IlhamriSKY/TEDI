import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { Streamdown } from "streamdown";
import { BrowserPane, previewEmbedReparent } from "@/modules/browser";
import { EditorPane, type EditorPaneHandle } from "@/modules/editor";
import { decodeFloatParams, floatEv } from "@/modules/panes/floatProtocol";
import { FloatTableProvider, markdownComponents } from "@/components/ai-elements/markdown-code";
import { TooltipProvider } from "@/components/ui/tooltip";
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
    // A browser leaf's webview LIVES in this window while floated, and closing a
    // window destroys the webviews inside it - so hand it back to the main window
    // first or the page is gone. This is awaited, not fired and forgotten. A raw
    // OS Alt+F4 still bypasses it, and then the main pane simply recreates the
    // webview from the tab's url on dock-back (a reload, not a broken pane).
    if (params?.kind === "browser" && leafId !== undefined) {
      try {
        await previewEmbedReparent(leafId, "main");
      } catch {
        /* best-effort: closing anyway beats a window that refuses to close */
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
              <FloatTerminal leafId={params.leafId} />
            ) : params?.kind === "table" && params.markdown ? (
              <FloatTableView markdown={params.markdown} />
            ) : params?.kind === "editor" && params.path ? (
              <EditorPane ref={editorRef} path={params.path} aiDisabled={params.privateLeaf} />
            ) : params?.kind === "browser" ? (
              <FloatBrowser leafId={params.leafId} url={params.url ?? ""} />
            ) : (
              <div className="text-muted-foreground flex h-full items-center justify-center text-[12px]">
                This pane can't be floated.
              </div>
            )}
          </TooltipProvider>
        </ErrorBoundary>
      </div>
    </div>
  );
}

/**
 * A browser pane popped out into a float window.
 *
 * The pane is a real native webview docked over a rectangle, not DOM, so it is
 * MOVED here rather than re-created: one `reparent` call and the page keeps its
 * scroll position, its session and anything it was playing. After that
 * `BrowserPane` behaves exactly as it does in the main window, because every
 * operation it performs is keyed by leaf id and goes through Rust - it never knew
 * which window it was in.
 *
 * The pane is mounted only AFTER the move lands: it starts measuring and pushing
 * bounds the moment it mounts, and those bounds are relative to the OWNING
 * window, so measuring here while the main window still owned the webview would
 * park the page at the wrong coordinates for a frame.
 */
function FloatBrowser({ leafId, url }: { leafId: number; url: string }) {
  const [owned, setOwned] = useState(false);
  const [current, setCurrent] = useState(url);
  useEffect(() => {
    let alive = true;
    void previewEmbedReparent(leafId, `float-${leafId}`)
      .catch(console.error)
      // Mount either way: on failure the pane still renders its chrome and the
      // user can see and act on the state instead of staring at a blank window.
      .finally(() => {
        if (alive) setOwned(true);
      });
    return () => {
      alive = false;
    };
  }, [leafId]);
  if (!owned) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center text-[12px]">
        Moving the page over…
      </div>
    );
  }
  return (
    <BrowserPane
      id={leafId}
      url={current}
      visible
      onUrlChange={(u) => {
        setCurrent(u);
        // Report back so the leaf in the main window keeps the real address: its
        // tab title reads from it, and so does the browser list the AI sees in
        // `<env>`. Without this, browsing inside a floated pane would leave both
        // showing whatever page it was popped out on.
        void emit(floatEv.url(leafId), u);
      }}
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
