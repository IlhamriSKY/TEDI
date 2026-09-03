/**
 * Dispatcher for extension keybindings. Mount once at the App root.
 * On each keydown the hook walks `keybindingsRegistry` for declarations and
 * `commandsRegistry` for the matching `registerCommandHandler` handler.
 * User overrides live in `preferences.extensionShortcuts[<commandId>]`.
 * An empty array means the user cleared the binding; dispatch is skipped.
 * Capture-phase listener so bindings reach the dispatcher before native
 * input handlers. `preventDefault` + `stopImmediatePropagation` only fire
 * on a match.
 *
 * Two chords an extension may NEVER take, both enforced here because this
 * listener would otherwise `preventDefault` before anyone else sees the key:
 *
 *  1. A focused terminal's control codes. `useGlobalShortcuts` lets bare-Ctrl
 *     and bare-Alt chords fall through to a focused local or SSH terminal (App's
 *     `isDisabled`); without the same rule here, an extension binding `Ctrl+A`
 *     silently eats readline's beginning-of-line in every shell session.
 *  2. A chord the core catalog claims. Both dispatchers are capture-phase
 *     `window` listeners, so the winner was decided by registration order -
 *     and `useGlobalShortcuts` re-registers whenever the user rebinds anything,
 *     which flipped core from first to last and handed the chord to the
 *     extension from then on. `coreShortcutFor` makes core win either way.
 */
import { useEffect, useRef } from "react";

import { usePreferencesStore } from "@/modules/settings/preferences";
import { commandsRegistry, keybindingsRegistry } from "@/modules/extensions/registries";
import { focusedTerminalLeafId } from "@/modules/terminal";

import {
  coreShortcutFor,
  isTerminalControlChord,
  isTerminalMetaChord,
  matchBinding,
  parseKeybindingString,
} from "../shortcuts";

/** One warning per colliding binding, not one per keypress. */
const warnedCollisions = new Set<string>();

export function useExtensionShortcuts(): void {
  const overrides = usePreferencesStore((s) => s.extensionShortcuts);
  const coreShortcuts = usePreferencesStore((s) => s.shortcuts);

  // Latest overrides via ref so the global listener isn't reattached.
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const coreShortcutsRef = useRef(coreShortcuts);
  coreShortcutsRef.current = coreShortcuts;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Fast path: nothing declared.
      const declared = keybindingsRegistry.list();
      if (declared.length === 0) return;

      // (1) A focused terminal owns its control codes and meta sequences.
      if (
        (isTerminalControlChord(e) || isTerminalMetaChord(e)) &&
        focusedTerminalLeafId() !== null
      ) {
        return;
      }

      for (const { extensionId, item } of declared) {
        const commandId = item.command;
        // User override wins. `[]` means cleared, so skip.
        const userBindings = overridesRef.current[commandId];
        const bindings = userBindings ?? [parseKeybindingString(item.key)].filter(Boolean);
        if (bindings.length === 0) continue;

        const matched = bindings.some((b) => b !== null && matchBinding(e, b));
        if (!matched) continue;

        // (2) Core keeps a chord it already claims.
        const core = coreShortcutFor(e, coreShortcutsRef.current);
        if (core) {
          const seen = `${extensionId}:${commandId}`;
          if (!warnedCollisions.has(seen)) {
            warnedCollisions.add(seen);
            console.warn(
              `[extensions] "${seen}" is bound to ${item.key}, which TEDI's "${core}" already uses. ` +
                `The built-in action wins; rebind either one in Settings > Shortcuts.`,
            );
          }
          continue;
        }

        const handler = commandsRegistry.getRuntime(extensionId, commandId);
        if (typeof handler !== "function") continue;

        e.preventDefault();
        e.stopImmediatePropagation();
        try {
          (handler as (...args: unknown[]) => unknown)();
        } catch (err) {
          console.error(`[extensions] command handler "${extensionId}:${commandId}" threw`, err);
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}
