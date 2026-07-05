import { useCallback, useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { Streamdown } from "streamdown";
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
    void getCurrentWindow().close();
  }, [params?.kind]);

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
