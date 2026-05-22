/**
 * Dispatcher for extension keybindings. Mount once at the App root.
 * On each keydown the hook walks `keybindingsRegistry` for declarations and
 * `commandsRegistry` for the matching `registerCommandHandler` handler.
 * User overrides live in `preferences.extensionShortcuts[<commandId>]`.
 * An empty array means the user cleared the binding; dispatch is skipped.
 * Capture-phase listener so bindings reach the dispatcher before native
 * input handlers. `preventDefault` + `stopImmediatePropagation` only fire
 * on a match.
 */
import { useEffect, useRef } from "react";

import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  commandsRegistry,
  keybindingsRegistry,
} from "@/modules/extensions/registries";

import { matchBinding, parseKeybindingString } from "../shortcuts";

export function useExtensionShortcuts(): void {
  const overrides = usePreferencesStore((s) => s.extensionShortcuts);

  // Latest overrides via ref so the global listener isn't reattached.
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Fast path: nothing declared.
      const declared = keybindingsRegistry.list();
      if (declared.length === 0) return;

      for (const { extensionId, item } of declared) {
        const commandId = item.command;
        // User override wins. `[]` means cleared, so skip.
        const userBindings = overridesRef.current[commandId];
        const bindings = userBindings ?? [parseKeybindingString(item.key)].filter(Boolean);
        if (bindings.length === 0) continue;

        const matched = bindings.some((b) => b !== null && matchBinding(e, b));
        if (!matched) continue;

        const handler = commandsRegistry.getRuntime(extensionId, commandId);
        if (typeof handler !== "function") continue;

        e.preventDefault();
        e.stopImmediatePropagation();
        try {
          (handler as (...args: unknown[]) => unknown)();
        } catch (err) {
          console.error(
            `[extensions] command handler "${extensionId}:${commandId}" threw`,
            err,
          );
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}
