/**
 * Hand-rolled syntax highlighters for modern languages that ship no upstream
 * CodeMirror parser (`@codemirror/lang-*`) and no `@codemirror/legacy-modes`
 * entry: Odin, Zig, Nim, Solidity, Gleam, Hare.
 *
 * Each is built on the already-bundled, configurable `clike` stream factory
 * (the same one that backs the built-in C / C++ / C# modes), so adding these
 * costs only config - zero new dependencies, which matters because the
 * lockfile's trust policy blocks `pnpm add`.
 *
 * Every export is a `StreamParser`. `resolveLanguage` (editor) wraps it in
 * `StreamLanguage.define`; the AI-chat highlighter consumes it directly. Both
 * paths read the same CM5-style token strings ("keyword", "type", "builtin",
 * "atom", "string", "comment", "number", "operator", "meta", "def"), which the
 * editor's `StreamLanguage` default table and the chat `mapStreamTag` both map
 * onto the standard `@lezer/highlight` tags the active theme colors.
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

type WordSet = Record<string, boolean>;

/** Build a lookup set from a whitespace-separated word list. */
function words(list: string): WordSet {
  const obj: WordSet = {};
  for (const w of list.split(/\s+/)) if (w) obj[w] = true;
  return obj;
}

// Minimal view of clike's mutable per-parse state that our hooks touch. clike
// drives a tokenizer via `state.tokenize`; a hook sets it to take over the
// stream across characters (and across lines for block constructs), then
// resets it to `null` to hand control back to clike's base tokenizer.
type Tokenizer = (stream: StringStream, state: HookState) => string;
interface HookState {
  tokenize: Tokenizer | null;
  prevToken?: string | null;
  [key: string]: unknown;
}

function mk(conf: ClikeConf): StreamParser<unknown> {
  return clike(conf);
}

// ── Shared hook helpers ──────────────────────────────────────────────────

/** `@attr` / `@(...)` style annotation - colored as meta. */
function atMeta(stream: StringStream): string {
  stream.eatWhile(/[\w]/);
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
function slashHook(stream: StringStream, state: HookState): string | false {
  if (stream.eat("*")) {
    state.tokenize = nestedSlashComment(1);
    return state.tokenize(stream, state);
  }
  return false;
}

const NUM_CLIKE =
  /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[\d_]+\.?[\d_]*|\.[\d_]+)(?:[eE][-+]?[\d_]+)?)/;

// ── Odin ─────────────────────────────────────────────────────────────────
// https://odin-lang.org - braces, `//` + nested `/* */`, "..." / '...' /
// `...` (raw), `#directive`, `@attribute`.

const tokenOdinRaw: Tokenizer = (stream, state) => {
  for (;;) {
    const ch = stream.next();
    if (ch == null) break; // raw backtick strings may span lines
    if (ch === "`") {
      state.tokenize = null;
      break;
    }
  }
  return "string";
};

export const odin = mk({
  name: "odin",
  keywords: words(
    "asm auto_cast bit_field bit_set break case cast context continue defer " +
      "distinct do dynamic else enum fallthrough for foreign if import in map " +
      "matrix not_in or_break or_continue or_else or_return package proc return " +
      "struct switch transmute typeid union using when where",
  ),
  types: words(
    "bool b8 b16 b32 b64 int i8 i16 i32 i64 i128 uint u8 u16 u32 u64 u128 " +
      "uintptr i16le i32le i64le i128le u16le u32le u64le u128le i16be i32be " +
      "i64be i128be u16be u32be u64be u128be f16 f32 f64 f16le f32le f64le " +
      "f16be f32be f64be complex32 complex64 complex128 quaternion64 " +
      "quaternion128 quaternion256 rune string cstring rawptr typeid any byte",
  ),
  builtin: words(
    "len cap size_of align_of offset_of type_of type_info_of typeid_of swizzle " +
      "complex quaternion real imag jmag kmag conj expand_values min max abs " +
      "clamp soa_zip soa_unzip make new free delete append copy assert panic raw_data",
  ),
  atoms: words("true false nil"),
  number: NUM_CLIKE,
  indentSwitch: false,
  hooks: {
    "#": (stream: StringStream) => {
      stream.eatWhile(/[\w]/);
      return "meta";
    },
    "@": atMeta,
    "`": (stream: StringStream, state: HookState) => {
      state.tokenize = tokenOdinRaw;
      return tokenOdinRaw(stream, state);
    },
    "/": slashHook,
  },
});

// ── Zig ────────────────────────────────────────────────────────────────────
// https://ziglang.org - braces, `//` only (no block comments), `@builtin`
// functions, and `\\`-prefixed multiline string lines.

export const zig = mk({
  name: "zig",
  keywords: words(
    "addrspace align allowzero and anyframe anytype asm async await break " +
      "callconv catch comptime const continue defer else enum errdefer error " +
      "export extern fn for if inline noalias noinline nosuspend opaque or " +
      "orelse packed pub resume return linksection struct suspend switch test " +
      "threadlocal try union unreachable usingnamespace var volatile while",
  ),
  types: words(
    "bool void noreturn type anyerror anyopaque comptime_int comptime_float " +
      "isize usize i8 u8 i16 u16 i29 i32 u32 i64 u64 i128 u128 f16 f32 f64 f80 " +
      "f128 c_char c_short c_ushort c_int c_uint c_long c_ulong c_longlong " +
      "c_ulonglong c_longdouble",
  ),
  atoms: words("true false null undefined"),
  defKeywords: words("fn"),
  number: NUM_CLIKE,
  indentSwitch: false,
  hooks: {
    // `@import`, `@as`, `@intCast`, etc. - built-in functions.
    "@": (stream: StringStream) => {
      stream.eatWhile(/[\w]/);
      return "builtin";
    },
    // A line whose first non-space token is `\\` is a multiline string literal
    // that runs to end of line (clike consumed the first backslash already).
    "\\": (stream: StringStream): string | false => {
      if (stream.eat("\\")) {
        stream.skipToEnd();
        return "string";
      }
      return false;
    },
  },
});

// ── Nim ────────────────────────────────────────────────────────────────────
// https://nim-lang.org - `#` line comments, nested `#[ ]#` block comments,
// triple-quoted and `r"..."` raw strings. Indentation-significant, but that
// only affects auto-indent, not tokenization.

function nimNestedComment(depth: number): Tokenizer {
  return (stream, state) => {
    for (;;) {
      const ch = stream.next();
      if (ch == null) break;
      if (ch === "]" && stream.eat("#")) {
        if (depth === 1) {
          state.tokenize = null;
          break;
        }
        state.tokenize = nimNestedComment(depth - 1);
        return state.tokenize(stream, state);
      } else if (ch === "#" && stream.eat("[")) {
        state.tokenize = nimNestedComment(depth + 1);
        return state.tokenize(stream, state);
      }
    }
    return "comment";
  };
}

const tokenNimTriple: Tokenizer = (stream, state) => {
  while (!stream.eol()) {
    if (stream.match('"""')) {
      state.tokenize = null;
      return "string";
    }
    stream.next();
  }
  return "string";
};

export const nim = mk({
  name: "nim",
  keywords: words(
    "addr and as asm bind block break case cast concept const continue " +
      "converter defer discard distinct div do elif else end enum except export " +
      "finally for from func if import include interface is isnot iterator let " +
      "macro method mixin mod not notin object of or out proc ptr raise ref " +
      "return shl shr static template try tuple type using var when while xor yield",
  ),
  types: words(
    "int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float float32 " +
      "float64 bool char string cstring pointer void auto any seq array openArray " +
      "openarray varargs set range byte Natural Positive Ordinal SomeInteger " +
      "SomeFloat SomeNumber SomeOrdinal",
  ),
  builtin: words(
    "echo len add new newSeq result inc dec high low ord chr abs min max swap " + "items pairs",
  ),
  atoms: words("true false nil on off"),
  defKeywords: words("proc func template macro iterator method converter type"),
  number:
    /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[\d_]+\.?[\d_]*|\.[\d_]+)(?:[eE][-+]?[\d_]+)?(?:'?[iIuUfF]\d*)?)/,
  indentStatements: false,
  indentSwitch: false,
  hooks: {
    "#": (stream: StringStream, state: HookState): string => {
      if (stream.eat("[")) {
        state.tokenize = nimNestedComment(1);
        return state.tokenize(stream, state);
      }
      stream.skipToEnd();
      return "comment";
    },
    '"': (stream: StringStream, state: HookState): string | false => {
      if (stream.match('""')) {
        state.tokenize = tokenNimTriple;
        return tokenNimTriple(stream, state);
      }
      return false; // single-line string handled by clike's default
    },
    r: nimRawString,
    R: nimRawString,
  },
});

/** Nim raw string: `r"..."` where backslash is not special. */
function nimRawString(stream: StringStream): string | false {
  if (stream.peek() === '"') {
    stream.next();
    for (;;) {
      const ch = stream.next();
      if (ch == null || ch === '"') break;
    }
    return "string";
  }
  return false; // `r` is an ordinary identifier start
}

// ── Solidity ───────────────────────────────────────────────────────────────
// https://soliditylang.org - C-like: braces, `//` + `/* */`, "..." / '...'.

const solidityTypes = (() => {
  const list = ["address", "bool", "string", "bytes", "byte", "int", "uint", "fixed", "ufixed"];
  for (let i = 8; i <= 256; i += 8) list.push("int" + i, "uint" + i);
  for (let i = 1; i <= 32; i += 1) list.push("bytes" + i);
  return words(list.join(" "));
})();

export const solidity = mk({
  name: "solidity",
  keywords: words(
    "pragma solidity import as from using abstract contract interface library " +
      "is public private internal external pure view payable virtual override " +
      "returns return function modifier event error constructor fallback receive " +
      "struct enum mapping if else for while do break continue throw emit new " +
      "delete try catch revert assembly unchecked type immutable constant " +
      "storage memory calldata indexed anonymous",
  ),
  types: solidityTypes,
  builtin: words(
    "msg block tx abi this super now blockhash gasleft keccak256 sha256 sha3 " +
      "ripemd160 ecrecover addmod mulmod selfdestruct require assert revert",
  ),
  atoms: words("true false wei gwei ether seconds minutes hours days weeks"),
  defKeywords: words("contract interface library struct enum event error function modifier"),
  number: NUM_CLIKE,
  typeFirstDefinitions: true,
});

// ── Gleam ──────────────────────────────────────────────────────────────────
// https://gleam.run - braces, `//` line comments only, "..." strings,
// `@attribute`. Type and constructor names are uppercase-leading.

export const gleam = mk({
  name: "gleam",
  keywords: words(
    "as assert case const fn if import let opaque panic pub todo type use auto " +
      "delegate derive echo else implement macro test",
  ),
  types: words("Int Float String Bool Nil List Result Option BitArray Dynamic Bytes Order"),
  atoms: words("True False Nil Ok Error"),
  defKeywords: words("fn type const"),
  number: NUM_CLIKE,
  indentSwitch: false,
  hooks: {
    "@": atMeta,
    // Treat uppercase-leading identifiers as types (constructors / type names).
    token: (stream: StringStream, _state: HookState, style: string): string | undefined => {
      if (style === "variable" && /^[A-Z]/.test(stream.current())) return "type";
      return undefined;
    },
  },
});

// ── Hare ───────────────────────────────────────────────────────────────────
// https://harelang.org - C-like: braces, `//` line comments, "..." strings.

export const hare = mk({
  name: "hare",
  keywords: words(
    "as break case const continue def defer else enum export fn for if is let " +
      "match nullable return static struct switch type union use yield",
  ),
  types: words(
    "i8 i16 i32 i64 int u8 u16 u32 u64 uint uintptr size f32 f64 bool char str " +
      "rune void never opaque valist",
  ),
  builtin: words(
    "len offset align alloc free append delete insert abort assert vastart " + "vaarg vaend",
  ),
  atoms: words("true false null"),
  defKeywords: words("fn type struct union enum"),
  number: NUM_CLIKE,
  indentSwitch: false,
});
