/**
 * Turns the `#<ordinal>` terminal references the model writes (it learns them
 * from the `<env>` block: `#392 tab=3 leaf=7 …`) into a clickable element.
 *
 * NOT an `<a>`: with Streamdown's link-safety on (the default) an anchor is
 * rendered as a `<button>` that opens a "leaving the app" modal, and the href
 * never reaches the DOM - so neither a delegated `a[href]` handler nor an
 * `a[href]` CSS rule could ever see it. A private tag mapped through
 * `components` sidesteps that entirely, and `hast-util-to-jsx-runtime` resolves
 * `components[tagName]` with a plain lookup, no allowlist.
 *
 * The ordinal is carried in the element's TEXT (`#392`), not an attribute, so
 * nothing depends on how hast property names survive the JSX conversion.
 *
 * Only ordinals that match a LIVE terminal are converted, so "issue #12" and
 * "PR #407" stay plain text.
 */

/** Private tag the plugin emits; map it in Streamdown's `components`. */
export const TERM_REF_TAG = "tedi-term";

/** Minimal hast shape. `@types/hast` isn't a dependency and this walks only
 *  `children` / `value` / `tagName`, so a local structural type is enough. */
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

const REF_RE = /#(\d{1,6})\b/g;

function linkifyChildren(node: HastNode, ordinals: ReadonlySet<number>): void {
  const kids = node.children;
  if (!kids) return;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    if (child.type === "element") {
      // `pre` holds fenced code (must stay verbatim); `a` is a real link whose
      // own label must not sprout a nested control; TERM_REF_TAG is one we
      // already made, and its text is still `#392` - descending would wrap it a
      // second time on any re-run over the same tree. Inline `code` IS descended
      // into - the model often writes the reference as `` `#392` ``.
      if (child.tagName === "pre" || child.tagName === "a" || child.tagName === TERM_REF_TAG)
        continue;
      linkifyChildren(child, ordinals);
      continue;
    }
    if (child.type !== "text" || !child.value) continue;

    const text = child.value;
    const parts: HastNode[] = [];
    let last = 0;
    REF_RE.lastIndex = 0;
    for (let m = REF_RE.exec(text); m; m = REF_RE.exec(text)) {
      const ordinal = Number(m[1]);
      if (!ordinals.has(ordinal)) continue;
      if (m.index > last) parts.push({ type: "text", value: text.slice(last, m.index) });
      parts.push({
        type: "element",
        tagName: TERM_REF_TAG,
        properties: {},
        children: [{ type: "text", value: m[0] }],
      });
      last = m.index + m[0].length;
    }
    if (parts.length === 0) continue;
    if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
    kids.splice(i, 1, ...parts);
    i += parts.length - 1;
  }
}

/**
 * Rehype plugin factory. `getOrdinals` is read at transform time (not at
 * construction) so the caller can hand over a live snapshot without making the
 * plugin array unstable.
 */
export function rehypeTerminalRefs(getOrdinals: () => ReadonlySet<number>) {
  return () => (tree: HastNode) => {
    const ordinals = getOrdinals();
    if (ordinals.size > 0) linkifyChildren(tree, ordinals);
  };
}
