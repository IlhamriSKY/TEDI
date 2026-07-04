import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { EditorPane } from "@/modules/editor";
import { decodeFloatParams, floatEv } from "@/modules/panes/floatProtocol";
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

  // "Dock back into TEDI" from the main pane closes this window.
  useEffect(() => {
    if (leafId === undefined) return;
    const un = listen(floatEv.close(leafId), () => void getCurrentWindow().close());
    return () => void un.then((fn) => fn());
  }, [leafId]);

  return (
    <div className="bg-background text-foreground flex h-screen w-screen flex-col overflow-hidden">
      <TitleBar title={params?.title ?? "Floating pane"} />
      <div className="relative min-h-0 flex-1">
        {params?.kind === "terminal" ? (
          <FloatTerminal leafId={params.leafId} />
        ) : params?.kind === "editor" && params.path ? (
          <EditorPane path={params.path} aiDisabled={params.privateLeaf} />
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center text-[12px]">
            This pane can't be floated.
          </div>
        )}
      </div>
    </div>
  );
}

function TitleBar({ title }: { title: string }) {
  const win = getCurrentWindow();
  return (
    <div
      data-tauri-drag-region
      className="border-border/60 bg-card flex h-8 shrink-0 items-center gap-2 border-b px-2 select-none"
    >
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]" data-tauri-drag-region>
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
        onClick={() => void win.close()}
        className="text-muted-foreground/70 hover:bg-destructive/15 hover:text-destructive flex size-5 items-center justify-center rounded"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  );
}
