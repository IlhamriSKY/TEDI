/**
 * Example take: the whole file loop a human does, driven from a script. Create
 * a file from the explorer, open it from the tree, type into the editor, save
 * it, and read the pane back to prove what is on screen.
 *
 *   pnpm director run scripts/director/takes/edit-file.mjs --rec edit --size 1920x1080
 *
 * Expects `director-take.md` not to exist yet; delete it between runs.
 */

const FILE = "director-take.md";

/** Newest editor: a freshly opened tab mounts last. */
async function newestEditor(d) {
  const count = await d.eval("document.querySelectorAll('.cm-content').length");
  return count - 1;
}

/** @param {import("../director.mjs").Director} d */
export default async function editFile(d) {
  d.caption("A new file, from the explorer", { seconds: 3 });
  await d.click("button[aria-label='New file']");
  await d.wait(900);
  // The inline rename input, not a dialog: type the name and commit it.
  await d.type(FILE, { delay: 55 });
  await d.keys("Enter");
  await d.wait(1600);

  d.mark("open");
  d.caption("Open it from the tree", { seconds: 2.5 });
  await d.click(`button[data-fs-path$="${FILE}"]`);
  await d.waitFor(".cm-content");
  await d.wait(900);

  d.mark("edit");
  d.caption("Type into the editor", { seconds: 3 });
  const nth = await newestEditor(d);
  await d.click(".cm-content", { nth });
  await d.wait(400);
  // A tab left open by an earlier run still holds its buffer even after the file
  // is deleted from disk, and clicking the tree entry re-focuses that tab rather
  // than opening a fresh one, so the take would type on top of old text. Clear
  // it the way a human would, which also makes the take safe to re-run.
  await d.keys("Ctrl+A", "Delete");
  await d.wait(300);
  await d.type("# Built in public\n\nCreated, opened and typed by the director.", { delay: 35 });
  await d.wait(1200);

  d.mark("save");
  d.caption("Ctrl+S writes it to disk", { seconds: 3 });
  await d.keys("Ctrl+S");
  await d.wait(1800);

  // Read the pane back, which is the check this take leaves behind: if the
  // editor does not hold what we typed, the take failed even though every
  // click "worked".
  const shown = await d.text(".cm-content", { nth });
  if (!shown.includes("Built in public")) {
    throw new Error(`Editor does not show the typed text. Pane holds: ${JSON.stringify(shown)}`);
  }
  return shown;
}
