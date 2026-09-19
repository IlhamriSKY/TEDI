/**
 * Self-check for the workspace-root project memory: that BOTH `AGENTS.md` and
 * `TEDI.md` are read, how the shared budget is split, and that an edit to either
 * one invalidates the cache.
 *
 * `transport.ts` only wraps these in a 30s cache; its import chain needs a
 * browser, so the selection and the reads are driven here against a FAKE
 * filesystem. That is what makes "it reads AGENTS.md too" a proof rather than a
 * claim: the reader is the real one, only the IO is stubbed.
 * Run: `npx tsx scripts/ai/project-memory-verify.ts`.
 */
import {
  assembleProjectMemory,
  boundProjectMemory,
  projectMemoryRootOf,
  selectProjectMemoryDocs,
  PROJECT_MEMORY_FILES,
  PROJECT_MEMORY_PRELOAD_BYTES,
} from "../../src/modules/ai/lib/projectMemory";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ok: ${msg}`);
  else {
    console.error(`  FAIL: ${msg}`);
    failed++;
  }
}

/** A fake workspace root. `files` is name -> contents; the reader gets the same
 *  `{kind:"text"}` shape `native.readFile` returns, and records every path so a
 *  doc that is never opened cannot pass silently. */
function fakeRoot(files: Record<string, string>) {
  const opened: string[] = [];
  const entries = Object.keys(files).map((name) => ({ name, kind: "file" as const }));
  const readFile = async (path: string) => {
    opened.push(path);
    const name = path.slice(path.lastIndexOf("/") + 1);
    const content = files[name];
    return content === undefined ? { kind: "binary" } : { kind: "text", content };
  };
  return { entries, readFile, opened };
}

console.log("[both docs] AGENTS.md is read alongside TEDI.md, TEDI.md last");
{
  const fs = fakeRoot({
    "AGENTS.md": "# Agents\n\nuse pnpm.",
    "TEDI.md": "# Tedi\n\ntwo processes.",
    "README.md": "# Readme\n\nnot memory.",
  });
  const docs = selectProjectMemoryDocs(fs.entries);
  assert(
    docs.map((d) => d.name).join(",") === "AGENTS.md,TEDI.md",
    "both are selected, AGENTS.md first",
  );
  const out = (await assembleProjectMemory("d:/repo", docs, fs.readFile)) ?? "";
  assert(fs.opened.length === 2, "exactly two files were opened, no README.md");
  assert(out.includes("use pnpm.") && out.includes("two processes."), "both bodies made it out");
  assert(
    out.indexOf("### AGENTS.md") < out.indexOf("### TEDI.md"),
    "each is labelled, and TEDI.md lands LAST (nearest the conversation)",
  );
}

console.log("\n[one doc] a repo with only one of them still works");
for (const only of PROJECT_MEMORY_FILES) {
  const fs = fakeRoot({ [only]: `# ${only}\n\nbody.` });
  const docs = selectProjectMemoryDocs(fs.entries);
  const out = await assembleProjectMemory("d:/repo", docs, fs.readFile);
  assert(docs.length === 1 && (out ?? "").includes("body."), `${only} alone is preloaded`);
}
{
  const fs = fakeRoot({ "README.md": "# nope" });
  const out = await assembleProjectMemory(
    "d:/repo",
    selectProjectMemoryDocs(fs.entries),
    fs.readFile,
  );
  assert(out === null, "a repo with neither doc preloads nothing (not an empty block)");
}

console.log("\n[case] a doc the OS hands back differently cased is still found");
{
  const fs = fakeRoot({ "Agents.md": "# a\n\nfound anyway." });
  const docs = selectProjectMemoryDocs(fs.entries);
  const out = (await assembleProjectMemory("d:/repo", docs, fs.readFile)) ?? "";
  assert(docs.length === 1, "Agents.md matches AGENTS.md");
  assert(out.includes("### Agents.md"), "and is labelled with its REAL on-disk name");
}

console.log("\n[budget] shared across the docs that exist, never one each");
{
  const big = `# One\n${"x".repeat(200_000)}`;
  const one = fakeRoot({ "TEDI.md": big });
  const two = fakeRoot({ "AGENTS.md": big, "TEDI.md": big });
  const oneOut =
    (await assembleProjectMemory("d:/r", selectProjectMemoryDocs(one.entries), one.readFile)) ?? "";
  const twoOut =
    (await assembleProjectMemory("d:/r", selectProjectMemoryDocs(two.entries), two.readFile)) ?? "";
  assert(oneOut.length < PROJECT_MEMORY_PRELOAD_BYTES * 1.05, "one doc stays within budget");
  assert(
    twoOut.length < PROJECT_MEMORY_PRELOAD_BYTES * 1.1,
    "two docs TOGETHER stay within the same budget, so adding AGENTS.md cannot double the bill",
  );
  assert(
    twoOut.includes("AGENTS.md is truncated") && twoOut.includes("TEDI.md is truncated"),
    "the read-on-demand pointer names the file it cut",
  );
}

console.log("\n[bounding] a doc under budget is passed through untouched");
const small = "# Small\n\nnothing to cut here.";
assert(boundProjectMemory(small, 4096, "TEDI.md") === small, "no note, no truncation");
assert(
  boundProjectMemory(
    `# A\n${"a".repeat(3000)}\n## B\n${"b".repeat(3000)}`,
    4096,
    "TEDI.md",
  ).includes("## B") === false,
  "cuts at a header boundary, so a section is never half-delivered",
);
// The floor: a doc whose FIRST section runs past the budget has no usable header
// cut, and must still deliver most of the budget rather than a handful of bytes.
assert(
  boundProjectMemory(`# Only\n${"z".repeat(50_000)}`, 4096, "TEDI.md").length > 3000,
  "a doc with no usable boundary still fills the budget",
);

console.log("\n[invalidation] an edit to either doc clears that workspace");
assert(projectMemoryRootOf("d:/repo/tedi.md") === "d:/repo", "TEDI.md maps to its root");
assert(projectMemoryRootOf("d:/repo/agents.md") === "d:/repo", "AGENTS.md maps to its root");
assert(projectMemoryRootOf("d:/repo/src/agents.md") === "d:/repo/src", "a nested one, to its own");
assert(projectMemoryRootOf("d:/repo/readme.md") === null, "an unrelated doc is not memory");
assert(projectMemoryRootOf("d:/repo/my-agents.md") === null, "a suffix match is not a filename");

console.log(failed === 0 ? "\nAll project-memory checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
