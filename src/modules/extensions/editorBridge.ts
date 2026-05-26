/**
 * Runtime bridge that lets the extension host reach into the active editor
 * pane. App.tsx wires the live `activeEditorHandle` accessor on every
 * render so `host.ts` can expose `ctx.editor` without importing React or
 * walking the pane tree itself.
 *
 * `null` until App mounts. Calls before that return `null` so a very-early
 * extension activate degrades gracefully.
 */

export type ActiveEditorSnapshot = {
  /** Absolute path of the file in the active editor leaf. */
  path: string;
  /** Live (possibly dirty) buffer content. */
  content: string;
  /** True when the buffer diverges from the last-saved disk content. */
  dirty: boolean;
};

export type EditorBridge = {
  getActive(): ActiveEditorSnapshot | null;
  setActiveContent(content: string): boolean;
};

let bridge: EditorBridge | null = null;

export function setEditorBridge(next: EditorBridge | null): void {
  bridge = next;
}

export function getActiveEditor(): ActiveEditorSnapshot | null {
  return bridge?.getActive() ?? null;
}

export function setActiveEditorContent(content: string): boolean {
  return bridge?.setActiveContent(content) ?? false;
}
