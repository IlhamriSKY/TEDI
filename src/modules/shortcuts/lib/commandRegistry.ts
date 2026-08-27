import { registerBridge } from "@/modules/automation/bridge";
import type { ShortcutId } from "../shortcuts";
import type { ShortcutHandler } from "./useGlobalShortcuts";

/**
 * Shared registry of runnable commands, populated by every `useGlobalShortcuts`
 * caller (App's global map, the file explorer's search map, …). It lets the
 * Command Palette run ANY command directly, regardless of which component owns
 * the handler and bypassing the keyboard gating that lets a focused terminal
 * keep its control chords. Without it the palette could only reach the handlers
 * wired into App and silently no-op'd on component-owned commands like the file
 * explorer's search.
 */
// A STACK of handlers per id, not a single slot: the same id can be registered
// by more than one live component. The file explorer, for one, is mounted both
// as the left-sidebar tree and (when opened) as the Secondary Folder Tree
// extension, and both register `explorer.search/grep/replaceAll`. A single slot
// would let the later mount overwrite the earlier one and, worse, delete the id
// outright when it unmounts, leaving the palette's search commands dead until a
// remount. With a stack, unregister removes only that handler and the earlier
// registration is still there.
const registry = new Map<ShortcutId, ShortcutHandler[]>();

export function registerCommand(id: ShortcutId, handler: ShortcutHandler): void {
  const stack = registry.get(id);
  if (stack) stack.push(handler);
  else registry.set(id, [handler]);
}

export function unregisterCommand(id: ShortcutId, handler: ShortcutHandler): void {
  const stack = registry.get(id);
  if (!stack) return;
  const i = stack.lastIndexOf(handler);
  if (i !== -1) stack.splice(i, 1);
  if (stack.length === 0) registry.delete(id);
}

export function hasCommand(id: ShortcutId): boolean {
  return (registry.get(id)?.length ?? 0) > 0;
}

/**
 * Run a registered command by id. Returns false when nothing is registered
 * (e.g. a documentation-only `readOnly` shortcut). When more than one component
 * owns the id, the FIRST-registered handler wins - matching the keyboard path,
 * where the first-mounted capture listener fires first and stops the rest. The
 * handler signature takes the triggering KeyboardEvent for the keyboard path; a
 * synthetic one is passed here since no palette-exposed command reads it (the
 * one that does, `tab.selectByIndex`, is excluded from the palette).
 */
export function runCommand(id: ShortcutId): boolean {
  const stack = registry.get(id);
  if (!stack || stack.length === 0) return false;
  stack[0](new KeyboardEvent("keydown"));
  return true;
}

/**
 * Automation surface for tooling driving TEDI over the WebView2 DevTools
 * Protocol (`TEDI_DEBUG_PORT`, see `scripts/mcp/`). Running a command by id
 * is deterministic where fuzzy-typing into the Command Palette is not, and
 * `listCommands` tells the driver what this build actually has registered.
 *
 * Present only when TEDI was started with `TEDI_DEBUG_PORT`, in a dev build and
 * a released one alike: Rust injects `window.__TEDI_AUTOMATION__` from the same
 * env var that opens the port (see `lib.rs`), so one switch governs both halves
 * and neither exists without it. Not gated on the build profile, because the app
 * worth automating is often the one that shipped.
 *
 * That it is gated at all is about surface, not privilege: a DevTools client
 * could reach all of this anyway, and extension code shares this realm already
 * (see `extensions/permissions.ts` on the v1 trust model). But pane reads and
 * writes hang off the same object, and nothing here has any reason to exist in a
 * session that never asked to be driven.
 *
 * Merged, not assigned: FOUR files contribute to `window.__tedi` - this one
 * (commands), `usePaneHandles` (every pane, and reading/writing terminals and
 * editors), `useFileActions` (open a file by path) and `extensions/store`
 * (installed extensions and their own command registry) - and none may clobber
 * the others, in whichever order they happen to evaluate.
 */
/** Every command id this build has actually registered, sorted. Exported rather
 *  than inlined below because BOTH transports need it: an outside AI CLI through
 *  `window.__tedi`, and TEDI's own agent through `ai/tools/tedi.ts`. One
 *  definition, two transports - the same rule the settings and extension
 *  accessors follow, and `driver-verify` checks it. */
export function listCommands(): string[] {
  return [...registry.keys()].sort();
}

registerBridge({ runCommand, hasCommand, listCommands });
