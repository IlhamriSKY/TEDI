import { IconTooltip } from "@/components/ui/icon-tooltip";
import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";

type Props = {
  /** Render only the close button. Used by the settings window. */
  closeOnly?: boolean;
};

export function WindowControls({ closeOnly = false }: Props) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!USE_CUSTOM_WINDOW_CONTROLS || closeOnly) return;
    const w = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    void w.isMaximized().then(setMaximized);
    void w
      .onResized(() => {
        void w.isMaximized().then(setMaximized);
      })
      .then((un) => {
        unlisten = un;
      });
    return () => unlisten?.();
  }, [closeOnly]);

  if (!USE_CUSTOM_WINDOW_CONTROLS) return null;

  const w = getCurrentWindow();

  return (
    <div className="flex h-full shrink-0 items-center gap-0.5 pr-1">
      {!closeOnly && (
        <>
          <IconTooltip label="Minimize" side="bottom">
            <CtlButton ariaLabel="Minimize" onClick={() => void w.minimize()}>
              <Minus size={12} strokeWidth={2} />
            </CtlButton>
          </IconTooltip>
          <IconTooltip label={maximized ? "Restore" : "Maximize"} side="bottom">
            <CtlButton
              ariaLabel={maximized ? "Restore" : "Maximize"}
              onClick={() => void w.toggleMaximize()}
            >
              {maximized ? (
                <Copy size={12} strokeWidth={2} />
              ) : (
                <Square size={12} strokeWidth={2} />
              )}
            </CtlButton>
          </IconTooltip>
        </>
      )}
      <IconTooltip label="Close" side="bottom">
        <CtlButton ariaLabel="Close" onClick={() => void w.close()} danger>
          <X size={14} strokeWidth={2} />
        </CtlButton>
      </IconTooltip>
    </div>
  );
}

function CtlButton({
  ariaLabel,
  onClick,
  children,
  danger,
}: {
  ariaLabel: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "text-muted-foreground grid size-7 cursor-pointer place-items-center rounded-md transition-colors",
        danger
          ? "hover:bg-destructive/10 hover:text-destructive"
          : "hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </button>
  );
}
