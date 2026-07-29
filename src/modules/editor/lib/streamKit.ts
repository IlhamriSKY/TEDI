/**
 * Builders and shared tokenizer hooks for the hand-rolled grammars in
 * `./streamLanguages` and `./lineLanguages`.
 *
 * Two zero-dependency builders carry every language, which matters because the
 * lockfile's trust policy blocks `pnpm add`:
 *  - {@link mk} wraps the already-bundled, configurable `clike` stream factory
 *    (the same one backing the built-in C / C++ / C# modes). Despite the name it
 *    is a plain tokenizer, so it also fits indentation-significant languages
 *    (Nim, Mojo, Vyper) once `indentStatements` is off - only auto-indent
 *    depends on braces, never the coloring.
 *  - `simpleMode()` (also from `legacy-modes`) covers the shapes clike cannot
 *    tokenize at all - line-oriented grammars like Makefile or Batch. Those live
 *    in `./lineLanguages`, which defines its own `SIMPLE_TAIL` catch-all rules.
 *
 * Every grammar is a `StreamParser`. `resolveLanguage` (editor) wraps it in
 * `StreamLanguage.define`; the AI-chat highlighter consumes it directly. Both
 * paths read the same CM5-style token strings ("keyword", "type", "builtin",
 * "atom", "string", "comment", "number", "operator", "meta", "def",
 * "variable-2", "tag"), which the editor's `StreamLanguage` default table and
 * the chat `mapStreamTag` both map onto the standard `@lezer/highlight` tags
 * the active theme colors.
 */

import { clike } from "@codemirror/legacy-modes/mode/clike";
import type { StreamParser, StringStream } from "@codemirror/language";

// clike's runtime accepts a handful of config keys its bundled `.d.ts` omits
// (`defKeywords`, `typeFirstDefinitions`, `languageData`). Widen the parameter
// type so we can pass them without `any`, exactly how the upstream c/cpp/csharp
// definitions are configured.
type ClikeConf = Parameters<typeof clike>[0] & {
  defKeywords?: Record<string, boolean>;
  typeFirstDefinitions?: boolean;
  languageData?: Record<string, unknown>;
};

export type WordSet = Record<string, boolean>;

/** Build a lookup set from a whitespace-separated word list. */
export function words(list: string): WordSet {
  const obj: WordSet = {};
  for (const w of list.split(/\s+/)) if (w) obj[w] = true;
  return obj;
}

/**
 * What a grammar below actually writes: the five word lists as plain
 * whitespace-separated strings (newlines included, so a long list just wraps),
 * plus whatever else clike accepts. {@link mk} does the set conversion.
 */
export type LangConf = Omit<
  ClikeConf,
  "keywords" | "types" | "builtin" | "atoms" | "defKeywords"
> & {
  keywords?: string;
  types?: string | WordSet;
  builtin?: string;
  atoms?: string;
  defKeywords?: string;
};

const WORD_FIELDS = ["keywords", "types", "builtin", "atoms", "defKeywords"] as const;

// Minimal view of clike's mutable per-parse state that our hooks touch. clike
// drives a tokenizer via `state.tokenize`; a hook sets it to take over the
// stream across characters (and across lines for block constructs), then
// resets it to `null` to hand control back to clike's base tokenizer.
export type Tokenizer = (stream: StringStream, state: HookState) => string;
export interface HookState {
  tokenize: Tokenizer | null;
  prevToken?: string | null;
  [key: string]: unknown;
}

/**
 * Build a clike-based parser. Word lists arrive as strings and are converted
 * here; `number` and `indentSwitch` carry the defaults nearly every grammar
 * below wants (C-style literals, and no extra `switch` indent since most of
 * these languages have no C-style switch at all), so only the exceptions say
 * so. A `types` value that is already a set (a generated family like
 * Solidity's `uint8…uint256`) passes through untouched.
 */
export function mk(conf: LangConf): StreamParser<unknown> {
  const out: ClikeConf = { number: NUM_CLIKE, indentSwitch: false, ...(conf as ClikeConf) };
  for (const field of WORD_FIELDS) {
    const v = conf[field];
    if (typeof v === "string") out[field] = words(v);
  }
  return clike(out);
}

// ── Shared hook helpers ──────────────────────────────────────────────────

/** `@attr` / `@(...)` style annotation - colored as meta. */
export function atMeta(stream: StringStream): string {
  stream.eatWhile(/[\w]/);
  return "meta";
}

/**
 * Rust-style `#[attribute(...)]` (Move, Cairo). The whole bracketed run is one
 * meta token; a bare `#word` falls back to the plain annotation shape.
 */
export function hashAttr(stream: StringStream): string {
  if (stream.eat("[")) {
    stream.eatWhile(/[^\]\n]/);
    stream.eat("]");
  } else {
    stream.eatWhile(/[\w]/);
  }
  return "meta";
}

/** Nested `/* ... *​/` block comment (Odin, unlike C, allows nesting). */
function nestedSlashComment(depth: number): Tokenizer {
  return (stream, state) => {
    for (;;) {
      const ch = stream.next();
      if (ch == null) break; // EOL - stay in this tokenizer on the next line
      if (ch === "*" && stream.eat("/")) {
        if (depth === 1) {
          state.tokenize = null;
          break;
        }
        state.tokenize = nestedSlashComment(depth - 1);
        return state.tokenize(stream, state);
      } else if (ch === "/" && stream.eat("*")) {
        state.tokenize = nestedSlashComment(depth + 1);
        return state.tokenize(stream, state);
      }
    }
    return "comment";
  };
}

/**
 * `/` hook enabling nested block comments while leaving `//` line comments and
 * the division operator to clike's default `/` handling (returns `false`).
 */
export function slashHook(stream: StringStream, state: HookState): string | false {
  if (stream.eat("*")) {
    state.tokenize = nestedSlashComment(1);
    return state.tokenize(stream, state);
  }
  return false;
}

// Not exported: `mk` and `pyLike` apply these, so no grammar names them.
const NUM_CLIKE =
  /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[\d_]+\.?[\d_]*|\.[\d_]+)(?:[eE][-+]?[\d_]+)?)/;

/** Python-family literals: same as {@link NUM_CLIKE} plus an imaginary suffix. */
const NUM_PY =
  /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[\d_]+\.?[\d_]*|\.[\d_]+)(?:[eE][-+]?[\d_]+)?[jJ]?)/;

/** `# …` line comment (Python family, Nix, Elixir, Awk, Nushell, …). */
export function hashComment(stream: StringStream): string {
  stream.skipToEnd();
  return "comment";
}

/** `-- …` line comment (Ada, Lean). Falls through so `-` stays an operator. */
export function dashComment(stream: StringStream): string | false {
  if (stream.eat("-")) {
    stream.skipToEnd();
    return "comment";
  }
  return false;
}

/** `$name` interpolation / variable reference. */
export function dollarVar(stream: StringStream): string {
  stream.eatWhile(/[\w]/);
  return "variable-2";
}

/**
 * Tokenizer for a triple-quoted string body (`"""…"""`, `'''…'''`). The opener
 * is already consumed; the parser stays in this state across lines until the
 * matching close, which is what makes multi-line docstrings hold their color.
 */
function tripleQuote(q: string): Tokenizer {
  const close = q + q + q;
  return (stream, state) => {
    while (!stream.eol()) {
      if (stream.match(close)) {
        state.tokenize = null;
        return "string";
      }
      stream.next();
    }
    return "string";
  };
}

/**
 * `"` / `'` hook that opens a triple-quoted string. clike consumed the first
 * quote, so only the remaining two are matched here; anything else returns
 * `false` and clike's ordinary single-line string handling takes over.
 */
export function tripleHook(q: string) {
  const tokenizer = tripleQuote(q);
  return (stream: StringStream, state: HookState): string | false => {
    if (stream.match(q + q)) {
      state.tokenize = tokenizer;
      return tokenizer(stream, state);
    }
    return false;
  };
}

/**
 * Shared shape for the Python-derived languages (Mojo, Vyper, Starlark): `#`
 * comments, triple-quoted strings, `@decorator`, no brace-driven indentation.
 * Callers supply only the word lists.
 */
export function pyLike(conf: LangConf): StreamParser<unknown> {
  return mk({
    number: NUM_PY,
    indentStatements: false,
    ...conf,
    hooks: {
      "#": hashComment,
      '"': tripleHook('"'),
      "'": tripleHook("'"),
      "@": atMeta,
      ...(conf.hooks ?? {}),
    },
  });
}

/** `int8 int16 … int256` / `uint8 … uint256` style sized-integer families. */
export function sizedInts(prefixes: string[], step: number, max: number): string[] {
  const out: string[] = [];
  for (let i = step; i <= max; i += step) for (const p of prefixes) out.push(p + i);
  return out;
}
