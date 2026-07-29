/**
 * Hand-rolled grammars for languages that ship no upstream CodeMirror parser
 * (`@codemirror/lang-*`) and no `@codemirror/legacy-modes` entry - Odin, Zig,
 * Nim, Mojo, Move, Cairo, Nix, Elixir, WGSL and friends. All of them are built
 * on `mk` / `pyLike` from `./streamKit`; the line-oriented ones (Makefile,
 * Batch, Vimscript, ...) live in `./lineLanguages` instead.
 *
 * Word lists are whitespace-separated strings - `mk` turns them into lookup
 * sets - and are kept current with each language's own reference (linked above
 * each block). Deprecated-but-still-compiling spellings stay listed so older
 * sources keep their coloring.
 */

import { asn1 as asn1Mode } from "@codemirror/legacy-modes/mode/asn1";
import type { StringStream } from "@codemirror/language";
import {
  atMeta,
  dashComment,
  dollarVar,
  hashAttr,
  hashComment,
  mk,
  pyLike,
  sizedInts,
  slashHook,
  tripleHook,
  words,
  type HookState,
  type Tokenizer,
} from "./streamKit";

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
  keywords: `asm auto_cast bit_field bit_set break case cast context continue defer distinct
    do dynamic else enum fallthrough for foreign if import in map matrix not_in or_break
    or_continue or_else or_return package proc return struct switch transmute typeid union using
    when where`,
  types: `bool b8 b16 b32 b64 int i8 i16 i32 i64 i128 uint u8 u16 u32 u64 u128 uintptr
    i16le i32le i64le i128le u16le u32le u64le u128le i16be i32be i64be i128be u16be u32be u64be
    u128be f16 f32 f64 f16le f32le f64le f16be f32be f64be complex32 complex64 complex128
    quaternion64 quaternion128 quaternion256 rune string cstring rawptr typeid any byte`,
  builtin: `len cap size_of align_of offset_of type_of type_info_of typeid_of swizzle
    complex quaternion real imag jmag kmag conj expand_values min max abs clamp soa_zip
    soa_unzip make new free delete append copy assert panic raw_data`,
  atoms: `true false nil`,
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
  keywords: `addrspace align allowzero and anyframe anytype asm async await break callconv
    catch comptime const continue defer else enum errdefer error export extern fn for if inline
    noalias noinline nosuspend opaque or orelse packed pub resume return linksection struct
    suspend switch test threadlocal try union unreachable usingnamespace var volatile while`,
  types: `bool void noreturn type anyerror anyopaque comptime_int comptime_float isize
    usize i8 u8 i16 u16 i29 i32 u32 i64 u64 i128 u128 f16 f32 f64 f80 f128 c_char c_short
    c_ushort c_int c_uint c_long c_ulong c_longlong c_ulonglong c_longdouble`,
  atoms: `true false null undefined`,
  defKeywords: `fn`,
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

export const nim = mk({
  name: "nim",
  keywords: `addr and as asm bind block break case cast concept const continue converter
    defer discard distinct div do elif else end enum except export finally for from func if
    import include interface is isnot iterator let macro method mixin mod not notin object of or
    out proc ptr raise ref return shl shr static template try tuple type using var when while
    xor yield`,
  types: `int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float float32 float64
    bool char string cstring pointer void auto any seq array openArray openarray varargs set
    range byte Natural Positive Ordinal SomeInteger SomeFloat SomeNumber SomeOrdinal`,
  builtin: `echo len add new newSeq result inc dec high low ord chr abs min max swap items
    pairs`,
  atoms: `true false nil on off`,
  defKeywords: `proc func template macro iterator method converter type`,
  number:
    /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:[\d_]+\.?[\d_]*|\.[\d_]+)(?:[eE][-+]?[\d_]+)?(?:'?[iIuUfF]\d*)?)/,
  indentStatements: false,
  hooks: {
    "#": (stream: StringStream, state: HookState): string => {
      if (stream.eat("[")) {
        state.tokenize = nimNestedComment(1);
        return state.tokenize(stream, state);
      }
      stream.skipToEnd();
      return "comment";
    },
    '"': tripleHook('"'),
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
// https://docs.soliditylang.org - C-like: braces, `//` + `/* */`, "..." /
// '...'. Current through 0.8.3x: `transient` is a real data location as of
// 0.8.30, and `layout` / `at` (the `layout at N` clause) are reserved next to
// it, so both are colored as keywords.

const solidityTypes = (() => {
  const list = ["address", "bool", "string", "bytes", "byte", "int", "uint", "fixed", "ufixed"];
  list.push(...sizedInts(["int", "uint"], 8, 256));
  for (let i = 1; i <= 32; i += 1) list.push("bytes" + i);
  return words(list.join(" "));
})();

export const solidity = mk({
  name: "solidity",
  keywords: `pragma solidity import as from using abstract contract interface library is
    public private internal external pure view payable virtual override returns return function
    modifier event error constructor fallback receive struct enum mapping if else for while do
    break continue throw emit new delete try catch revert assembly unchecked type immutable
    constant storage memory calldata transient layout at indexed anonymous global`,
  types: solidityTypes,
  builtin: `msg block tx abi this super now blockhash blobhash gasleft keccak256 sha256 sha3
    ripemd160 ecrecover addmod mulmod selfdestruct require assert revert basefee blobbasefee
    prevrandao chainid coinbase gasprice origin timestamp number difficulty`,
  atoms: `true false wei gwei ether seconds minutes hours days weeks`,
  defKeywords: `contract interface library struct enum event error function modifier`,
  typeFirstDefinitions: true,
});

// ── Gleam ──────────────────────────────────────────────────────────────────
// https://gleam.run - braces, `//` line comments only, "..." strings,
// `@attribute`. Type and constructor names are uppercase-leading.

export const gleam = mk({
  name: "gleam",
  keywords: `as assert case const fn if import let opaque panic pub todo type use auto
    delegate derive echo else implement macro test`,
  types: `Int Float String Bool Nil List Result Option BitArray Dynamic Bytes Order`,
  atoms: `True False Nil Ok Error`,
  defKeywords: `fn type const`,
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
  keywords: `as break case const continue def defer else enum export fn for if is let match
    nullable return static struct switch type union use yield`,
  types: `i8 i16 i32 i64 int u8 u16 u32 u64 uint uintptr size f32 f64 bool char str rune
    void never opaque valist`,
  builtin: `len offset align alloc free append delete insert abort assert vastart vaarg
    vaend`,
  atoms: `true false null`,
  defKeywords: `fn type struct union enum`,
});

// ── Prisma ───────────────────────────────────────────────────────────────────
// https://prisma.io schema files - block declarations (`model`, `enum`, …),
// `//` + `///` line comments, `"..."` strings, and `@`/`@@` field/block
// attributes (colored as meta).

export const prisma = mk({
  name: "prisma",
  keywords: `datasource generator model enum type view`,
  types: `String Boolean Int BigInt Float Decimal DateTime Json Bytes Unsupported`,
  builtin: `autoincrement now uuid cuid ulid nanoid dbgenerated auto env map id default
    unique relation updatedAt index fields references onDelete onUpdate length sort fulltext
    ignore raw`,
  atoms: `true false null`,
  defKeywords: `model enum type view datasource generator`,
  hooks: {
    // `@id`, `@default`, `@@unique`, `@@map`, … - attributes. Fires once per
    // `@`, so `@@` lands two meta tokens, which still renders as one run.
    "@": (stream: StringStream) => {
      stream.eatWhile(/[\w.]/);
      return "meta";
    },
  },
});

// ── GraphQL ──────────────────────────────────────────────────────────────────
// https://graphql.org SDL + operations - `type`/`query`/`fragment` keywords,
// `#` line comments, `@directive`, and `$variable` references.

export const graphql = mk({
  name: "graphql",
  keywords: `type query mutation subscription fragment on enum interface union scalar input
    schema extend implements directive repeatable`,
  types: `Int Float String Boolean ID`,
  atoms: `true false null`,
  hooks: {
    "#": (stream: StringStream) => {
      stream.skipToEnd();
      return "comment";
    },
    "@": (stream: StringStream) => {
      stream.eatWhile(/[\w]/);
      return "meta";
    },
    $: (stream: StringStream) => {
      stream.eatWhile(/[\w]/);
      return "variable";
    },
  },
});

// ── Terraform / HCL ──────────────────────────────────────────────────────────
// https://terraform.io - block-structured (`resource "x" "y" { … }`), `#` +
// `//` line comments, `/* */` blocks, `"..."` strings. clike handles the
// `//` and `/* */` comments; only `#` needs a hook.

export const terraform = mk({
  name: "terraform",
  keywords: `resource variable module output provider data locals terraform for_each count
    depends_on lifecycle dynamic provisioner connection if for in endfor endif import moved
    removed check ephemeral run required_providers required_version backend cloud sensitive
    nullable validation condition error_message precondition postcondition create_before_destroy
    prevent_destroy ignore_changes replace_triggered_by`,
  builtin: `var local module path each self terraform data provider`,
  atoms: `true false null`,
  hooks: { "#": hashComment },
});

// ── ASN.1 ────────────────────────────────────────────────────────────────────
// https://www.itu.int/ITU-T/studygroups/com17/languages - `legacy-modes` ships
// the tokenizer but no word lists (it is a factory, not a ready parser), so the
// SMIv2 / MIB vocabulary that makes real `.asn1` files readable lives here.

export const asn1 = asn1Mode({
  keywords: words(
    "DEFINITIONS BEGIN END IMPORTS EXPORTS FROM SEQUENCE SET OF CHOICE " +
      "OPTIONAL DEFAULT IMPLICIT EXPLICIT TAGS AUTOMATIC COMPONENTS COMPONENT " +
      "INCLUDES MIN MAX SIZE WITH SYNTAX PRESENT ABSENT CONSTRAINED BY UNION " +
      "INTERSECTION EXCEPT ALL PATTERN ENCODED CLASS INSTANCE ABSTRACT-SYNTAX " +
      "TYPE-IDENTIFIER",
  ),
  storage: words(
    "INTEGER BOOLEAN BIT STRING OCTET NULL OBJECT IDENTIFIER REAL ENUMERATED " +
      "UTF8String NumericString PrintableString TeletexString VideotexString " +
      "IA5String VisibleString GeneralString GraphicString BMPString " +
      "UniversalString UTCTime GeneralizedTime ObjectDescriptor EXTERNAL " +
      "EMBEDDED PDV CHARACTER RELATIVE-OID",
  ),
  tags: words("UNIVERSAL APPLICATION PRIVATE CONTEXT"),
  modifier: words(
    "MODULE-IDENTITY OBJECT-TYPE OBJECT-IDENTITY NOTIFICATION-TYPE " +
      "TEXTUAL-CONVENTION MODULE-COMPLIANCE OBJECT-GROUP NOTIFICATION-GROUP " +
      "AGENT-CAPABILITIES MACRO",
  ),
  accessTypes: words(
    "read-only read-write read-create not-accessible accessible-for-notify " + "write-only",
  ),
  status: words("current deprecated obsolete mandatory optional"),
  cmipVerbs: words("ACTIONS EVENTS"),
  compareTypes: words("TRUE FALSE"),
});

// ── Mojo ─────────────────────────────────────────────────────────────────────
// https://docs.modular.com/mojo - a Python superset, so the Python spelling
// (`def`, `class`, decorators, triple-quoted docstrings) is the base and the
// systems layer sits on top. The v26 renames are the current spelling
// (`comptime` for `alias`/`@parameter`, `mut`/`var`/`read` for the old
// `inout`/`owned`/`borrowed`); the superseded words stay listed so existing
// sources keep their coloring.

export const mojo = pyLike({
  name: "mojo",
  keywords: `alias and as assert async await break class comptime continue def del elif else
    except finally fn for from global if import in is lambda nonlocal not or pass raise raises
    ref return struct trait try var while with yield owned borrowed inout mut read out let
    capturing parameter deinit constrained requires where`,
  types: `Int UInt Float64 Float32 Float16 BFloat16 Int8 Int16 Int32 Int64 Int128 Int256
    UInt8 UInt16 UInt32 UInt64 UInt128 UInt256 Bool String StringLiteral StringSlice
    StaticString SIMD DType Scalar Tensor List Dict Set Optional Tuple Span Pointer
    UnsafePointer OwnedPointer ArcPointer AnyType Movable Copyable Origin Slice Error Byte
    Codepoint IntLiteral FloatLiteral NoneType PythonObject`,
  builtin: `print len range abs min max sum sorted reversed enumerate zip isinstance rebind
    bitcast simdwidthof sizeof alignof bitwidthof parallelize vectorize unroll external_call
    debug_assert constrained memcpy memset swap hash repr str int float bool tuple list dict set
    input open`,
  atoms: `True False None`,
  defKeywords: `def fn struct trait class`,
});

// ── Vyper ────────────────────────────────────────────────────────────────────
// https://docs.vyperlang.org - Pythonic EVM contracts: indentation, `#`
// comments, `@external`-style decorators, plus Solidity's sized-integer types.

const vyperTypes = words(
  ["address", "bool", "decimal", "bytes32", "String", "Bytes", "DynArray", "HashMap"]
    .concat(sizedInts(["int", "uint"], 8, 256))
    .join(" "),
);

export const vyper = pyLike({
  name: "vyper",
  keywords: `def event struct interface flag enum implements from import as for in if elif
    else assert raise pass break continue return log pure view payable nonpayable external
    internal deploy constant immutable transient public indexed and or not in uses initializes
    exports`,
  types: vyperTypes,
  builtin: `self msg block tx chain len concat slice keccak256 sha256 empty max min
    as_wei_value convert create_minimal_proxy_to create_copy_of create_from_blueprint unsafe_add
    unsafe_sub unsafe_mul unsafe_div ecrecover ecadd ecmul blockhash blobhash method_id
    abi_encode abi_decode raw_call raw_log raw_revert send selfdestruct range print isqrt sqrt
    uint256_addmod uint256_mulmod epsilon`,
  atoms: `True False None empty ZERO_ADDRESS ENV`,
  defKeywords: `def event struct interface flag`,
});

// ── Starlark / Bazel ─────────────────────────────────────────────────────────
// https://bazel.build/rules/language - a deliberately small Python dialect, so
// the Python shape holds and only the build vocabulary differs.

export const starlark = pyLike({
  name: "starlark",
  keywords: `and break continue def elif else for if in lambda load not or pass return`,
  builtin: `load glob select package package_group licenses exports_files depset struct fail
    print len range list dict tuple sorted reversed enumerate zip type hasattr getattr dir str
    repr bool int all any max min native rule attr aspect provider genrule filegroup alias
    config_setting test_suite exports workspace repository_rule module_extension use_repo
    bazel_dep register_toolchains http_archive git_repository`,
  atoms: `True False None`,
  defKeywords: `def`,
});

// ── Move ─────────────────────────────────────────────────────────────────────
// https://move-language.github.io - the Sui / Aptos contract language. Rust
// shaped (braces, `//`, `#[attribute]`); the four abilities `key store drop
// copy` read as builtins so a `has key, store` clause stands out.

export const move = mk({
  name: "move",
  keywords: `module script use friend public entry native fun struct enum has phantom const
    let mut move return abort break continue if else while loop spec schema invariant ensures
    requires aborts_if pragma include apply to except global exists as acquires match macro
    package address`,
  types: `u8 u16 u32 u64 u128 u256 bool address vector signer`,
  builtin: `key store drop copy borrow_global borrow_global_mut move_from move_to freeze
    assert option string vector table object transfer event tx_context coin balance`,
  atoms: `true false`,
  defKeywords: `module fun struct const enum`,
  number: /^(?:0[xX][0-9a-fA-F_]+|[\d_]+)(?:u8|u16|u32|u64|u128|u256)?/,
  hooks: { "#": hashAttr },
});

// ── Cairo ────────────────────────────────────────────────────────────────────
// https://book.cairo-lang.org - Starknet's Rust-shaped language (Cairo 2.x):
// braces, `//`, `#[derive(...)]` / `#[starknet::contract]` attributes.

export const cairo = mk({
  name: "cairo",
  keywords: `as break const continue else enum extern fn for if impl implicits in let loop
    match mod mut nopanic of pub ref return struct trait type use while where dyn super self
    crate macro deref`,
  types: `felt252 bytes31 ByteArray u8 u16 u32 u64 u128 u256 usize i8 i16 i32 i64 i128
    bool Array Span Option Result Nullable Felt252Dict ContractAddress ClassHash EthAddress
    StorageAddress Box Snapshot`,
  builtin: `print println array assert panic panic_with_felt252 get_caller_address
    get_contract_address get_block_timestamp get_block_number gas starknet core traits integer
    serde storage`,
  atoms: `true false Some None Ok Err`,
  defKeywords: `fn struct enum trait impl mod const type`,
  number:
    /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|[\d_]+)(?:_?(?:u8|u16|u32|u64|u128|u256|usize|felt252))?/,
  hooks: { "#": hashAttr },
});

// ── Vala ─────────────────────────────────────────────────────────────────────
// https://vala.dev - GNOME's C#-shaped language compiled down to C.

export const vala = mk({
  name: "vala",
  keywords: `abstract as async base break case catch class const construct continue default
    delegate delete do dynamic else enum ensures errordomain extern finally for foreach get
    global if in inline interface internal is lock namespace new out override owned params
    private protected public ref requires return set signal sizeof static struct switch this
    throw throws try typeof unowned using var virtual volatile weak while yield yields`,
  types: `void bool char uchar short ushort int uint long ulong size_t ssize_t int8 uint8
    int16 uint16 int32 uint32 int64 uint64 float double string unichar va_list Object Value Type
    Error Variant`,
  atoms: `true false null`,
  defKeywords: `class struct interface enum namespace delegate errordomain`,
  typeFirstDefinitions: true,
});

// ── V ────────────────────────────────────────────────────────────────────────
// https://vlang.io - Go-shaped syntax with Rust-flavored options and `mut`.

export const vlang = mk({
  name: "v",
  keywords: `as asm assert atomic break const continue defer else enum false fn for go goto
    if implements import in interface is lock match module mut none or pub return rlock select
    shared sizeof spawn static struct true type typeof union unsafe volatile __global __offsetof
    dump isreftype`,
  types: `bool string rune i8 i16 int i64 i128 u8 u16 u32 u64 u128 f32 f64 isize usize
    voidptr byteptr charptr any thread map array chan nil`,
  builtin: `println print eprintln eprint panic exit error json os time math strconv arrays
    maps rand sync net http`,
  atoms: `true false none nil`,
  defKeywords: `fn struct enum interface type const module union`,
});

// ── Lean 4 ───────────────────────────────────────────────────────────────────
// https://lean-lang.org - `--` line comments and nestable `/- … -/` blocks (no
// `//` at all), heavy unicode identifiers, which clike already keeps whole
// because its identifier class runs from \xa1 up.

function leanNestedComment(depth: number): Tokenizer {
  return (stream, state) => {
    for (;;) {
      const ch = stream.next();
      if (ch == null) break;
      if (ch === "-" && stream.eat("/")) {
        if (depth === 1) {
          state.tokenize = null;
          break;
        }
        state.tokenize = leanNestedComment(depth - 1);
        return state.tokenize(stream, state);
      } else if (ch === "/" && stream.eat("-")) {
        state.tokenize = leanNestedComment(depth + 1);
        return state.tokenize(stream, state);
      }
    }
    return "comment";
  };
}

export const lean = mk({
  name: "lean",
  keywords: `abbrev at attribute axiom by calc case cases class constructor deriving do def
    else end example exists extends from fun have if import in inductive infix infixl infixr
    instance intro let local macro macro_rules match mutual namespace noncomputable notation
    opaque open partial prefix private protected rec return scoped section set_option show
    structure suffices syntax then theorem this try universe unsafe variable where with
    declare_syntax_cat elab elab_rules builtin_initialize initialize postfix nomatch fn omega
    decide simp rfl sorry`,
  types: `Nat Int Float Bool String Char List Array Option Prop Type Sort Unit Empty Fin
    IO Except StateM ReaderM Id Sum Prod Subtype Decidable Ordering UInt8 UInt16 UInt32 UInt64
    USize Thunk Task Std Lean Syntax Expr`,
  atoms: `true false none some rfl`,
  defKeywords: `def theorem abbrev inductive structure class instance example axiom`,
  indentStatements: false,
  hooks: {
    "-": dashComment,
    "/": (stream: StringStream, state: HookState): string | false => {
      if (stream.eat("-")) {
        state.tokenize = leanNestedComment(1);
        return state.tokenize(stream, state);
      }
      return false;
    },
  },
});

// ── Nix ──────────────────────────────────────────────────────────────────────
// https://nix.dev - attribute sets in braces, `#` line + `/* */` block
// comments, and `''…''` indented strings alongside ordinary `"…"`.

const tokenNixIndented: Tokenizer = (stream, state) => {
  for (;;) {
    const ch = stream.next();
    if (ch == null) break; // indented strings routinely span lines
    if (ch === "'" && stream.eat("'")) {
      state.tokenize = null;
      break;
    }
  }
  return "string";
};

export const nix = mk({
  name: "nix",
  keywords: `assert else if in inherit let or rec then with`,
  builtin: `builtins import map foldl' filter elem elemAt head tail length attrNames
    attrValues getAttr hasAttr removeAttrs listToAttrs toString baseNameOf dirOf isNull abort
    throw derivation fetchTarball fetchGit fetchurl fetchClosure pkgs lib stdenv mkDerivation
    buildInputs nativeBuildInputs propagatedBuildInputs callPackage mkIf mkMerge mkDefault
    mkForce mkOption mkEnableOption types config options nixpkgs system outputs inputs self`,
  atoms: `true false null`,
  indentStatements: false,
  hooks: {
    "#": hashComment,
    "'": (stream: StringStream, state: HookState): string | false => {
      if (stream.eat("'")) {
        state.tokenize = tokenNixIndented;
        return tokenNixIndented(stream, state);
      }
      return false;
    },
  },
});

// ── Elixir ───────────────────────────────────────────────────────────────────
// https://elixir-lang.org - `do … end` blocks, `#` comments, `:atoms`,
// `@module_attributes`, `?c` codepoints and `"""` heredocs. `?` and `!` join
// the identifier class so `valid?` / `save!` stay one token. The cost of that
// is an unspaced `y!=1`, which reads as `y!` then `=`; the spaced form every
// `mix format` run produces (`y != 1`) is tokenized correctly, so this is the
// right side of the trade.

export const elixir = mk({
  name: "elixir",
  keywords: `after alias and case catch cond def defcallback defdelegate defexception
    defguard defguardp defimpl defmacro defmacrop defmodule defoverridable defp defprotocol
    defstruct do else end fn for if import in not or quote raise receive require rescue super
    throw try unless unquote unquote_splicing use when with while`,
  builtin: `IO Enum String List Map Kernel Process GenServer Supervisor DynamicSupervisor
    Task Agent Application Logger Registry Node Port File Path Regex Stream Tuple Atom Integer
    Float Keyword Access MapSet Date Time DateTime NaiveDateTime Base URI Version Code Module
    Macro Protocol Exception Ecto Phoenix Plug Mix ExUnit self spawn send receive is_nil is_atom
    is_binary is_list is_map is_tuple is_integer is_float is_function is_pid is_boolean length
    hd tl elem put_elem map_size tuple_size`,
  atoms: `true false nil`,
  defKeywords: `def defp defmodule defmacro defmacrop defstruct defprotocol defimpl defexception
    defguard defguardp defdelegate`,
  isIdentifierChar: /[\w$_?!\xa1-￿]/,
  indentStatements: false,
  hooks: {
    "#": hashComment,
    "@": atMeta,
    '"': tripleHook('"'),
    // `:ok`, `:"quoted atom"`, `:<>`. A bare `:` (map/keyword syntax) is left
    // to clike so `key: value` does not paint the colon as an atom.
    ":": (stream: StringStream): string | false => {
      if (!/[A-Za-z_"]/.test(stream.peek() ?? "")) return false;
      stream.eatWhile(/[\w@?!]/);
      return "atom";
    },
    // `?a` codepoint literal - only when a real character follows.
    "?": (stream: StringStream): string | false => {
      if (!/[A-Za-z0-9\\]/.test(stream.peek() ?? "")) return false;
      stream.next();
      return "number";
    },
  },
});

// ── Nushell ──────────────────────────────────────────────────────────────────
// https://nushell.sh - structured-data shell: `#` comments, `$variables`,
// `"…"` / `'…'` strings.

export const nushell = mk({
  name: "nushell",
  keywords: `def export extern alias use module source overlay hide let mut const if else
    match for while loop break continue return try catch do where error make register plugin
    main`,
  types: `int float string bool date duration filesize binary list record table any
    nothing closure block range glob cell-path`,
  builtin: `ls cd rm cp mv mkdir touch open save get select reject drop first last sort
    sort-by group-by uniq length reverse skip take each par-each filter reduce zip flatten
    transpose wrap str into from to lines split join parse math describe echo print input table
    http url path date char which help exit which-env with-env complete ignore`,
  atoms: `true false null`,
  defKeywords: `def extern alias module`,
  indentStatements: false,
  hooks: { "#": hashComment, $: dollarVar },
});

// ── AWK ──────────────────────────────────────────────────────────────────────
// https://www.gnu.org/software/gawk - genuinely C-like (braces, `"…"`), with
// `#` comments and the well-known all-caps field variables.

export const awk = mk({
  name: "awk",
  keywords: `BEGIN END BEGINFILE ENDFILE function func if else while for do break continue
    next nextfile exit return delete in print printf getline switch case default`,
  builtin: `length substr index split sub gsub gensub match sprintf sin cos atan2 exp log
    sqrt int rand srand tolower toupper toupper system close fflush strftime systime mktime
    asort asorti patsplit isarray typeof`,
  atoms: `NR NF FNR FS OFS ORS RS FILENAME RSTART RLENGTH SUBSEP ARGC ARGV ENVIRON CONVFMT
    OFMT IGNORECASE RT PROCINFO`,
  defKeywords: `function func`,
  hooks: { "#": hashComment },
});

// ── Ada ──────────────────────────────────────────────────────────────────────
// https://ada-lang.io - `--` line comments and a `'` that is both a character
// literal and the attribute tick, so the quote is disambiguated by lookahead
// instead of opening a string that never closes. Ada is case-insensitive; the
// lowercase spelling (what modern sources use) is what gets colored.

export const ada = mk({
  name: "ada",
  keywords: `abort abs abstract accept access aliased all and array at begin body case
    constant declare delay delta digits do else elsif end entry exception exit for function
    generic goto if in interface is limited loop mod new not null of or others out overriding
    package parallel pragma private procedure protected raise range record rem renames requeue
    return reverse select separate some subtype synchronized tagged task terminate then type
    until use when while with xor`,
  types: `Boolean Integer Natural Positive Float Character String Wide_Character
    Wide_String Wide_Wide_Character Wide_Wide_String Duration Long_Integer Short_Integer
    Long_Float Short_Float Long_Long_Integer`,
  atoms: `True False null`,
  defKeywords: `procedure function package task protected type subtype`,
  number: /^(?:\d[\d_]*#[0-9a-fA-F_]+#|[\d_]+\.?[\d_]*(?:[eE][-+]?[\d_]+)?)/,
  hooks: {
    "-": dashComment,
    // `'a'` is a literal; `Obj'Length` is the attribute tick.
    "'": (stream: StringStream): string => (stream.match(/^[^']'/) ? "string" : "operator"),
  },
});

// ── WGSL ─────────────────────────────────────────────────────────────────────
// https://www.w3.org/TR/WGSL - WebGPU shaders: `@group(0) @binding(0)`
// attributes, nestable `/* */` comments, and a large predeclared type set.

export const wgsl = mk({
  name: "wgsl",
  keywords: `alias break case const const_assert continue continuing default diagnostic
    discard else enable false fn for if let loop override requires return struct switch true var
    while`,
  types: `bool f16 f32 i32 u32 vec2 vec3 vec4 vec2f vec3f vec4f vec2i vec3i vec4i vec2u
    vec3u vec4u vec2h vec3h vec4h mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4
    mat2x2f mat3x3f mat4x4f array atomic ptr sampler sampler_comparison texture_1d texture_2d
    texture_2d_array texture_3d texture_cube texture_cube_array texture_multisampled_2d
    texture_depth_multisampled_2d texture_external texture_storage_1d texture_storage_2d
    texture_storage_2d_array texture_storage_3d texture_depth_2d texture_depth_2d_array
    texture_depth_cube texture_depth_cube_array function private workgroup uniform storage read
    write read_write`,
  builtin: `bitcast all any select arrayLength abs acos acosh asin asinh atan atanh atan2
    ceil clamp cos cosh countLeadingZeros countOneBits countTrailingZeros cross degrees
    determinant distance dot exp exp2 extractBits faceForward firstLeadingBit firstTrailingBit
    floor fma fract frexp insertBits inverseSqrt ldexp length log log2 max min mix modf
    normalize pow quantizeToF16 radians reflect refract reverseBits round saturate sign sin sinh
    smoothstep sqrt step tan tanh transpose trunc dpdx dpdxCoarse dpdxFine dpdy dpdyCoarse
    dpdyFine fwidth textureDimensions textureGather textureGatherCompare textureLoad
    textureNumLayers textureNumLevels textureNumSamples textureSample textureSampleBias
    textureSampleCompare textureSampleCompareLevel textureSampleGrad textureSampleLevel
    textureSampleBaseClampToEdge textureStore atomicLoad atomicStore atomicAdd atomicSub
    atomicMax atomicMin atomicAnd atomicOr atomicXor atomicExchange atomicCompareExchangeWeak
    pack4x8snorm pack4x8unorm pack2x16snorm pack2x16unorm pack2x16float unpack4x8snorm
    unpack4x8unorm unpack2x16snorm unpack2x16unorm unpack2x16float storageBarrier textureBarrier
    workgroupBarrier workgroupUniformLoad`,
  atoms: `true false`,
  defKeywords: `fn struct`,
  number: /^(?:0[xX][0-9a-fA-F.pP+-]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)[fhiu]?/,
  hooks: { "@": atMeta, "/": slashHook },
});

// ── Slint ────────────────────────────────────────────────────────────────────
// https://slint.dev - declarative Rust/C++ UI markup: `component … inherits`,
// `//` + `/* */` comments, `@image-url(...)` builtins.

export const slint = mk({
  name: "slint",
  keywords: `component export import from struct enum property callback function animate
    states transitions if for in out private pure global inherits return changed init parent
    root self`,
  types: `int float string bool color brush length physical-length duration angle percent
    image easing relative-font-size`,
  builtin: `Rectangle Text Image TouchArea Window Path Flickable Timer Dialog PopupWindow
    ListView StandardButton VerticalLayout HorizontalLayout GridLayout VerticalBox HorizontalBox
    GridBox Button LineEdit TextEdit CheckBox ComboBox SpinBox Slider ScrollView TabWidget
    GroupBox ProgressIndicator Switch Palette Colors Math Key`,
  atoms: `true false`,
  defKeywords: `component struct enum global`,
  number: /^(?:\d+\.?\d*|\.\d+)(?:px|phx|pt|in|mm|cm|%|deg|rad|turn|ms|s)?/,
  hooks: { "@": atMeta },
});

// ── ReScript ─────────────────────────────────────────────────────────────────
// https://rescript-lang.org - OCaml semantics in JS-shaped syntax: braces,
// `//` + `/* */` comments, `@decorator` attributes.

export const rescript = mk({
  name: "rescript",
  keywords: `and as assert async await constraint downto else exception external for if in
    include lazy let module mutable of open private rec switch to try type when while with
    unpack`,
  types: `int float string bool char unit array list option result promise dict exn Js
    Belt Dict Map Set Array String Int Float Option Result Promise`,
  atoms: `true false None Some Ok Error`,
  defKeywords: `let type module external exception`,
  hooks: { "@": atMeta },
});

// ── Jsonnet ──────────────────────────────────────────────────────────────────
// https://jsonnet.org - JSON plus functions: `#` / `//` / `/* */` comments,
// `$` root reference, `std.*` library.

export const jsonnet = mk({
  name: "jsonnet",
  keywords: `assert else error for function if import importstr importbin in local self super
    tailstrict then`,
  builtin: `std $`,
  atoms: `true false null`,
  hooks: { "#": hashComment, $: dollarVar },
});

// ── CUE ──────────────────────────────────────────────────────────────────────
// https://cuelang.org - types and values are one lattice: `#Definition` names,
// `//` comments, `"""` multi-line strings.

export const cuelang = mk({
  name: "cue",
  keywords: `package import for in if let close and or div mod quo rem`,
  types: `bool int float string bytes number uint uint8 uint16 uint32 uint64 int8 int16
    int32 int64 rune time null`,
  builtin: `len close and or div mod quo rem list strings math regexp encoding json yaml`,
  atoms: `true false null`,
  hooks: {
    '"': tripleHook('"'),
    // `#Schema` / `_#hidden` definitions read as a declared name.
    "#": (stream: StringStream): string => {
      stream.eatWhile(/[\w]/);
      return "def";
    },
  },
});

// ── Pkl ──────────────────────────────────────────────────────────────────────
// https://pkl-lang.org - Apple's configuration language: `//` + `///` doc
// comments, `@Annotation`s, `"""` multi-line strings.

export const pkl = mk({
  name: "pkl",
  keywords: `abstract amends as class const else extends external for function hidden if
    import in is let local module new open out outer read super this throw trace typealias when
    nothing fixed`,
  types: `Int Int8 Int16 Int32 UInt UInt8 UInt16 UInt32 Float Number String Boolean Null
    List Listing Map Mapping Set Collection Dynamic Typed Object Class Any Duration DataSize
    Regex Pair Comparable Module Function Resource`,
  atoms: `true false null unknown`,
  defKeywords: `class module typealias function`,
  hooks: { "@": atMeta, '"': tripleHook('"') },
});

// ── Bicep ────────────────────────────────────────────────────────────────────
// https://learn.microsoft.com/azure/azure-resource-manager/bicep - Azure ARM
// authoring: `//` comments, `'…'` single-quoted strings, `'''` multi-line,
// `@description(...)` decorators.

export const bicep = mk({
  name: "bicep",
  keywords: `targetScope metadata param var resource module output type func existing for in
    if else import as with using extends assert provider sys`,
  types: `string int bool object array secureString secureObject`,
  builtin: `union concat contains empty first intersection last length min max range skip
    take split json base64 base64ToJson uniqueString guid substring replace toLower toUpper trim
    startsWith endsWith format indexOf resourceGroup subscription tenant managementGroup
    deployment environment reference resourceId subscriptionResourceId tenantResourceId
    extensionResourceId listKeys listSecrets getSecret utcNow dateTimeAdd loadTextContent
    loadFileAsBase64 loadJsonContent items`,
  atoms: `true false null`,
  defKeywords: `resource module param var output type func`,
  hooks: { "@": atMeta, "'": tripleHook("'") },
});

/**
 * Trailing rules every `simpleMode` grammar needs. Without them the driver
 * falls back to consuming a single character per token, so an unmatched word
 * becomes one token per letter: correct output, but needlessly expensive on a
 * large file and impossible to style later. Always spread these last.
 */
