/**
 * Split a unified patch into per-file blocks for the pull-request review view.
 *
 * `gh pr diff` prints one `git diff` for the whole pull request, and a review
 * is read one file at a time, so the patch is cut apart here rather than
 * rendered as one 30,000-line wall. Pure text in, plain data out: no CodeMirror
 * and no git, so `scripts/scm/gh-stack-verify.ts` can assert the parse against real
 * patch shapes (rename, binary, new file, deletion) without a repository.
 *
 * Deliberately NOT a diff parser. Hunk headers, context and both change signs
 * are kept as lines exactly as git printed them; the view colours them by first
 * character. Rebuilding the two sides to feed a side-by-side MergeView would
 * need the base and head blobs to exist locally, which is exactly the fetch a
 * review is supposed to avoid.
 */

export type PatchFile = {
  /** Path on the head side; for a deletion, the path that was removed. */
  path: string;
  /** Set only for a rename or copy, so the view can show `old -> new`. */
  oldPath: string | null;
  /** The hunk lines, headers included, exactly as git printed them. */
  lines: string[];
  additions: number;
  deletions: number;
  /** git printed no hunks for it, so there is nothing to colour. */
  binary: boolean;
};

/** `a/src/x.ts` -> `src/x.ts`. git also emits `/dev/null` for an add/delete. */
function stripPrefix(raw: string): string {
  const p = raw.trim();
  if (p === "/dev/null") return "";
  return p.replace(/^[ab]\//, "");
}

/**
 * The path out of a `diff --git a/x b/y` line, used only when the block has no
 * `+++` line (a pure rename, or a mode change). Paths containing a space make
 * this ambiguous, which is why it is the fallback and not the primary source.
 */
function pathFromHeader(line: string): string {
  const rest = line.slice("diff --git ".length);
  const half = Math.floor(rest.length / 2);
  return stripPrefix(rest.slice(half + 1) || rest);
}

export function splitPatch(raw: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | null = null;
  let inHunks = false;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = {
        path: pathFromHeader(line),
        oldPath: null,
        lines: [],
        additions: 0,
        deletions: 0,
        binary: false,
      };
      files.push(current);
      inHunks = false;
      continue;
    }
    if (!current) continue;

    if (!inHunks) {
      // The header block. `+++`/`---` carry the authoritative paths, and
      // `rename from` is the only place the old path appears when the file was
      // moved without being touched.
      if (line.startsWith("+++ ")) {
        const p = stripPrefix(line.slice(4));
        if (p) current.path = p;
        continue;
      }
      if (line.startsWith("--- ")) {
        const p = stripPrefix(line.slice(4));
        // A deletion has no `+++` path, so the old one has to stand in.
        if (p && !current.path) current.path = p;
        continue;
      }
      if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
        current.oldPath = stripPrefix(line.slice(line.indexOf("from ") + 5));
        continue;
      }
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        current.binary = true;
        continue;
      }
      if (line.startsWith("@@")) {
        inHunks = true;
        // falls through to the body below
      } else {
        continue;
      }
    }

    // Body. A trailing empty line from the final split is not part of the patch.
    if (line === "" && current.lines.length === 0) continue;
    current.lines.push(line);
    // `+++`/`---` never reach here (they are consumed above), so a bare
    // first character is enough to tell a change from context.
    if (line.startsWith("+")) current.additions++;
    else if (line.startsWith("-")) current.deletions++;
  }

  // git ends the last block with a newline, which the split turns into one
  // empty trailing line per file. Drop it rather than rendering a blank row.
  for (const f of files) {
    while (f.lines.length > 0 && f.lines[f.lines.length - 1] === "") f.lines.pop();
  }
  return files;
}

/** How a patch line should be coloured. */
export type PatchLineKind = "add" | "del" | "hunk" | "context" | "meta";

export function patchLineKind(line: string): PatchLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  // git prints this after a hunk whose last line has no newline; it is not
  // content and must not read as context.
  if (line.startsWith("\\ No newline")) return "meta";
  return "context";
}

// ---- Hunk-level staging ----------------------------------------------------
//
// Everything below turns ONE file's `git diff` into hunks, and a chosen hunk
// back into a patch narrow enough to hand `git apply --cached`. It is the whole
// of partial staging: git does the applying, this only decides what to send.
//
// Two rules keep it from corrupting the index:
//
//  1. A WHOLE hunk is emitted VERBATIM. No line arithmetic runs at all in the
//     common case, so the common case cannot have an arithmetic bug.
//  2. A hunk is addressed by its INDEX in the parsed list, never by matching its
//     text. A file with repeated lines has hunks that look identical, and
//     matching on content is how you stage one hunk and unstage a different one.

/** One `@@` block. `lines` excludes the header and keeps git's leading sign. */
export type Hunk = {
  /** The `@@ -a,b +c,d @@ trailing` line, verbatim. */
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
  additions: number;
  deletions: number;
  /**
   * The hunk carries a `\ No newline at end of file` marker.
   *
   * Line-level selection is refused for these. The marker belongs to whichever
   * side the line before it was on, so dropping or re-signing that line makes
   * the marker describe something else - which is a corrupted file, not a
   * failed apply. The whole hunk still stages, because that path is verbatim.
   */
  hasNoNewline: boolean;
};

export type FileDiff = {
  /** `diff --git` through `+++`, verbatim. `git apply` needs all of it. */
  header: string[];
  hunks: Hunk[];
};

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse the output of `git diff [--cached] -- <one path>`.
 *
 * Returns null when there is nothing to stage piecemeal: no diff, or a diff
 * with no hunks (a binary file, or a pure mode/rename change).
 */
export function parseFileDiff(raw: string): FileDiff | null {
  const header: string[] = [];
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;

  for (const line of raw.split("\n")) {
    const m = HUNK_RE.exec(line);
    if (m) {
      current = {
        header: line,
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
        additions: 0,
        deletions: 0,
        hasNoNewline: false,
      };
      hunks.push(current);
      continue;
    }
    if (!current) {
      // Still in the preamble. The trailing empty line of the final split is
      // not part of it.
      if (line !== "") header.push(line);
      continue;
    }
    if (line.startsWith("\\")) {
      current.hasNoNewline = true;
      current.lines.push(line);
      continue;
    }
    // git ends the diff with a newline, so the split yields one trailing empty
    // line. A real context line is " ", never "".
    if (line === "") continue;
    current.lines.push(line);
    if (line.startsWith("+")) current.additions++;
    else if (line.startsWith("-")) current.deletions++;
  }

  if (hunks.length === 0 || header.length === 0) return null;
  return { header, hunks };
}

/** Which body lines of a hunk a user can pick. Context lines are not choices. */
export function isSelectableLine(line: string): boolean {
  return line.startsWith("+") || line.startsWith("-");
}

/**
 * A patch containing exactly one hunk, ready for `git apply`.
 *
 * `selected` holds indices into `hunk.lines`. Pass null (or a set covering every
 * changed line) for the whole hunk, which is emitted verbatim.
 *
 * For a subset, the rewrite is:
 *   - a chosen `+` stays, an unchosen `+` is DROPPED (the index never sees it);
 *   - a chosen `-` stays, an unchosen `-` becomes CONTEXT (the index keeps it);
 *   - context is untouched.
 * The header counts are then recomputed from what survived, because the old and
 * new line totals both changed. `newStart` is set to `oldStart`: the hunk is
 * applied on its own against the old tree, so any offset the original header
 * carried came from other hunks that are not in this patch.
 */
export function buildHunkPatch(
  diff: FileDiff,
  hunkIndex: number,
  selected: ReadonlySet<number> | null,
): string {
  const hunk = diff.hunks[hunkIndex];
  if (!hunk) throw new Error(`no hunk at index ${hunkIndex}`);

  const changed = hunk.lines.reduce((n, l) => (isSelectableLine(l) ? n + 1 : n), 0);
  const chosen = selected
    ? hunk.lines.filter((l, i) => isSelectableLine(l) && selected.has(i)).length
    : changed;
  if (chosen === 0) throw new Error("nothing selected");

  // Whole hunk: verbatim, no arithmetic.
  if (!selected || chosen === changed) {
    return [...diff.header, hunk.header, ...hunk.lines, ""].join("\n");
  }
  if (hunk.hasNoNewline) {
    throw new Error("This hunk changes the file's final newline, so it can only be staged whole.");
  }

  const out: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  for (let i = 0; i < hunk.lines.length; i++) {
    const line = hunk.lines[i];
    if (line.startsWith("+")) {
      if (!selected.has(i)) continue; // never existed as far as this patch says
      out.push(line);
      newCount++;
    } else if (line.startsWith("-")) {
      if (selected.has(i)) {
        out.push(line);
        oldCount++;
      } else {
        // Keep the line on BOTH sides: this patch is not removing it.
        out.push(` ${line.slice(1)}`);
        oldCount++;
        newCount++;
      }
    } else {
      out.push(line);
      oldCount++;
      newCount++;
    }
  }

  const header = `@@ -${hunk.oldStart},${oldCount} +${hunk.oldStart},${newCount} @@`;
  return [...diff.header, header, ...out, ""].join("\n");
}
