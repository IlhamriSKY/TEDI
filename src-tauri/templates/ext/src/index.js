// __NAME__ - entry point.
//
// The JSDoc line below is what gives you autocomplete and red squiggles on
// `ctx.*` without installing anything: `tedi.d.ts` sits next to this folder
// and `jsconfig.json` turns on checking. Try typing `ctx.` and see.

/** @typedef {import("../tedi").ExtensionContext} ExtensionContext */

const COMMAND_HELLO = "__ID__.greet";
const STATUS_ITEM = "hello";

/** Set once in `activate`, cleared in `deactivate`. @type {ExtensionContext | null} */
let ctx = null;

/**
 * Called once when the extension is enabled. Everything you register through
 * `ctx` is torn down for you on deactivate, so most extensions never need
 * `ctx.addDisposer` - use it only for your own timers and sockets.
 *
 * Throwing here fails activation, but your manifest contributions survive, so
 * the user can still reach the Settings card to disable or uninstall.
 *
 * @param {ExtensionContext} context
 */
export async function activate(context) {
  ctx = context;

  // Runs on the keybinding from the manifest AND from the Command Palette.
  ctx.registerCommandHandler(COMMAND_HELLO, () => {
    ctx?.ui.toast("Hello from __NAME__", { variant: "success" });
  });

  ctx.statusBar.setItem({
    id: STATUS_ITEM,
    icon: "lucide:Sparkles",
    tooltip: "__NAME__: say hello",
    onClick: () => {
      ctx?.ui.toast("Hello from __NAME__", { variant: "success" });
    },
  });

  ctx.logger.info("activated");
}

/**
 * Optional, awaited before the host runs its own disposers, and it may be
 * called more than once in a session - so keep it idempotent.
 */
export async function deactivate() {
  ctx = null;
}
