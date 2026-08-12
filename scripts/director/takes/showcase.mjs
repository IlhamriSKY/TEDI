/**
 * Showcase take: a human-paced tour of TEDI for build-in-public footage. Covers
 * code in the editor, a real terminal, splitting and resizing panes, the command
 * palette, and creating a second workspace.
 *
 *   pnpm director run scripts/director/takes/showcase.mjs --rec showcase --size 1920x1080
 *
 * Every beat carries a caption and the chapters carry marks, so the edit can cut
 * by `take.json` instead of by eye.
 */

const PROJECT = process.env.SHOWCASE_PROJECT ?? "D:\\Ilham\\Project\\laragon\\www\\TEDI - terax-ai";

/** Index of a workspace row's own "Close workspace" button. */
const closerFor = (name) => `(() => {
  const root = document.querySelector('[data-testid=right-workspaces]');
  if (!root) return -1;
  const buttons = [...root.querySelectorAll('button')];
  const row = buttons.findIndex(
    (b) => ((b.getAttribute('aria-label') || b.textContent || '').trim()) === ${JSON.stringify(name)},
  );
  if (row < 0) return -1;
  for (let i = row + 1; i < Math.min(row + 5, buttons.length); i++) {
    if ((buttons[i].getAttribute('aria-label') || '').trim() === 'Close workspace') return i;
  }
  return -1;
})()`;

const sidebarWidth = (d) =>
  d.eval(
    `Math.round(document.querySelector('[data-testid=sidebar]')?.getBoundingClientRect().width ?? 0)`,
  );

const paneCount = (d) => d.eval("document.querySelectorAll('[data-pane-leaf]').length");

/** Close panes until one is left, then make sure it is a shell. */
async function onePane(d) {
  for (let i = 0; i < 8; i++) {
    const n = await paneCount(d);
    const term = await d.eval("document.querySelectorAll('.xterm-screen').length");
    if (n <= 1 && term > 0) break;
    await d.click('button[aria-label="Close pane"]', { nth: Math.max(0, n - 1) });
    await d.wait(1100);
  }
}

/** Runs before the recording starts, so staging is never in the shot. */
export async function setup(d) {
  // Toasts stack in the top-right, over the very controls this take clicks, and
  // they would sit in the middle of the footage besides.
  await d.dismissToasts();
  await onePane(d);
  if ((await sidebarWidth(d)) === 0) {
    await d.cmd("sidebar.toggle");
    await d.wait(1000);
  }
  await d.command(`cd '${PROJECT}'`, { delay: 8 });
  await d.wait(1800);
  await d.command("clear", { delay: 8 });
  await d.wait(700);

  // Assert the preconditions the beats below depend on, rather than recording a
  // minute of footage that turns out to be wrong. The @-file beat needs the tree
  // rooted at the project (a workspace left over at $HOME finds nothing), and
  // the workspace beat names "Workspace 2", which only holds from one workspace.
  const rooted = await d.eval(
    `[...document.querySelectorAll('[data-fs-path]')].some((e) => /vite\\.config\\.ts$/.test(e.getAttribute('data-fs-path')))`,
  );
  if (!rooted) throw new Error(`tree is not rooted at ${PROJECT}: the @-file beat would find nothing`);
  const count = await d.eval(
    `[...(document.querySelector('[data-testid=right-workspaces]')?.querySelectorAll('button') ?? [])]
       .filter((b) => /^Workspace \\d+$/.test((b.getAttribute('aria-label') || b.textContent || '').trim())).length`,
  );
  if (count !== 1) throw new Error(`expected exactly 1 workspace, found ${count}`);
}

/** @param {import("../director.mjs").Director} d */
export default async function showcase(d) {
  await d.wait(1200);

  // --- terminal ----------------------------------------------------------
  d.mark("terminal");
  d.caption("A terminal that is actually a terminal", { seconds: 3.5 });
  await d.command("git log --oneline -5");
  await d.wait(3000);

  // --- panes -------------------------------------------------------------
  d.mark("panes");
  d.caption("Split it, and both halves keep running", { seconds: 3.5 });
  await d.cmd("pane.splitRight");
  await d.wait(2600);
  await d.command("git status --short");
  await d.wait(2600);

  d.caption("Drag the divider to give one side more room", { seconds: 3.5 });
  const handle = await d.paneHandleIndex();
  if (handle >= 0) {
    await d.drag("[data-slot=resizable-handle]", -220, 0, { nth: handle, steps: 28 });
    await d.wait(1200);
    await d.drag("[data-slot=resizable-handle]", 220, 0, { nth: handle, steps: 28 });
    await d.wait(1400);
  }

  // --- code --------------------------------------------------------------
  d.mark("code");
  d.caption("Type @ in the palette to jump to a file", { seconds: 4 });
  await d.cmd("commandPalette.open");
  await d.wait(1100);
  const palette = await d.eval(
    "[...document.querySelectorAll('input')].findIndex(i=>/Type a command/i.test(i.placeholder||''))",
  );
  await d.click("input", { nth: palette });
  await d.type("@vite.config", { delay: 65 });
  await d.wait(1600);
  await d.keys("Enter");
  await d.waitFor(".cm-content");
  await d.wait(1800);

  d.caption("Real editor: syntax, minimap, folding", { seconds: 3.5 });
  const editor = (await d.eval("document.querySelectorAll('.cm-content').length")) - 1;
  await d.click(".cm-content", { nth: editor });
  await d.wait(600);
  for (let i = 0; i < 3; i++) {
    await d.keys("PageDown");
    await d.wait(900);
  }
  await d.keys("Ctrl+Home");
  await d.wait(1400);

  // --- workspace ---------------------------------------------------------
  d.mark("workspace");
  // A new workspace opens a shell in $HOME, and for the second or two before it
  // is sent somewhere real the tree, the tab label and the prompt all show the
  // operator's home directory. So: collapse the sidebar first, type the cd with
  // no per-character delay, and only caption once it has settled. The beat the
  // viewer reads is the project, never the home folder.
  await d.cmd("sidebar.toggle");
  await d.wait(900);
  await d.dismissToasts();
  await d.click("button[aria-label='New workspace']");
  await d.wait(1400);
  await d.command(`cd '${PROJECT}'`, { delay: 0 });
  await d.wait(900);
  await d.command("clear", { delay: 0 });
  await d.wait(500);
  await d.cmd("sidebar.toggle");
  await d.wait(1200);

  d.caption("A second workspace: its own tabs, its own folder", { seconds: 4 });
  await d.wait(3200);

  d.caption("Switch back, and the first one is exactly as you left it", { seconds: 4 });
  const first = await d.eval(`(() => {
    const root = document.querySelector('[data-testid=right-workspaces]');
    return [...root.querySelectorAll('button')].findIndex(
      (b) => ((b.getAttribute('aria-label') || b.textContent || '').trim()) === 'Workspace 1');
  })()`);
  if (first >= 0) {
    await d.click("[data-testid=right-workspaces] button", { nth: first });
    await d.wait(2600);
  }

  d.mark("outro");
  d.caption("TEDI", { seconds: 3 });
  await d.wait(2600);
}

/** Runs after the recording stops: put the workspace list back. */
export async function teardown(d) {
  await d.dismissToasts();
  const row = await d.eval(`(() => {
    const root = document.querySelector('[data-testid=right-workspaces]');
    if (!root) return -1;
    return [...root.querySelectorAll('button')].findIndex(
      (b) => ((b.getAttribute('aria-label') || b.textContent || '').trim()) === 'Workspace 2');
  })()`);
  // Hover first: the row shows a tab-count badge until the pointer is over it,
  // and Rename / Close sit underneath that badge.
  if (row >= 0) await d.hover("[data-testid=right-workspaces] button", { nth: row });
  const idx = await d.eval(closerFor("Workspace 2"));
  if (idx >= 0) {
    await d.click("[data-testid=right-workspaces] button", { nth: idx });
    await d.wait(1500);
    // Closing a workspace asks first, and it asks with role="alertdialog", not
    // role="dialog". Leaving that confirm unanswered is worse than not clicking
    // at all: its overlay puts `pointer-events: none` on the body, so every
    // later click anywhere is silently swallowed.
    const confirm = await d.eval(`(() => {
      const m = document.querySelector('[role=alertdialog][data-state=open]');
      if (!m) return -1;
      return [...m.querySelectorAll('button')].findIndex((b) => /^close workspace$/i.test((b.textContent || '').trim()));
    })()`);
    if (confirm >= 0) {
      await d.click("[role=alertdialog][data-state=open] button", { nth: confirm });
      await d.wait(1800);
    }
  }
  await onePane(d);
  await d.command(`cd '${PROJECT}'`, { delay: 8 });
  await d.wait(1600);
  await d.command("clear", { delay: 8 });
}
