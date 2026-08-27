/**
 * Self-check for the `#<ordinal>` terminal reference and the `>` composer sigil.
 * Run: `npx tsx scripts/workspace/tab-ref-verify.ts`.
 *
 * These two changes are one change: `#` had to stop opening a picker before
 * `#392` could be typed and clicked as a terminal reference. Four things must
 * hold, and each fails silently:
 *  1. `#` no longer arms any picker, so `#392` types straight through, while
 *     `>` arms the one `#` used to.
 *  2. Only ordinals belonging to a LIVE terminal are linkified. Otherwise
 *     "issue #12" and "PR #407" turn into dead chips.
 *  3. The walker never linkifies inside a fenced block (`pre`) or inside an
 *     existing anchor (a real link's label must not sprout a nested control),
 *     but DOES descend into inline `code` - the model usually writes the
 *     reference as `` `#392` ``.
 *  4. Snippet expansion moved to `>handle` and must leave `#392` alone.
 *  5. Streamdown really renders the private tag through `components`. Walking
 *     hast by hand proves nothing about what reaches the DOM, and this is the
 *     part a Streamdown upgrade breaks without a type error: the first attempt
 *     used `<a href>`, which link-safety silently turns into a hrefless
 *     `<button>`. So the last block renders markdown for real.
 */
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown, defaultRehypePlugins } from "streamdown";
import { rehypeTerminalRefs, TERM_REF_TAG } from "../../src/components/ai-elements/terminal-refs";
import { detectPickerTrigger } from "../../src/modules/ai/lib/pickerTrigger";
import { expandSnippetTokens, type Snippet } from "../../src/modules/ai/lib/snippets";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok: ${name}`);
    return;
  }
  console.error(`  FAIL: ${name}`, detail === undefined ? "" : JSON.stringify(detail));
  failed++;
}

// ---------------------------------------------------------------- 1. triggers

console.log("[trigger] `>` replaces `#`, and `#` is free for references");
const at = (v: string) => detectPickerTrigger(v, v.length);
check("`>` opens the tag picker", at(">")?.kind === "tag", at(">"));
check("`>pl` carries the query", at(">pl")?.query === "pl", at(">pl"));
check("`#` opens nothing at all", at("#") === null, at("#"));
check("`#392` opens nothing at all", at("#392") === null, at("#392"));
check("`see #392 there` opens nothing", at("see #392 there") === null);
check("`/` still opens the slash picker", at("/")?.kind === "slash");
check("`@src/f` still opens the mention picker", at("@src/f")?.kind === "mention");
check("mid-word `a>b` does not trigger", at("a>b") === null, at("a>b"));
check("the sigil must follow whitespace", at("x >q")?.kind === "tag", at("x >q"));

// -------------------------------------------------------------- 2..3. walker

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};
const text = (value: string): HastNode => ({ type: "text", value });
const el = (tagName: string, ...children: HastNode[]): HastNode => ({
  type: "element",
  tagName,
  properties: {},
  children,
});

/** Live terminals in the fixtures: 392 and 405. 407 is deliberately absent. */
const LIVE = new Set([392, 405]);
const transform = rehypeTerminalRefs(() => LIVE)();

/** Flatten to a compact string: plain text as-is, a reference chip as `[text]`. */
function render(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === TERM_REF_TAG) {
    return `[${(node.children ?? []).map(render).join("")}]`;
  }
  return (node.children ?? []).map(render).join("");
}
function run(tree: HastNode): string {
  transform(tree);
  return render(tree);
}

console.log("\n[linkify] only ordinals that name a live terminal");
check(
  "a live ordinal becomes an anchor",
  run(el("p", text("3 tab terbuka: #392."))) === "3 tab terbuka: [#392].",
  run(el("p", text("3 tab terbuka: #392."))),
);
check(
  "a dead ordinal stays plain text (issue #407, PR #12)",
  run(el("p", text("see #407 and #12"))) === "see #407 and #12",
  run(el("p", text("see #407 and #12"))),
);
check(
  "several live ordinals in one text node all convert",
  run(el("p", text("#392, #387, #405."))) === "[#392], #387, [#405].",
  run(el("p", text("#392, #387, #405."))),
);
check(
  "the surrounding text survives intact",
  run(el("p", text("a#392b"))) === "a#392b",
  // `a#392` has no word boundary before `#`, but `#392b` has none after either,
  // so `\b` keeps this whole token plain - a bare id is what gets linked.
  run(el("p", text("a#392b"))),
);

console.log("\n[linkify] where the walker must NOT go");
check(
  "inline `code` IS descended into (the model writes `#392`)",
  run(el("p", el("code", text("#392")))) === "[#392]",
  run(el("p", el("code", text("#392")))),
);
check(
  "a fenced block is left verbatim",
  run(el("div", el("pre", el("code", text("echo #392"))))) === "echo #392",
);
check(
  "a real link's own label is left alone",
  run(el("p", el("a", text("#392")))) === "#392",
  run(el("p", el("a", text("#392")))),
);
check(
  "`**#392**` inside strong still converts",
  run(el("li", el("strong", text("#392")), text(" - Tab 3"))) === "[#392] - Tab 3",
);
check(
  "no live terminals at all -> nothing is touched",
  (() => {
    const none = rehypeTerminalRefs(() => new Set<number>())();
    const tree = el("p", text("#392"));
    none(tree);
    return render(tree) === "#392";
  })(),
);
// The chip's own text is still `#392`, so a second pass over an already
// converted tree would wrap it again and render a chip inside a chip.
check(
  "running the transform twice does not nest a chip inside a chip",
  (() => {
    const tree = el("p", text("#392"));
    transform(tree);
    transform(tree);
    return render(tree) === "[#392]";
  })(),
);

// ------------------------------------------------------------- 4. snippets

console.log("\n[snippets] handles moved to `>`, `#` is inert");
const SNIPS: Snippet[] = [
  { id: "1", handle: "review", name: "Review", description: "", content: "REVIEW BODY" },
];
const viaGt = expandSnippetTokens("please >review this", SNIPS);
check("`>review` expands", viaGt.blocks.length === 1 && viaGt.body === "please  this", viaGt);
const viaHash = expandSnippetTokens("please #review this", SNIPS);
check(
  "`#review` no longer expands",
  viaHash.blocks.length === 0 && viaHash.body === "please #review this",
  viaHash,
);
const withRef = expandSnippetTokens("check #392 and >review", SNIPS);
check(
  "a `#392` reference passes through expansion untouched",
  withRef.body.includes("#392") && withRef.blocks.length === 1,
  withRef,
);

// ------------------------------------------------------- 5. rendered for real

console.log("\n[render] Streamdown renders the private tag through `components`");
const rendered = renderToStaticMarkup(
  createElement(
    Streamdown,
    {
      mode: "static",
      rehypePlugins: [
        ...Object.values(defaultRehypePlugins),
        rehypeTerminalRefs(() => new Set([392, 405])),
      ],
      components: {
        // Streamdown types every `components` entry as taking a loose prop bag.
        [TERM_REF_TAG]: (props: Record<string, unknown>) =>
          createElement(
            "button",
            { type: "button", "data-term-chip": "1" },
            props.children as ReactNode,
          ),
      },
    },
    "3 tab terbuka: `#392`, #387, **#405**. Link: [#392](https://x.test)",
  ),
);
const chips = rendered.match(/data-term-chip/g)?.length ?? 0;
check("both live refs reach the DOM as the mapped component", chips === 2, { chips, rendered });
check("the chip keeps its label", rendered.includes(">#392</button>"), rendered);
check("a dead ordinal is still plain text after rendering", !rendered.includes(">#387<"), rendered);
check(
  "a real markdown link is untouched (no chip inside it)",
  rendered.includes('data-streamdown="link"') &&
    !/data-streamdown="link"[^>]*>\s*<button[^>]*data-term-chip/.test(rendered),
  rendered,
);

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
