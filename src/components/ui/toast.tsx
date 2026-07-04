import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";

export type ToastVariant = "default" | "success" | "info" | "warning" | "error";

type ToastItem = {
  id: number;
  message: string;
  variant: ToastVariant;
  durationMs: number;
};

const listeners = new Set<(t: ToastItem) => void>();
let nextId = 1;

export function toast(message: string, options?: { variant?: ToastVariant; durationMs?: number }) {
  const item: ToastItem = {
    id: nextId++,
    message,
    variant: options?.variant ?? "default",
    durationMs: options?.durationMs ?? 3200,
  };
  for (const l of listeners) l(item);
}

const VARIANT_ICONS = {
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
  default: null,
} as const;

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const onPush = (t: ToastItem) => {
      setItems((curr) => [...curr, t]);
      window.setTimeout(() => {
        setItems((curr) => curr.filter((x) => x.id !== t.id));
      }, t.durationMs);
    };
    listeners.add(onPush);
    return () => {
      listeners.delete(onPush);
    };
  }, []);

  const dismiss = (id: number) => setItems((curr) => curr.filter((x) => x.id !== id));

  return (
    <div
      // Top-right stack, above panes/modals. Pointer-events on the container
      // are off so the toast strip never blocks clicks under it; individual
      // toasts re-enable them.
      className="pointer-events-none fixed top-12 right-3 z-[60] flex w-80 flex-col gap-1.5"
      aria-live="polite"
      aria-atomic="true"
    >
      {items.map((t) => {
        const Icon = VARIANT_ICONS[t.variant];
        return (
          <div
            key={t.id}
            role="status"
            className={cn(
              "animate-in fade-in slide-in-from-top-1 pointer-events-auto flex items-start gap-2 rounded-md border border-l-[3px] px-3 py-2 text-[12px] shadow-md duration-150",
              t.variant === "default" && "bg-popover text-popover-foreground border-border",
              t.variant === "success" &&
                "border-diff-added/60 border-l-diff-added bg-diff-added/10 text-foreground",
              t.variant === "info" && "border-info/60 border-l-info bg-info/10 text-foreground",
              t.variant === "warning" &&
                "border-icon-working/60 border-l-icon-working bg-icon-working/10 text-foreground",
              t.variant === "error" &&
                "border-destructive/60 border-l-destructive bg-destructive/10 text-foreground",
            )}
          >
            {Icon && (
              <Icon
                size={14}
                strokeWidth={2}
                className={cn(
                  "mt-0.5 shrink-0",
                  t.variant === "success" && "text-diff-added",
                  t.variant === "info" && "text-info",
                  t.variant === "warning" && "text-icon-working",
                  t.variant === "error" && "text-destructive",
                )}
              />
            )}
            <span className="min-w-0 flex-1 leading-snug">{t.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className={cn(
                "-mt-0.5 -mr-1 shrink-0 cursor-pointer rounded p-0.5 opacity-60 transition-opacity hover:opacity-100",
              )}
            >
              <X size={11} strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
