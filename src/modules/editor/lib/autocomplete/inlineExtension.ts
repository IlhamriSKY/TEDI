import {
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type PluginValue,
  type ViewUpdate,
} from "@codemirror/view";
import { isLoopbackBaseURL } from "@/modules/ai/config";
import { MAX_PREFIX, MAX_SUFFIX } from "./prompt";
import { requestCompletion, type CompletionDeps } from "./provider";

export type AutocompletePrefs = CompletionDeps & {
  enabled: boolean;
};

export type AutocompleteContext = {
  getPrefs: () => AutocompletePrefs;
  getPath: () => string | null;
  getLanguage: () => string | null;
};

type Suggestion = {
  from: number;
  text: string;
};

const setSuggestion = StateEffect.define<Suggestion | null>();

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestion)) return e.value;
    }
    if (!value) return value;
    if (tr.docChanged) {
      return consumeIfTypedAhead(value, tr);
    }
    if (tr.selection) return null;
    return value;
  },
});

function consumeIfTypedAhead(current: Suggestion, tr: Transaction): Suggestion | null {
  let consumed: string | null = null;
  let originDelta = 0;
  let abort = false;
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    if (abort) return;
    const ins = inserted.toString();
    if (fromA !== toA || fromA !== current.from || !ins) {
      abort = true;
      return;
    }
    if (current.text.startsWith(ins)) {
      consumed = ins;
      originDelta = ins.length;
    } else {
      abort = true;
    }
  });
  if (abort || !consumed) return null;
  const remaining = current.text.slice((consumed as string).length);
  if (!remaining) return null;
  return { from: current.from + originDelta, text: remaining };
}

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  override eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ai-ghost";
    const lines = this.text.split("\n");
    lines.forEach((line, i) => {
      if (i > 0) span.appendChild(document.createElement("br"));
      span.appendChild(document.createTextNode(line));
    });
    return span;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

const ghostTheme = EditorView.theme({
  ".cm-ai-ghost": {
    opacity: "0.45",
    fontStyle: "italic",
    pointerEvents: "none",
  },
});

const ghostDecorations = EditorView.decorations.compute([suggestionField], (state) => {
  const sug = state.field(suggestionField);
  if (!sug) return Decoration.none;
  return Decoration.set([
    Decoration.widget({
      widget: new GhostWidget(sug.text),
      side: 1,
    }).range(sug.from),
  ]);
});

const DEBOUNCE_MS = 350;
const CHAIN_DELAY_MS = 80;
const MIN_PREFIX_CHARS = 2;
const MAX_LINES = 6;
const CACHE_SIZE = 32;
const CACHE_TAIL = 512;
const CACHE_HEAD = 128;
// Slice exactly what the prompt will send. These used to be 4000/2000, i.e.
// double, and trimContext threw the other half away on every fire; nothing in
// between (the cache key, trimSuggestion) ever looked past this much.
const PREFIX_WINDOW = MAX_PREFIX;
const SUFFIX_WINDOW = MAX_SUFFIX;

class LRU<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly cap: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v === undefined) return undefined;
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k: K, v: V) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.cap) {
      const first = this.map.keys().next().value;
      if (first !== undefined) this.map.delete(first);
    }
  }
  clear() {
    this.map.clear();
  }
}

/** Cache key. The path belongs in it because the request already depends on it
 *  (`buildUserPrompt` sends `File: <name>`), and one driver instance outlives
 *  the file it was created for: EditorPane swaps `path` without remounting.
 *  Keying on content alone let two files that agree on the bytes around the
 *  cursor - identical import headers, an empty new file - serve each other's
 *  ghost text. */
function suggestionKey(
  prefix: string,
  suffix: string,
  lang: string | null,
  path: string | null,
): string {
  const p = prefix.length > CACHE_TAIL ? prefix.slice(-CACHE_TAIL) : prefix;
  const s = suffix.length > CACHE_HEAD ? suffix.slice(0, CACHE_HEAD) : suffix;
  return `${path ?? ""}\x1f${lang ?? ""}${p}\x1f${s}`;
}

/** Is this provider ready to be called? A keyless local server needs a reachable
 *  base URL instead of a key, so gating purely on `apiKey` would silently
 *  disable ghost text for every local BYOK setup. */
function hasProviderKey(prefs: AutocompletePrefs): boolean {
  if (prefs.provider === "lmstudio") return !!prefs.lmstudioBaseURL;
  if (prefs.apiKey) return true;
  // A local OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM) authenticates
  // with nothing; treat a configured loopback base URL as credentials enough.
  return (
    prefs.provider === "openai-compatible" &&
    isLoopbackBaseURL(prefs.openaiCompatibleBaseURL ?? "")
  );
}

function shouldTrigger(state: EditorState, prefs: AutocompletePrefs, isManual: boolean): boolean {
  if (!prefs.enabled) return false;
  if (!hasProviderKey(prefs)) return false;
  const sel = state.selection.main;
  if (sel.from !== sel.to) return false;
  if (isManual) return true;

  const cursor = sel.from;
  const doc = state.doc;
  if (doc.length === 0) return false;

  // Skip if cursor is in the middle of an identifier - typing ghost mid-word
  // is the most disruptive failure mode.
  if (cursor < doc.length) {
    const next = doc.sliceString(cursor, cursor + 1);
    if (next && /[\w$]/.test(next)) return false;
  }

  // Require some non-whitespace context within the recent prefix window.
  const recent = doc.sliceString(Math.max(0, cursor - 200), cursor);
  if (recent.replace(/\s/g, "").length < MIN_PREFIX_CHARS) return false;

  return true;
}

class CompletionDriver implements PluginValue {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private inflightKey: string | null = null;
  private cache = new LRU<string, string>(CACHE_SIZE);

  constructor(
    private readonly view: EditorView,
    private readonly ctx: AutocompleteContext,
  ) {}

  update(u: ViewUpdate) {
    if (!u.docChanged && !u.selectionSet) return;

    let typed = false;
    let chained = false;
    let isDelete = false;
    let isUndo = false;
    for (const tr of u.transactions) {
      const ev = tr.annotation(Transaction.userEvent);
      if (!ev) continue;
      if (ev.startsWith("input.complete.ai")) chained = true;
      // A paste or drop is not typing. Dropping 400 lines in used to schedule a
      // completion for a cursor the user is not sitting at.
      else if (ev.startsWith("input.paste") || ev.startsWith("input.drop")) isDelete = true;
      else if (ev.startsWith("input")) typed = true;
      else if (ev.startsWith("delete")) isDelete = true;
      else if (ev === "undo" || ev === "redo") isUndo = true;
    }

    // Deletes, undo/redo, paste and drop all invalidate pending work without
    // implying the user wants a suggestion for the new position.
    if (isDelete || isUndo) {
      this.cancelTimer();
      this.cancelInFlight();
      return;
    }

    if (chained) {
      // After accept/accept-word, fire again with a short delay so the next
      // suggestion is ready as soon as the user looks up.
      this.schedule(false, CHAIN_DELAY_MS);
      return;
    }

    if (u.docChanged && typed) {
      this.schedule(false);
      return;
    }

    if (u.selectionSet && !u.docChanged) {
      // Pure cursor move - drop pending work, ghost is cleared by the field.
      this.cancelTimer();
      this.cancelInFlight();
    }
  }

  manualTrigger() {
    this.schedule(true);
  }

  private schedule(isManual: boolean, delayOverride?: number) {
    this.cancelTimer();
    // Whatever is in flight was requested for a cursor position that no longer
    // exists, so its result is already guaranteed to be discarded by
    // applyResult's position check. Aborting here stops paying for a token
    // stream nobody can ever see; previously it ran to completion and was only
    // cancelled by the NEXT fire, i.e. one wasted request per typing pause.
    this.cancelInFlight();
    const delay = delayOverride ?? (isManual ? 0 : DEBOUNCE_MS);
    this.timer = setTimeout(() => void this.fire(isManual), delay);
  }

  private cancelTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private cancelInFlight() {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
      this.inflightKey = null;
    }
  }

  private clearGhost() {
    if (this.view.state.field(suggestionField)) {
      this.view.dispatch({ effects: setSuggestion.of(null) });
    }
  }

  destroy() {
    this.cancelInFlight();
    this.cancelTimer();
  }

  private async fire(isManual: boolean) {
    const prefs = this.ctx.getPrefs();
    const state = this.view.state;
    if (!shouldTrigger(state, prefs, isManual)) return;

    const cursor = state.selection.main.from;
    const doc = state.doc;
    const prefix = doc.sliceString(Math.max(0, cursor - PREFIX_WINDOW), cursor);
    const suffix = doc.sliceString(cursor, Math.min(doc.length, cursor + SUFFIX_WINDOW));

    const lang = this.ctx.getLanguage();
    const path = this.ctx.getPath();
    const key = suggestionKey(prefix, suffix, lang, path);

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.applyResult(cached, cursor);
      return;
    }

    if (this.inflightKey === key) return;
    this.cancelInFlight();
    const controller = new AbortController();
    this.controller = controller;
    this.inflightKey = key;
    const signal = controller.signal;

    let raw = "";
    try {
      raw = await requestCompletion(
        {
          prefix,
          suffix,
          filename: path,
          language: lang,
        },
        prefs,
        signal,
      );
    } catch (err) {
      if (signal.aborted) return;
      // Ghost text has no error surface by design (a toast per keystroke would
      // be unusable), but swallowing silently made every distinct failure look
      // identical: a rejected sampling param, a 404 on a mistyped model id, a
      // 401 from the wrong key. One console line keeps the UI quiet and still
      // makes a misconfiguration diagnosable.
      console.debug("[autocomplete] request failed:", err);
      if (this.controller === controller) {
        this.controller = null;
        this.inflightKey = null;
      }
      return;
    }
    if (signal.aborted) return;
    if (this.controller === controller) {
      this.controller = null;
      this.inflightKey = null;
    }

    const trimmed = trimSuggestion(raw, prefix, suffix);
    // Only cache non-empty: empty often comes from a flaky reasoning-only
    // response, not from "no completion exists here." Letting it retry next
    // time is cheaper than persistently showing nothing.
    if (trimmed) this.cache.set(key, trimmed);
    this.applyResult(trimmed, cursor);
  }

  private applyResult(text: string, cursor: number) {
    if (!text) {
      this.clearGhost();
      return;
    }
    const sel = this.view.state.selection.main;
    if (sel.from !== cursor || sel.to !== cursor) return;
    this.view.dispatch({
      effects: setSuggestion.of({ from: cursor, text }),
    });
  }
}

function trimSuggestion(raw: string, prefix: string, suffix: string): string {
  if (!raw) return "";
  let t = raw;

  // Drop wrapping markdown fences if the model added them.
  const fence = t.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  if (fence) t = fence[1];
  t = t.replace(/^<\|cursor\|>/, "");

  // Strip prefix-tail overlap: if PREFIX ends with a partial token "te" and
  // the model returned "test", drop the leading "te" so the ghost shows "st".
  const tailMatch = prefix.match(/[\w$]+$/);
  if (tailMatch) {
    const tail = tailMatch[0];
    for (let n = Math.min(tail.length, t.length); n > 0; n--) {
      if (t.slice(0, n) === tail.slice(tail.length - n)) {
        t = t.slice(n);
        break;
      }
    }
  }

  // Cap to a reasonable line count.
  const lines = t.split("\n");
  if (lines.length > MAX_LINES) t = lines.slice(0, MAX_LINES).join("\n");

  // Drop trailing overlap with suffix (model sometimes echoes what's ahead).
  const maxOverlap = Math.min(t.length, suffix.length);
  for (let n = maxOverlap; n > 0; n--) {
    if (t.slice(t.length - n) === suffix.slice(0, n)) {
      t = t.slice(0, t.length - n);
      break;
    }
  }

  // Strip leading indent that's already typed on the current line.
  const lastNl = prefix.lastIndexOf("\n");
  const lineSoFar = prefix.slice(lastNl + 1);
  if (lineSoFar.length > 0 && /^\s+$/.test(lineSoFar) && t.startsWith(lineSoFar)) {
    t = t.slice(lineSoFar.length);
  }

  // If suggestion is just a duplicate of what's already typed on the line, skip.
  if (lineSoFar && t.trimStart() === lineSoFar.trimStart()) return "";

  t = t.replace(/\s+$/, "");

  // If PREFIX's last line ends with an opening delimiter (`{`, `[`, `(`, `=>`)
  // and the suggestion is a body (multi-line OR starts with indent), prepend
  // a newline so the body doesn't land on the same line as the brace.
  if (
    t &&
    !t.startsWith("\n") &&
    /(?:[{[(]|=>)\s*$/.test(lineSoFar) &&
    (t.includes("\n") || /^\s/.test(t))
  ) {
    t = "\n" + t;
  }

  return t;
}

function acceptSuggestion(view: EditorView): boolean {
  const sug = view.state.field(suggestionField, false);
  if (!sug) return false;
  view.dispatch({
    changes: { from: sug.from, to: sug.from, insert: sug.text },
    selection: { anchor: sug.from + sug.text.length },
    effects: setSuggestion.of(null),
    userEvent: "input.complete.ai",
  });
  return true;
}

function acceptWord(view: EditorView): boolean {
  const sug = view.state.field(suggestionField, false);
  if (!sug) return false;
  // Take the next contiguous chunk: leading whitespace + one word OR one
  // punctuation run. Falls back to whole-suggestion if nothing matches.
  const m =
    sug.text.match(/^\s*[\w$]+/) ?? sug.text.match(/^\s*[^\w\s$]+/) ?? sug.text.match(/^\s+/);
  if (!m) return acceptSuggestion(view);
  const chunk = m[0];
  const remaining = sug.text.slice(chunk.length);
  view.dispatch({
    changes: { from: sug.from, to: sug.from, insert: chunk },
    selection: { anchor: sug.from + chunk.length },
    effects: setSuggestion.of(
      remaining ? { from: sug.from + chunk.length, text: remaining } : null,
    ),
    userEvent: "input.complete.ai",
  });
  return true;
}

function dismissSuggestion(view: EditorView): boolean {
  const sug = view.state.field(suggestionField, false);
  if (!sug) return false;
  view.dispatch({ effects: setSuggestion.of(null) });
  return true;
}

export function inlineCompletion(ctx: AutocompleteContext): Extension {
  const plugin = ViewPlugin.define((view) => new CompletionDriver(view, ctx));

  const manualTrigger = (view: EditorView): boolean => {
    const inst = view.plugin(plugin);
    if (!inst) return false;
    inst.manualTrigger();
    return true;
  };

  return [
    suggestionField,
    ghostDecorations,
    ghostTheme,
    plugin,
    Prec.highest(
      keymap.of([
        { key: "Tab", run: acceptSuggestion },
        { key: "Escape", run: dismissSuggestion },
        { key: "Mod-ArrowRight", run: acceptWord },
        { key: "Alt-\\", run: manualTrigger },
      ]),
    ),
  ];
}
