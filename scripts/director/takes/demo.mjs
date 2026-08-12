/**
 * Example take: a short tour of split panes, the terminal, and the command
 * palette. Run it against a TEDI started with TEDI_DEBUG_PORT:
 *
 *   pnpm director run scripts/director/takes/demo.mjs --rec demo
 *
 * `d.caption()` and `d.mark()` stamp the recording's own clock, so subtitles and
 * chapter cuts line up with the footage without hand-syncing later.
 */

/** Where the demo runs. A take should never film whatever folder the window
 * happened to be left in: the shell starts in $HOME, which puts the user's
 * private dotfiles in the file tree and, if $HOME is a git repo, buries the app
 * under git decoration work. */
const PROJECT = "D:\\Ilham\\Project\\laragon\\www\\TEDI - terax-ai";

/** Runs before the recording starts, so staging is not in the shot. */
export async function setup(d) {
  await d.command(`cd '${PROJECT}'`, { delay: 8 });
  await d.wait(1200);
  // Start from an empty screen, or the take opens on whatever the last session
  // left behind and no two recordings match.
  await d.command("clear", { delay: 8 });
  await d.wait(600);
}

/** @param {import("../director.mjs").Director} d */
export default async function demo(d) {
  d.caption("TEDI: a terminal you can script", { seconds: 3 });
  await d.wait(2500);

  d.mark("split");
  d.caption("Split a pane", { seconds: 2.5 });
  await d.cmd("pane.splitRight");
  await d.wait(2500);

  d.caption("Every pane is a real PTY", { seconds: 3 });
  await d.command("git log --oneline -5");
  await d.wait(2200);

  d.mark("resize");
  d.caption("Drag the splitter to resize", { seconds: 3 });
  // Never a hard-coded nth: the handle list is [sidebar, panes…, right column],
  // so its indices move with the pane count and a stale guess drags the sidebar.
  const handle = await d.paneHandleIndex();
  await d.drag("[data-slot=resizable-handle]", -260, 0, { nth: handle });
  await d.wait(700);
  await d.drag("[data-slot=resizable-handle]", 260, 0, { nth: handle });
  await d.wait(1000);

  d.mark("palette");
  d.caption("Ctrl+Shift+P runs any command", { seconds: 3 });
  await d.keys("Ctrl+Shift+P");
  await d.wait(1500);
  await d.type("split", { delay: 90 });
  await d.wait(1500);
  await d.keys("Escape");
  await d.wait(800);

  d.mark("sidebar");
  d.caption("Toggle the sidebar", { seconds: 2.5 });
  await d.cmd("sidebar.toggle");
  await d.wait(1400);
  await d.cmd("sidebar.toggle");
  await d.wait(1200);

  d.mark("cleanup");
  await d.cmd("terminal.close");
  await d.wait(1200);
}
