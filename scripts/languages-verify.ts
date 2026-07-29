/**
 * Self-check for the editor language registry (`src/modules/editor/lib/languages.ts`)
 * and the hand-rolled parsers it loads (`.../streamLanguages.ts`).
 * Run: `npx tsx scripts/languages-verify.ts`.
 *
 * Every failure mode here is silent at build time - `tsc` is happy with a
 * registry that ships a language nobody can ever reach, and a stream parser
 * that throws only does so when a user opens that one file type. So:
 *  1. UNIQUE IDS: the id is the persisted override key, so a duplicate would
 *     make one entry unreachable and mis-restore saved overrides.
 *  2. LOADABLE: every `load()` resolves to a real Extension or StreamParser -
 *     this is what catches a wrong export name (`m.nTriples` vs `m.ntriples`),
 *     which otherwise resolves to `undefined` and blows up at open time.
 *  3. REACHABLE: each entry's own extensions/filenames actually detect back to
 *     that entry. A suffix claimed by an earlier entry silently shadows the
 *     later one, so this asserts the shadowing is only ever deliberate.
 *  4. TOKENIZES: every stream parser survives a real tokenize pass over source
 *     that exercises its hooks, always advances the stream, and emits at least
 *     one comment/keyword/string token - a config with a typo'd word list
 *     parses "fine" while coloring nothing.
 */
import { StringStream } from "@codemirror/language";
import type { StreamParser } from "@codemirror/language";
import { LANGUAGES, detectLanguageId } from "../src/modules/editor/lib/languages";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

function isStreamParser(v: unknown): v is StreamParser<unknown> {
  return (
    typeof v === "object" && v !== null && typeof (v as { token?: unknown }).token === "function"
  );
}

/**
 * Drive a StreamParser over `code` the way CodeMirror's own tokenizer driver
 * does (resetting `start` before each token so `stream.current()` returns just
 * the pending token), and report every tag it produced.
 */
function tokenize(
  parser: StreamParser<unknown>,
  code: string,
): { tags: Set<string>; splitRun: number } {
  const state = parser.startState ? parser.startState(2) : ({} as never);
  const tags = new Set<string>();
  // Longest run of consecutive one-character alphanumeric tokens. A lone `x`
  // is a legitimate identifier, but three in a row means a word was chewed
  // letter by letter because no rule matched it.
  let splitRun = 0;
  let run = 0;
  for (const line of code.split("\n")) {
    if (line.length === 0) {
      parser.blankLine?.(state as never, 2);
      continue;
    }
    const stream = new StringStream(line, 2, 2, 0);
    let guard = 0;
    while (!stream.eol()) {
      if (++guard > 10_000) throw new Error("tokenizer made no progress");
      stream.start = stream.pos;
      const before = stream.pos;
      const tag = parser.token(stream, state as never);
      if (stream.pos === before) throw new Error(`token() did not advance at ${before}: ${line}`);
      const text = line.slice(before, stream.pos);
      run = text.length === 1 && /[A-Za-z0-9]/.test(text) ? run + 1 : 0;
      if (run > splitRun) splitRun = run;
      for (const t of (tag ?? "").split(/\s+/)) if (t) tags.add(t.replace(/-\d+$/, ""));
    }
    run = 0; // a line break always ends a run
  }
  return { tags, splitRun };
}

/**
 * Source snippets per language id. Each one deliberately exercises that
 * language's comment syntax, a keyword, and a string, because those three are
 * what the hand-written configs get wrong.
 */
const SAMPLES: Record<string, string> = {
  odin: 'package main\n// line\n/* nested /* deep */ */\nmain :: proc() {\n\ts := "hi"\n\tx := `raw`\n\t@(private) y: int = 0x1F\n}',
  zig: 'const std = @import("std");\n// line\npub fn main() !void {\n    const s = "hi";\n    const m =\n        \\\\multiline\n    ;\n}',
  nim: '# line\n#[ block ]#\nproc greet(name: string): string =\n  result = "hello " & name\nlet s = """triple"""\nlet r = r"raw"',
  hare: 'use fmt;\n// line\nexport fn main() void = {\n\tconst s: str = "hi";\n};',
  gleam:
    'import gleam/io\n// line\npub fn main() {\n  let x = "hi"\n  io.println(x)\n}\npub type Colour {\n  Red\n}',
  solidity:
    '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.30;\ncontract C {\n  uint256 transient t;\n  string s = "hi";\n  function f() public pure returns (bool) { return true; }\n}',
  prisma:
    '// line\ndatasource db {\n  provider = "postgresql"\n}\nmodel User {\n  id Int @id @default(autoincrement())\n}',
  graphql:
    "# line\ntype Query {\n  user(id: ID!): User @deprecated\n}\nquery Q { user(id: $id) { name } }",
  terraform:
    '# line\nterraform {\n  required_version = ">= 1.10"\n}\nresource "aws_s3_bucket" "b" {\n  bucket = var.name\n}\nephemeral "random_password" "p" {}',
  mojo: '# line\nfrom sys import argv\n@parameter\nfn add[T: AnyType](mut a: Int, read b: Int) raises -> Int:\n    """Docstring."""\n    var c = a + b\n    return c\nstruct Point:\n    var x: Int',
  vyper:
    '# line\n# @version ^0.4.0\nowner: public(address)\n@external\n@payable\ndef deposit(amount: uint256) -> bool:\n    """Doc."""\n    assert msg.sender == self.owner, "not owner"\n    return True',
  starlark:
    '# line\nload("@rules_python//python:defs.bzl", "py_library")\ndef _impl(ctx):\n    return [DefaultInfo()]\npy_library(\n    name = "lib",\n    srcs = glob(["**/*.py"]),\n)',
  move: "// line\nmodule my_addr::coin {\n    #[test_only]\n    use std::string;\n    struct Coin has key, store { value: u64 }\n    public fun mint(v: u64): Coin { Coin { value: v } }\n}",
  cairo:
    '// line\n#[derive(Drop, Serde)]\nstruct Point { x: felt252, y: u256 }\nfn main() -> felt252 {\n    let s = "hi";\n    let mut total: u32 = 0_u32;\n    total.into()\n}',
  vala: '// line\n/* block */\nusing GLib;\npublic class Demo : Object {\n    public string name { get; set; }\n    public static int main (string[] args) {\n        stdout.printf ("hi");\n        return 0;\n    }\n}',
  v: '// line\nmodule main\nimport os\nstruct Point {\nmut:\n\tx int\n}\nfn main() {\n\ts := "hi"\n\tprintln(s)\n}',
  lean: '-- line\n/- nested /- deep -/ block -/\nimport Mathlib\nnamespace Demo\ndef greet (name : String) : String :=\n  "hello " ++ name\ntheorem t : 1 = 1 := rfl\nend Demo',
  nix: "# line\n/* block */\n{ pkgs, lib, ... }:\nlet\n  name = \"demo\";\n  script = ''\n    echo hi\n  '';\nin\npkgs.mkDerivation { inherit name; buildInputs = [ pkgs.hello ]; }",
  elixir:
    '# line\ndefmodule Demo do\n  @moduledoc """\n  Docs.\n  """\n  @greeting :hello\n  def greet(name) when is_binary(name) do\n    IO.puts("hi " <> name)\n  end\n  defp valid?(x), do: x != nil\nend',
  nushell:
    '# line\ndef greet [name: string] {\n  let msg = $"hello ($name)"\n  print $msg\n}\nls | where size > 1kb | sort-by name',
  awk: '#!/usr/bin/awk -f\n# line\nBEGIN { FS = ","; count = 0 }\n/error/ { count++ }\nEND { printf "%d\\n", count }\nfunction helper(a, b) { return length(a) + b }',
  ada: "-- line\nwith Ada.Text_IO;\nprocedure Hello is\n   S : constant String := \"hi\";\n   C : Character := 'x';\n   L : Natural := S'Length;\nbegin\n   Ada.Text_IO.Put_Line (S);\nend Hello;",
  wgsl: "// line\n/* nested /* deep */ */\nstruct Uniforms { mvp: mat4x4<f32> };\n@group(0) @binding(0) var<uniform> u: Uniforms;\n@vertex\nfn vs_main(@location(0) pos: vec3<f32>) -> @builtin(position) vec4<f32> {\n  return u.mvp * vec4<f32>(pos, 1.0);\n}",
  slint:
    '// line\nimport { Button } from "std-widgets.slint";\nexport component MainWindow inherits Window {\n    in-out property <string> label: "hi";\n    callback clicked();\n    Rectangle { background: #1e1e2e; width: 100px; }\n}',
  rescript:
    '// line\n/* block */\n@react.component\nlet make = (~name: string) => {\n  let msg = "hello " ++ name\n  Js.log(msg)\n}\ntype point = {x: int, y: int}',
  jsonnet:
    '# line\n// also a line\nlocal name = "demo";\n{\n  greeting: "hello " + name,\n  items: [std.format("%d", i) for i in std.range(1, 3)],\n}',
  cue: '// line\npackage demo\nimport "strings"\n#Schema: {\n\tname: string & !=""\n\tport: int | *8080\n}\nout: #Schema & { name: strings.ToLower("Demo") }',
  pkl: '// line\n/// doc\nmodule demo\n@Deprecated { message = "old" }\nclass Server {\n  host: String = "localhost"\n  port: Int = 8080\n}\ntext = """\nmulti\n"""',
  bicep:
    "// line\ntargetScope = 'resourceGroup'\n@description('The name')\nparam name string = 'demo'\nvar suffix = uniqueString(resourceGroup().id)\nresource sa 'Microsoft.Storage/storageAccounts@2023-01-01' = {\n  name: '${name}${suffix}'\n}",
  makefile:
    "# line\n.PHONY: all clean\nCC := gcc\nSRC = $(wildcard src/*.c)\nall: $(SRC)\n\t@$(CC) -o app $^\nclean:\n\trm -f app",
  batch:
    '@echo off\nREM line\n:: also a comment\nsetlocal enabledelayedexpansion\nset "NAME=demo"\nif not defined NAME goto :fail\nfor %%f in (*.txt) do echo %%f\n:fail\nexit /b 1',
  vim: '" line\nset number\nfunction! s:Greet(name) abort\n  let l:msg = "hello " . a:name\n  echom l:msg\nendfunction\nnnoremap <silent> <leader>g :call <SID>Greet("you")<CR>',
  apacheconf:
    '# line\n<VirtualHost *:80>\n    ServerName example.com\n    DocumentRoot "/var/www/html"\n    <Directory /var/www/html>\n        Options -Indexes\n        AllowOverride All\n        Require all granted\n    </Directory>\n</VirtualHost>',
  prolog:
    '% line\n/* block */\n:- dynamic(parent/2).\nparent(tom, bob).\nancestor(X, Y) :- parent(X, Y).\nancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).\ngreet :- format("hello~n").',
  asn1: 'DEMO-MIB DEFINITIONS ::= BEGIN\n-- line\nIMPORTS MODULE-IDENTITY FROM SNMPv2-SMI;\ndemoName OBJECT-TYPE\n    SYNTAX OCTET STRING\n    MAX-ACCESS read-only\n    STATUS current\n    DESCRIPTION "The name."\nEND',
};

// A tag that means the parser actually recognized structure, not just letters.
const MEANINGFUL = ["comment", "keyword", "string", "def", "meta", "atom", "builtin", "type"];

async function main(): Promise<void> {
  console.log(`Registry: ${LANGUAGES.length} languages`);

  // 1. UNIQUE IDS
  const ids = new Set<string>();
  for (const def of LANGUAGES) {
    assert(!ids.has(def.id), `duplicate language id "${def.id}"`);
    ids.add(def.id);
  }

  // An alias is only a fuzzy-search term, so one must never be spelled like a
  // *different* language's canonical id - anything resolving tags by name (the
  // chat highlighter does) then has to guess which of the two was meant.
  for (const def of LANGUAGES) {
    for (const alias of def.aliases ?? []) {
      assert(
        !ids.has(alias) || alias === def.id,
        `alias "${alias}" on "${def.id}" collides with the language id "${alias}"`,
      );
    }
  }

  // 3. REACHABLE - every entry is the winner for at least one of its own keys.
  for (const def of LANGUAGES) {
    const keys: string[] = [
      ...(def.extensions ?? []).map((e) => `sample.${e}`),
      ...(def.filenames ?? []),
    ];
    if (keys.length === 0 && !def.filenamePatterns?.length) {
      assert(false, `"${def.id}" has no extensions, filenames, or patterns - undetectable`);
      continue;
    }
    if (keys.length === 0) continue; // pattern-only (blade); covered below
    const reachable = keys.some((k) => detectLanguageId(k) === def.id);
    const shadowedBy = keys.map((k) => detectLanguageId(k)).filter(Boolean);
    assert(
      reachable,
      `"${def.id}" is fully shadowed - every key resolves elsewhere (${[...new Set(shadowedBy)].join(", ")})`,
    );
  }

  // Detection spot-checks for the deliberate collisions and the pattern rules.
  const expected: [string, string][] = [
    ["src/main.odin", "odin"],
    ["build.zig.zon", "zig"],
    ["app/Http/Kernel.php", "php"],
    ["resources/views/home.blade.php", "blade"],
    ["Makefile", "makefile"],
    ["justfile", "just"],
    ["BUILD.bazel", "starlark"],
    [".htaccess", "apacheconf"],
    ["flake.nix", "nix"],
    ["lib/demo.ex", "elixir"],
    ["scripts/deploy.bat", "batch"],
    ["shaders/blur.wgsl", "wgsl"],
    ["shaders/blur.frag", "glsl"],
    ["contracts/Token.vy", "vyper"],
    ["sources/coin.move", "move"],
    ["Dockerfile.prod", "dockerfile"],
    ["go.work", "go"],
    ["CMakeLists.txt", "cmake"],
    // Deliberate first-wins collisions (see the registry header).
    ["Foo.m", "objective-c"],
    ["cpu.v", "verilog"],
    ["unit.pp", "pascal"],
    ["doc.cls", "latex"],
    ["Program.fs", "fsharp"],
    ["main.rs", "rust"],
    ["schema.prisma", "prisma"],
  ];
  for (const [path, id] of expected) {
    const got = detectLanguageId(path);
    assert(got === id, `detect("${path}") = ${got ?? "null"}, expected ${id}`);
  }

  // 2 + 4. LOADABLE and TOKENIZES.
  let streamCount = 0;
  for (const def of LANGUAGES) {
    let loaded: unknown;
    try {
      loaded = await def.load();
    } catch (err) {
      assert(false, `"${def.id}" load() threw: ${(err as Error).message}`);
      continue;
    }
    if (loaded == null) {
      assert(false, `"${def.id}" load() resolved to ${String(loaded)} - wrong export name?`);
      continue;
    }
    if (!isStreamParser(loaded)) continue; // a lang-* Extension; nothing to drive
    streamCount++;

    const sample = SAMPLES[def.id];
    if (!sample) continue;
    let result: ReturnType<typeof tokenize>;
    try {
      result = tokenize(loaded as StreamParser<unknown>, sample);
    } catch (err) {
      assert(false, `"${def.id}" tokenize threw: ${(err as Error).message}`);
      continue;
    }
    const hits = MEANINGFUL.filter((t) => result.tags.has(t));
    assert(
      hits.length >= 3,
      `"${def.id}" only produced [${[...result.tags].join(", ")}] - word lists or hooks are not firing`,
    );
    // A grammar with no catch-all rule still "works", but every unmatched word
    // degrades to one token per character: slow, and impossible to style later.
    // Averages hide this (one long token offsets many single letters), so look
    // for the actual signature - a word chewed letter by letter.
    assert(
      result.splitRun < 3,
      `"${def.id}" split a word into ${result.splitRun} single-character tokens - missing a catch-all rule`,
    );
  }

  // 5. CHAT PARITY. The AI chat highlighter keeps its own fence-tag tables and
  // falls back to this registry for everything else. Assert the fallback is
  // wired (a ```nix block must highlight) and that no hand-written alias
  // contradicts the registry - the exact bug that had ```jl painted as Octave.
  const { highlight, isHighlightable } =
    await import("../src/components/ai-elements/chat-code-lezer");

  for (const tag of [
    // These six lost their hand-written chat entries and now rely entirely on
    // the registry fallback, so they are the ones that would break silently.
    "odin",
    "zig",
    "nim",
    "solidity",
    "gleam",
    "hare",
    "nix",
    "makefile",
    "elixir",
    "mojo",
    "wgsl",
    "batch",
    "vim",
    "lean",
    "move",
    "cairo",
    "vyper",
    "julia",
    "clojure",
    "vhdl",
    "cmake",
    "glsl",
    "bicep",
    "just",
    "starlark",
    "prolog",
  ]) {
    assert(isHighlightable(tag), `chat cannot highlight \`\`\`${tag}`);
    const nodes = await highlight("x = 1\n", tag);
    assert(nodes !== null, `chat highlight("${tag}") returned null`);
  }

  // Alias and registry must agree, or one surface silently uses a different
  // grammar than the other for the same snippet.
  const parity: [string, string][] = [
    ["jl", "julia"],
    ["gql", "graphql"],
    ["lisp", "commonlisp"],
    ["cl", "commonlisp"],
    ["vhd", "vhdl"],
    ["ex", "elixir"],
    ["nu", "nushell"],
    ["tf", "terraform"],
    ["conf", "ini"],
    ["erb", "html"],
    // `.v` is Verilog on both surfaces, even though a language with the id "v"
    // (vlang) exists and would otherwise win the chat's name lookup.
    ["v", "verilog"],
  ];
  const juliaish = 'struct P\n  x::Int\nend\nfunction f(a)\n  return "hi"\nend\n';
  for (const [short, long] of parity) {
    const a = await highlight(juliaish, short);
    const b = await highlight(juliaish, long);
    assert(
      JSON.stringify(a) === JSON.stringify(b),
      `chat tag "${short}" resolves to a different grammar than "${long}"`,
    );
  }

  const covered = Object.keys(SAMPLES).filter((id) => ids.has(id)).length;
  for (const id of Object.keys(SAMPLES)) {
    assert(ids.has(id), `SAMPLES has "${id}" but the registry does not`);
  }
  console.log(
    `Loaded ${LANGUAGES.length} languages (${streamCount} stream parsers), tokenized ${covered} samples`,
  );

  // `throw` (not process.exit) for a non-zero exit, matching the other verify scripts.
  if (failed > 0) throw new Error(`${failed} language check(s) failed`);
  console.log("all language checks passed");
}

void main();
