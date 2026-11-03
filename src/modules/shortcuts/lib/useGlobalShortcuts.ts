import { useEffect, useRef } from "react";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { SHORTCUTS, matchBinding, type ShortcutId } from "../shortcuts";
import { registerCommand, unregisterCommand } from "./commandRegistry";

export type ShortcutHandler = (e: KeyboardEvent) => void;
export type ShortcutHandlers = Partial<Record<ShortcutId, ShortcutHandler>>;

export type UseGlobalShortcutsOptions = {
  isDisabled?: (id: ShortcutId, e: KeyboardEvent) => boolean;
};

/**
 * Only App knows who owns a key, but any component can dispatch ids of its own
 * (the file explorer's search). Shared across every caller, because each one has
 * its own listener: one without the gate would fire what App just declined, and
 * take Ctrl+P from readline in a focused terminal.
 */
let sharedIsDisabled: UseGlobalShortcutsOptions["isDisabled"];

export function useGlobalShortcuts(
  handlers: ShortcutHandlers,
  options?: UseGlobalShortcutsOptions,
) {
  if (options?.isDisabled) sharedIsDisabled = options.isDisabled;
  const latest = useRef(handlers);
  latest.current = handlers;

  // Access the shortcuts from the store
  const userShortcuts = usePreferencesStore((s) => s.shortcuts);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const handlers = latest.current;
      for (const s of SHORTCUTS) {
        // Use user-defined bindings if they exist, otherwise use default
        const bindings = userShortcuts[s.id] || s.defaultBindings;

        const isMatch = bindings.some((b) => matchBinding(e, b, s.id));
        if (!isMatch) continue;

        if (sharedIsDisabled?.(s.id, e)) return;
        const h = handlers[s.id];
        if (!h) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        h(e);
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [userShortcuts]);

  // Publish this caller's commands to the shared registry so the Command Palette
  // can run them directly (see commandRegistry). The id set is stable per caller
  // even though the handler closures are recreated each render, so key off the
  // id signature and have each registered invoker read `latest` to always call
  // the freshest closure.
  const idSig = Object.keys(handlers).sort().join(",");
  useEffect(() => {
    const ids = Object.keys(latest.current) as ShortcutId[];
    const invokers = new Map<ShortcutId, ShortcutHandler>();
    for (const id of ids) {
      const invoke: ShortcutHandler = (e) => latest.current[id]?.(e);
      invokers.set(id, invoke);
      registerCommand(id, invoke);
    }
    return () => {
      for (const [id, invoke] of invokers) unregisterCommand(id, invoke);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idSig]);
}
