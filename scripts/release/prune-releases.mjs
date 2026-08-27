#!/usr/bin/env node
/**
 * Keep the N newest GitHub releases per repo and delete the rest.
 *
 * DRY RUN BY DEFAULT. Pass `--yes` to actually delete. Deleting a release is
 * irreversible and takes its assets with it: for the core repo that is the
 * signed installers, which cannot be rebuilt without re-running the tag's
 * release workflow.
 *
 * Git TAGS are deliberately left alone. They cost nothing, they are the actual
 * history, and keeping them means a deleted release can be rebuilt by
 * re-pushing the tag. Pass `--tags` to delete those too.
 *
 * Ordering is by the release's own creation time, NOT by tag name: a semver
 * sort would need a parser and would be wrong the moment a tag does not parse.
 * Drafts are never deleted (a draft is work in progress, not history).
 *
 *   node scripts/release/prune-releases.mjs                 # dry run, default keeps
 *   node scripts/release/prune-releases.mjs --yes           # delete
 *   node scripts/release/prune-releases.mjs --core 10 --ext 5 --yes
 */
import { execFileSync } from "node:child_process";

const OWNER = "IlhamriSKY";
const CORE = "TEDI";
const EXTENSIONS = [
  "TEDI.ai-usage",
  "TEDI.api-client",
  "TEDI.beautify",
  "TEDI.discord-rich-presence",
  "TEDI.remote-access",
  "TEDI.rtk-bridge",
  "TEDI.screenshot",
  "TEDI.secondary-folder-tree",
  "TEDI.sql-explorer",
];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
};
const APPLY = argv.includes("--yes");
const ALSO_TAGS = argv.includes("--tags");
const KEEP_CORE = flag("core", 10);
const KEEP_EXT = flag("ext", 5);

const gh = (args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });

function releases(repo) {
  const raw = gh(["api", `repos/${OWNER}/${repo}/releases?per_page=100`, "--paginate"]);
  // `--paginate` concatenates JSON arrays; join them back into one list.
  const merged = JSON.parse(`[${raw.trim().replace(/\]\s*\[/g, ",")}]`.replace(/^\[\[/, "[").replace(/\]\]$/, "]"));
  const flat = Array.isArray(merged[0]) ? merged.flat() : merged;
  return flat
    .filter((r) => !r.draft)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

let deleted = 0;
let kept = 0;
for (const [repo, keep] of [[CORE, KEEP_CORE], ...EXTENSIONS.map((e) => [e, KEEP_EXT])]) {
  let list;
  try {
    list = releases(repo);
  } catch (err) {
    console.error(`  !! ${repo}: ${String(err.message).split("\n")[0]}`);
    continue;
  }
  const doomed = list.slice(keep);
  kept += Math.min(list.length, keep);
  console.log(`${repo}: ${list.length} published, keeping ${Math.min(list.length, keep)}, removing ${doomed.length}`);
  for (const r of doomed) {
    console.log(`    ${APPLY ? "delete" : "would delete"} ${r.tag_name}  (${r.created_at.slice(0, 10)}, ${r.assets.length} assets)`);
    if (!APPLY) continue;
    gh(["api", "--method", "DELETE", `repos/${OWNER}/${repo}/releases/${r.id}`]);
    if (ALSO_TAGS) {
      try {
        gh(["api", "--method", "DELETE", `repos/${OWNER}/${repo}/git/refs/tags/${r.tag_name}`]);
      } catch {
        // Tag already gone, or never existed as a ref. Not fatal.
      }
    }
    deleted++;
  }
}

console.log(
  `\n${APPLY ? "deleted" : "would delete"} ${APPLY ? deleted : "the above"}, kept ${kept}` +
    (ALSO_TAGS ? " (tags removed too)" : " (git tags left in place)"),
);
if (!APPLY) console.log("dry run — pass --yes to apply");
