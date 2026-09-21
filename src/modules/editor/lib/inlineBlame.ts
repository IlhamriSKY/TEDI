/**
 * Who last changed the line the cursor is on, as faint text at the end of that
 * line: `ilham, 3d ago · fix(git): ...`.
 *
 * One `git blame -L n,n` per cursor REST (600 ms after the last move), never
 * per keystroke and never on a timer, so an idle editor costs nothing. It is
 * shown only for a saved local file: an edited buffer's line numbers no longer
 * match what git knows, and an SSH file is on another machine. A file git
 * cannot blame (untracked, outside any repository) is not asked again for a
 * minute.
 */
import { formatRelTime } from "@/modules/scm/historyMeta";
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";

const REST_MS = 600;
const CACHE_MS = 30_000;
const UNBLAMEABLE_MS = 60_000;

/** One line of `git blame --porcelain` output as the text shown. Pure, for the verify. */
export function formatBlame(porcelain: string): string | null {
  const lines = porcelain.split("\n");
  const sha = lines[0]?.split(" ")[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  if (/^0+$/.test(sha)) return "Not committed yet";
  const field = (k: string) => lines.find((l) => l.startsWith(`${k} `))?.slice(k.length + 1) ?? "";
  const time = Number(field("author-time"));
  const when = Number.isFinite(time) && time > 0 ? formatRelTime(time) : "";
  const who = [field("author"), when].filter(Boolean).join(", ");
  // A release commit's subject can run to a thousand characters; the line end
  // is room for a glance, not the whole message.
  const raw = field("summary");
  const summary = raw.length > 72 ? `${raw.slice(0, 71).trimEnd()}…` : raw;
  return summary ? `${who} · ${summary}` : who;
}

const cache = new Map<string, { at: number; value: Promise<string | null> }>();
const unblameable = new Map<string, number>();

function blameLine(path: string, line: number): Promise<string | null> {
  const now = Date.now();
  const stop = unblameable.get(path);
  if (stop && now - stop < UNBLAMEABLE_MS) return Promise.resolve(null);
  const key = `${path}\u0000${line}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  // ponytail: wholesale clear instead of LRU; entries are one short string each.
  if (cache.size > 500) cache.clear();
  const dir = path.replace(/[\\/][^\\/]*$/, "") || path;
  const value = invoke<string>("git_run", {
    repoPath: dir,
    args: ["blame", "--porcelain", "-L", `${line},${line}`, "--", path],
  })
    .then(formatBlame)
    .catch(() => {
      unblameable.set(path, Date.now());
      return null;
    });
  cache.set(key, { at: now, value });
  return value;
}

/** Forget what git said about `path`: an edit moves every line after it. */
function forgetBlame(path: string): void {
  unblameable.delete(path);
  for (const k of cache.keys()) if (k.startsWith(`${path}\u0000`)) cache.delete(k);
}

const setBlame = StateEffect.define<{ line: number; text: string } | null>();

class BlameWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: BlameWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-inline-blame";
    el.textContent = this.text;
    return el;
  }
}

const blameField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (!e.is(setBlame)) continue;
      if (!e.value || e.value.line > tr.state.doc.lines) return Decoration.none;
      const at = tr.state.doc.line(e.value.line).to;
      return Decoration.set([
        Decoration.widget({ widget: new BlameWidget(e.value.text), side: 1 }).range(at),
      ]);
    }
    return tr.docChanged ? Decoration.none : deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const blameTheme = EditorView.baseTheme({
  ".cm-inline-blame": {
    marginLeft: "3em",
    color: "var(--muted-foreground)",
    opacity: "0.55",
    fontStyle: "italic",
    whiteSpace: "pre",
    pointerEvents: "none",
    userSelect: "none",
  },
});

export function inlineBlame(opts: {
  getPath: () => string;
  /** False for a remote file, an unsaved buffer, or with the setting off. */
  enabled: () => boolean;
}): Extension {
  const plugin = ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null;
      seq = 0;
      shown = false;

      constructor(readonly view: EditorView) {
        this.schedule();
      }

      update(u: ViewUpdate) {
        if (u.docChanged) forgetBlame(opts.getPath());
        if (u.selectionSet || u.docChanged || u.focusChanged) this.schedule();
      }

      schedule() {
        if (this.timer) clearTimeout(this.timer);
        const seq = ++this.seq;
        this.timer = setTimeout(() => void this.run(seq), REST_MS);
      }

      async run(seq: number) {
        const view = this.view;
        let next: { line: number; text: string } | null = null;
        if (opts.enabled() && view.hasFocus) {
          const line = view.state.doc.lineAt(view.state.selection.main.head).number;
          const text = await blameLine(opts.getPath(), line);
          if (seq !== this.seq) return;
          if (text) next = { line, text };
        }
        if (!next && !this.shown) return;
        this.shown = next !== null;
        view.dispatch({ effects: setBlame.of(next) });
      }

      destroy() {
        if (this.timer) clearTimeout(this.timer);
        this.seq++;
      }
    },
  );
  return [blameField, plugin, blameTheme];
}
