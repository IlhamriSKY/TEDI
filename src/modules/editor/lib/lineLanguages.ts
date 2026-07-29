/**
 * Line-oriented grammars: Makefile, Batch, Vimscript, Apache config and Prolog.
 *
 * These cannot ride `clike` at all - their meaning depends on column position
 * (a Makefile target at column 0, a recipe behind a hard tab) or on a character
 * that is a comment in one place and a string in another (Vimscript's `"`). They
 * use `simpleMode`, a rule list evaluated in order, and every one of them must
 * end with {@link SIMPLE_TAIL}.
 */

import { simpleMode } from "@codemirror/legacy-modes/mode/simple-mode";

const SIMPLE_TAIL = [
  { regex: /[A-Za-z_][\w.-]*/, token: null },
  { regex: /\s+/, token: null },
  { regex: /\S/, token: null },
];

// ── Makefile ─────────────────────────────────────────────────────────────────
// https://www.gnu.org/software/make - line-oriented rather than token-oriented
// (targets at column 0, recipes behind a hard tab), which is exactly the shape
// clike cannot see, so this and the four below use `simpleMode` instead.

export const makefile = simpleMode({
  start: [
    { regex: /#.*/, token: "comment" },
    // A recipe line: hard tab, then optional @ / - / + silencing prefixes.
    { sol: true, regex: /\t[-@+]*/, token: "meta" },
    {
      regex:
        /\.(?:PHONY|DEFAULT|DEFAULT_GOAL|PRECIOUS|INTERMEDIATE|SECONDARY|SECONDEXPANSION|SUFFIXES|DELETE_ON_ERROR|IGNORE|LOW_RESOLUTION_TIME|SILENT|EXPORT_ALL_VARIABLES|NOTPARALLEL|ONESHELL|POSIX|RECIPEPREFIX)\b/,
      token: "meta",
    },
    {
      regex:
        /\b(?:ifeq|ifneq|ifdef|ifndef|else|endif|define|endef|undefine|include|sinclude|export|unexport|override|vpath|private)\b|-include\b/,
      token: "keyword",
    },
    // `NAME =` / `NAME :=` / `NAME ?=` assignment target.
    { sol: true, regex: /[A-Za-z_][\w.-]*(?=\s*[:+?!]?=)/, token: "def" },
    // A rule target: everything up to a `:` that is not part of `:=`.
    { sol: true, regex: /[^\s:=#][^:=#]*(?=:(?!=))/, token: "def" },
    { regex: /\$[({][^)}\n]*[)}]|\$[@<^+?*%$]|\$\w/, token: "variable-2" },
    {
      regex:
        /\b(?:wildcard|patsubst|subst|strip|findstring|filter-out|filter|sort|wordlist|words|word|firstword|lastword|notdir|dir|suffix|basename|addsuffix|addprefix|join|realpath|abspath|foreach|call|value|eval|origin|flavor|shell|error|warning|info|file|guile)\b/,
      token: "builtin",
    },
    { regex: /"(?:[^\\"]|\\.)*"?|'(?:[^\\']|\\.)*'?/, token: "string" },
    { regex: /[:+?!]?=|::?|;|\|/, token: "operator" },
    ...SIMPLE_TAIL,
  ],
  languageData: { commentTokens: { line: "#" } },
});

// ── Batch ────────────────────────────────────────────────────────────────────
// https://learn.microsoft.com/windows-server/administration/windows-commands -
// `REM` / `::` comments, `%VAR%` and `!VAR!` expansion, `:label` targets.

export const batch = simpleMode({
  start: [
    { sol: true, regex: /\s*(?:@?rem\b.*|::.*)/i, token: "comment" },
    { sol: true, regex: /\s*:[\w.-]+/, token: "def" },
    { regex: /@/, token: "meta" },
    {
      regex:
        /\b(?:if|else|for|in|do|goto|call|exit|set|setlocal|endlocal|shift|start|pause|echo|cls|title|color|pushd|popd|verify|rem|defined|exist|not|errorlevel|equ|neq|lss|leq|gtr|geq)\b/i,
      token: "keyword",
    },
    {
      regex:
        /\b(?:dir|cd|chdir|copy|xcopy|robocopy|move|del|erase|md|mkdir|rd|rmdir|ren|rename|type|find|findstr|sort|more|attrib|tasklist|taskkill|sc|net|reg|wmic|ping|ipconfig|curl|powershell|where|timeout|choice|assoc|ftype|subst|fc|comp|clip|forfiles|schtasks)\b/i,
      token: "builtin",
    },
    { regex: /%(?:~[\w$:]*)?[\w#$*]+%?|![\w#$*]+!|%%?~?\w/, token: "variable-2" },
    { regex: /"(?:[^"\n]|"")*"?/, token: "string" },
    { regex: /\b\d+\b/, token: "number" },
    { regex: /[|&<>^=]+/, token: "operator" },
    // A mid-line `goto :label` reference (the `sol` rule above defines them).
    { regex: /:[\w.-]+/, token: "def" },
    ...SIMPLE_TAIL,
  ],
  languageData: { commentTokens: { line: "REM" } },
});

// ── Vim script ───────────────────────────────────────────────────────────────
// https://vimhelp.org/usr_41.txt - `"` starts a comment where a command would
// start, which is why this cannot ride a generic tokenizer: the same character
// opens a string mid-line.

export const vim = simpleMode({
  start: [
    { sol: true, regex: /\s*".*/, token: "comment" },
    { sol: true, regex: /\s*#.*/, token: "comment" }, // vim9script comments
    {
      regex:
        /\b(?:if|elseif|else|endif|while|endwhile|for|endfor|try|catch|finally|endtry|throw|function|endfunction|endfunc|return|let|unlet|const|var|final|call|execute|normal|source|runtime|set|setlocal|setglobal|autocmd|augroup|command|silent|redir|finish|break|continue|echo|echom|echomsg|echoerr|echohl|highlight|syntax|filetype|packadd|colorscheme|def|enddef|vim9script|export|import|abstract|class|endclass|enum|endenum|interface|endinterface|this|super|static|public)\b/,
      token: "keyword",
    },
    {
      regex: /\b(?:[nvxsoilct]?(?:nore)?map|[nvxsoilct]?(?:nore)?abbrev|[nvxsoilct]?unmap)\b/,
      token: "keyword",
    },
    { regex: /\b[gbwtslav]:[\w#]+|\$[A-Z_]+|&[\w]+|@[\w"]/, token: "variable-2" },
    {
      regex:
        /\b(?:has|exists|empty|len|type|string|split|join|map|filter|sort|reverse|add|extend|get|keys|values|items|substitute|matchstr|match|stridx|strpart|strlen|printf|expand|fnamemodify|bufnr|bufname|winnr|line|col|getline|setline|append|input|confirm|system|systemlist|glob|globpath|readfile|writefile|localtime|strftime|nvim_create_autocmd|luaeval|v)\b(?=\()/,
      token: "builtin",
    },
    { regex: /'(?:[^']|'')*'|"(?:[^"\\\n]|\\.)*"/, token: "string" },
    { regex: /\b(?:0[xX][\da-fA-F]+|\d+(?:\.\d+)?)\b/, token: "number" },
    { regex: /\b(?:v:true|v:false|v:null|v:none|true|false|null)\b/, token: "atom" },
    { regex: /=~#?|!~#?|==#?|!=#?|[<>]=?|[-+*/%.]=?|\|\||&&|\.\.=?|=/, token: "operator" },
    ...SIMPLE_TAIL,
  ],
  languageData: { commentTokens: { line: '"' } },
});

// ── Apache config ────────────────────────────────────────────────────────────
// https://httpd.apache.org/docs/current/configuring.html - `<Section>` blocks
// plus one directive per line, so the leading word on every line is the
// directive regardless of which module defines it.

export const apacheconf = simpleMode({
  start: [
    { regex: /#.*/, token: "comment" },
    { regex: /<\/?[A-Za-z_]\w*/, token: "tag" },
    { regex: />/, token: "tag" },
    { sol: true, regex: /\s*[A-Za-z_]\w*/, token: "keyword" },
    { regex: /"(?:[^"\\]|\\.)*"?/, token: "string" },
    { regex: /\$\{?\w+\}?|%\{[\w:]+\}/, token: "variable-2" },
    { regex: /\b(?:[Oo]n|[Oo]ff|[Aa]ll|[Nn]one|[Yy]es|[Nn]o)\b/, token: "atom" },
    { regex: /\b\d+\b/, token: "number" },
    { regex: /[!=<>~^$|+?*]+/, token: "operator" },
    // Paths and globs are the bulk of a vhost file; keep each one token.
    { regex: /[\w./*-]+/, token: null },
    ...SIMPLE_TAIL,
  ],
  languageData: { commentTokens: { line: "#" } },
});

// ── Prolog ───────────────────────────────────────────────────────────────────
// https://www.swi-prolog.org - `%` line comments, `/* */` blocks, and the
// defining trait that capitalized identifiers are variables while lowercase
// ones are atoms.

export const prolog = simpleMode({
  start: [
    { regex: /%.*/, token: "comment" },
    { regex: /\/\*/, token: "comment", push: "blockComment" },
    {
      regex:
        /\b(?:is|mod|rem|div|xor|abs|max|min|not|fail|halt|assert|asserta|assertz|retract|retractall|findall|bagof|setof|aggregate_all|forall|between|succ_or_zero|length|append|member|memberchk|nth0|nth1|last|reverse|msort|sort|predsort|permutation|atom|atomic|number|integer|float|var|nonvar|compound|callable|is_list|atom_codes|atom_chars|atom_number|atom_string|number_codes|char_code|sub_atom|write|writeln|write_canonical|print|nl|read|read_term|format|tab|catch|throw|call|once|ignore|dynamic|discontiguous|multifile|module|use_module|ensure_loaded|initialization|op|succ_throw)\b/,
      token: "keyword",
    },
    { regex: /:-|-->|\?-|=\.\.|\\\+|@?[<>]=?|=[<@]?|\\==?|\bis\b/, token: "operator" },
    { regex: /\b[A-Z_]\w*/, token: "variable-2" },
    { regex: /'(?:[^'\\]|\\.|'')*'/, token: "string" },
    { regex: /"(?:[^"\\]|\\.)*"/, token: "string" },
    { regex: /0'(?:\\.|.)|0[xob][\da-fA-F]+|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/, token: "number" },
    { regex: /\b[a-z]\w*/, token: "atom" },
    { regex: /[[\](){}]/, token: "bracket" },
    ...SIMPLE_TAIL,
  ],
  blockComment: [
    { regex: /.*?\*\//, token: "comment", pop: true },
    { regex: /.*/, token: "comment" },
  ],
  languageData: { commentTokens: { line: "%", block: { open: "/*", close: "*/" } } },
});
