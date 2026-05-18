import {
  Alert01Icon,
  AlertCircleIcon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  InformationCircleIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

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
  success: CheckmarkCircle02Icon,
  info: InformationCircleIcon,
  warning: Alert01Icon,
  error: AlertCircleIcon,
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
                "border-emerald-500/60 border-l-emerald-500 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-100",
              t.variant === "info" &&
                "border-sky-500/60 border-l-sky-500 bg-sky-50 text-sky-900 dark:bg-sky-950/60 dark:text-sky-100",
              t.variant === "warning" &&
                "border-amber-500/60 border-l-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-100",
              t.variant === "error" &&
                "border-red-500/60 border-l-red-500 bg-red-50 text-red-900 dark:bg-red-950/60 dark:text-red-100",
            )}
          >
            {Icon && (
              <HugeiconsIcon
                icon={Icon}
                size={14}
                strokeWidth={2}
                className={cn(
                  "mt-0.5 shrink-0",
                  t.variant === "success" && "text-emerald-600 dark:text-emerald-400",
                  t.variant === "info" && "text-sky-600 dark:text-sky-400",
                  t.variant === "warning" && "text-amber-600 dark:text-amber-400",
                  t.variant === "error" && "text-red-600 dark:text-red-400",
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
              <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
