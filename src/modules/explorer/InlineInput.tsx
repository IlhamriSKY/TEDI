import { useLayoutEffect, useRef, useState } from "react";

type Props = {
  initial: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
};

/**
 * Self-focusing single-line input for rename/create flows. Enter commits,
 * Escape cancels, blur commits (matches VS Code).
 */
export function InlineInput({ initial, placeholder, onCommit, onCancel }: Props) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const settledRef = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Two-tick focus to beat parent click handlers and Radix portal
    // teardowns that steal focus on mount. The input is "unsettled" until
    // the second tick lands; blur during that window refocuses instead of
    // committing an empty value.
    const focus = () => {
      el.focus({ preventScroll: false });
      const dot = initial.lastIndexOf(".");
      if (dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    };
    focus();
    const raf = requestAnimationFrame(() => focus());
    const timer = setTimeout(() => {
      focus();
      settledRef.current = true;
    }, 170);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [initial]);

  const commit = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCommit(value);
  };
  const cancel = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={ref}
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={() => {
        if (!settledRef.current) {
          ref.current?.focus({ preventScroll: true });
          return;
        }
        commit();
      }}
      className="border-border bg-background text-foreground focus:border-ring flex-1 truncate rounded-sm border px-1.5 py-0.5 text-xs ring-0 outline-none"
    />
  );
}
