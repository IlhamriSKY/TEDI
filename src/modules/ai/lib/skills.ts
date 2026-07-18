import { invoke } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { native, type DirEntry } from "./native";
import { subscribeSkillPathChanges } from "./skillCache";
import {
  removeSkillState,
  removeGroupStates,
  setSkillStates,
  getAllSkillStates,
  type SkillState,
} from "./skillState";

/**
 * File-based AI "skills". A skill is a folder with a `SKILL.md` whose YAML
 * frontmatter carries `name` + `description`:
 *
 *   .tedi/skills/<slug>/SKILL.md
 *
 * Two roots are scanned: the user-global `~/.tedi/skills` (what the Settings
 * installer writes to) and the workspace `<root>/.tedi/skills` (project skills,
 * committed like `.github`). The name + description are injected into the system
 * prompt; the agent loads the full SKILL.md on demand via its existing
 * `read_file` tool (progressive disclosure), so no new tool is needed.
 */
export type SkillMeta = {
  name: string;
  description: string;
  path: string;
  dir: string;
  /** Source group (the install folder / repo name), or "" for a top-level skill. */
  group: string;
  /** Optional `argument-hint` from frontmatter, e.g. `[lite|full|ultra]`. */
  argHint?: string;
  /** Frontmatter version string if declared (e.g. `1.0.0`). */
  version?: string | null;
  /** Dependencies: other skill slugs this skill requires. */
  requires?: string[];
  /** Runtime state (from skillState store). */
  state?: SkillState | null;
  /** Disambiguated invocation slug set by loadSkills when two skills share a
   *  bare leaf slug. When present, skillSlug() returns this instead of the leaf
   *  so neither skill is silently shadowed in the `skill` tool / slash picker. */
  slugOverride?: string;
};

/** Preview result for a GitHub repo before installing. */
export type SkillPreview = {
  owner: string;
  repo: string;
  branch: string;
  /** Map of slug → file path in the repo. */
  skills: Map<string, string>;
  count: number;
  group: string;
};

const SKILLS_SUBPATH = ".tedi/skills";
const SKILL_FILE = "SKILL.md";

const normSlashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
type ParsedFrontmatter = {
  name?: string;
  description?: string;
  argHint?: string;
  version?: string;
  requires?: string[];
};
type SkillFileCacheEntry = { mtime: number; size: number; frontmatter: ParsedFrontmatter };
const skillFileCache = new Map<string, SkillFileCacheEntry>();

let _homeSkillsDir: string | null | undefined;
async function homeSkillsDir(): Promise<string | null> {
  if (_homeSkillsDir !== undefined) return _homeSkillsDir;
  try {
    _homeSkillsDir = `${normSlashes(await homeDir())}/${SKILLS_SUBPATH}`;
  } catch {
    _homeSkillsDir = null;
  }
  return _homeSkillsDir;
}

/** Minimal YAML frontmatter reader for name / description / argument-hint /
 *  version / requires. Handles plain, quoted, block-scalar (`>` / `|`, the folded
 *  `description: >` form), and block-sequence (`requires:` then indented `- item`)
 *  values, and tolerates a leading BOM / blank lines before the `---` fence. */
function parseFrontmatter(md: string): ParsedFrontmatter {
  // Strip a UTF-8 BOM and tolerate leading blank lines before the `---` fence;
  // otherwise a SKILL.md saved with a BOM or a blank first line fails the match,
  // yields an empty description, and the skill silently vanishes (readSkill
  // returns null on no description).
  const src = md.replace(/^﻿/, "");
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out: ParsedFrontmatter = {};
  let i = 0;
  while (i < lines.length) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) {
      i++;
      continue;
    }
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();
    i++;
    // YAML block sequence: `key:` on its own line followed by indented `- item`
    // lines. Without this, `requires:`\n`  - a`\n`  - b` parsed to [] because the
    // inline value was empty and the `- a` lines failed the `key:` regex.
    let seq: string[] | null = null;
    if (val === "") {
      const items: string[] = [];
      while (i < lines.length) {
        const it = /^\s*-\s+(.*)$/.exec(lines[i]);
        if (!it) break;
        const v = it[1].trim().replace(/^["']|["']$/g, "");
        if (v) items.push(v);
        i++;
      }
      if (items.length) seq = items;
    }
    if (/^[|>][+-]?$/.test(val)) {
      // Block scalar: fold the following indented/blank lines until a dedent.
      const block: string[] = [];
      while (i < lines.length && (lines[i].trim() === "" || /^\s/.test(lines[i]))) {
        block.push(lines[i].trim());
        i++;
      }
      val = block.join(" ").replace(/\s+/g, " ").trim();
    } else {
      val = val.replace(/^["']|["']$/g, "");
    }
    if (key === "name" && !out.name) out.name = val;
    else if (key === "description" && !out.description) out.description = val;
    else if ((key === "argument-hint" || key === "arghint") && !out.argHint) out.argHint = val;
    else if (key === "version" && !out.version) out.version = val;
    else if (key === "requires") {
      // Parse: block sequence (seq), or inline `requires: [a, b]` / `requires: x`.
      const list =
        seq ??
        val
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      if (list.length && !out.requires) out.requires = list;
      else if (list.length) out.requires = [...(out.requires ?? []), ...list];
    }
  }
  return out;
}

function skillFileCacheKey(path: string): string {
  return normSlashes(path).toLowerCase();
}

/** Read one skill folder (needs a SKILL.md with a description). */
async function readSkill(
  dir: string,
  fallbackName: string,
  group: string,
  skillFileMeta?: DirEntry,
): Promise<SkillMeta | null> {
  const path = `${dir}/${SKILL_FILE}`;
  try {
    const cacheKey = skillFileCacheKey(path);
    let fm: ParsedFrontmatter | null = null;
    if (skillFileMeta) {
      const hit = skillFileCache.get(cacheKey);
      if (hit && hit.mtime === skillFileMeta.mtime && hit.size === skillFileMeta.size) {
        fm = hit.frontmatter;
      }
    }
    const r = await native.readFile(path);
    if (r.kind !== "text") return null;
    const parsed = fm ?? parseFrontmatter(r.content);
    if (skillFileMeta) {
      skillFileCache.set(cacheKey, {
        mtime: skillFileMeta.mtime,
        size: skillFileMeta.size,
        frontmatter: parsed,
      });
    }
    const description = (parsed.description ?? "").trim();
    if (!description) return null; // the AI needs a description to decide relevance
    return {
      name: (parsed.name || fallbackName).trim(),
      description,
      path,
      dir,
      group,
      argHint: parsed.argHint,
      version: parsed.version ?? null,
      requires: parsed.requires ?? [],
    };
  } catch {
    return null; // missing/unreadable SKILL.md -> not a skill folder
  }
}

/** Scan a skills root two levels deep: a folder with a SKILL.md is a skill
 *  (ungrouped, `group: ""`); a folder of skill subfolders is a group (its name
 *  becomes their `group`). A folder can be both. */
async function scanDir(skillsDir: string): Promise<SkillMeta[]> {
  let entries;
  try {
    entries = await native.readDir(skillsDir);
  } catch {
    return []; // dir absent -> no skills here
  }
  const out: SkillMeta[] = [];
  await Promise.all(
    entries.map(async (e) => {
      if (e.kind !== "dir") return;
      const dir = `${skillsDir}/${e.name}`;
      // Grouped skills: one level down, group = this folder's name.
      let children: DirEntry[] = [];
      try {
        children = await native.readDir(dir);
      } catch {
        // group folder unreadable -> no grouped skills
      }
      const directSkillFile = children.find((c) => c.kind === "file" && c.name === SKILL_FILE);
      const direct = await readSkill(dir, e.name, "", directSkillFile);
      if (direct) out.push(direct);
      await Promise.all(
        children.map(async (c) => {
          if (c.kind !== "dir") return;
          let grandChildren: DirEntry[] = [];
          try {
            grandChildren = await native.readDir(`${dir}/${c.name}`);
          } catch {
            // unreadable child folder -> skip
          }
          const childSkillFile = grandChildren.find(
            (entry) => entry.kind === "file" && entry.name === SKILL_FILE,
          );
          const child = await readSkill(`${dir}/${c.name}`, c.name, e.name, childSkillFile);
          if (child) out.push(child);
        }),
      );
    }),
  );
  return out;
}

/** Attach runtime state (version, SHA, install date, etc.) to skill metadata. */
async function attachSkillState(skills: SkillMeta[]): Promise<SkillMeta[]> {
  const allStates = await getAllSkillStates();
  // Fallback index by (group, leaf): state is keyed by absolute install dir, so a
  // moved home/project path changes the key and would orphan the version/SHA. On
  // a miss, match by relative identity instead. Read-only (the store isn't
  // rewritten here); built lazily so the common all-hit case pays nothing.
  let byGroupLeaf: Map<string, SkillState> | null = null;
  const leafOf = (dir: string) => dir.replace(/\\/g, "/").split("/").pop() ?? "";
  return skills.map((s) => {
    let state: SkillState | null = allStates[s.dir] ?? null;
    if (!state) {
      if (!byGroupLeaf) {
        byGroupLeaf = new Map();
        for (const [dir, meta] of Object.entries(allStates)) {
          byGroupLeaf.set(`${splitSkillDir(dir)?.group ?? ""}\x1f${leafOf(dir)}`, meta);
        }
      }
      state = byGroupLeaf.get(`${s.group}\x1f${leafOf(s.dir)}`) ?? null;
    }
    return { ...s, state };
  });
}

type CacheEntry = { skills: SkillMeta[]; at: number };
const cache = new Map<string, CacheEntry>();

subscribeSkillPathChanges(() => {
  invalidateSkillsCache();
  invalidateSkillDescriptionCache();
});

/** Last loadSkills() result, for synchronous consumers (the `/` slash picker). */
let loadedSkills: SkillMeta[] = [];
export function getLoadedSkills(): SkillMeta[] {
  return loadedSkills;
}

/** Slash-safe token for a skill: its folder name, used as its `/` command.
 *  loadSkills may set `slugOverride` to disambiguate a leaf-slug collision. */
export function skillSlug(s: SkillMeta): string {
  if (s.slugOverride) return s.slugOverride;
  const last = s.dir.split("/").pop() ?? s.name;
  return sanitizeSlug(last);
}

/** Directory of a skill's group (deletable as a unit), or null if ungrouped. */
export function skillGroupDir(s: SkillMeta): string | null {
  if (!s.group) return null;
  const i = s.dir.lastIndexOf("/");
  return i === -1 ? null : s.dir.slice(0, i);
}

/** All skills from the global + (optional) workspace roots. Project skills win
 *  on name clash. Cached 30s per root, mirroring project-memory reads. */
export async function loadSkills(workspaceRoot: string | null): Promise<SkillMeta[]> {
  const key = workspaceRoot ?? "(global)";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30_000) {
    loadedSkills = hit.skills;
    return hit.skills;
  }

  const roots: string[] = [];
  const home = await homeSkillsDir();
  if (home) roots.push(home);
  if (workspaceRoot) roots.push(`${normSlashes(workspaceRoot)}/${SKILLS_SUBPATH}`);

  // Dedup by skill IDENTITY = group + leaf slug. A later root (workspace) still
  // overrides a same-identity skill from an earlier root (project beats global),
  // but two DISTINCT identities that merely share a leaf (e.g. `repoA/review` and
  // `repoB/review`) must both survive — keying by leaf alone silently dropped one
  // with a nondeterministic winner.
  const byId = new Map<string, SkillMeta>();
  for (const root of roots) {
    for (const s of await scanDir(root)) byId.set(`${s.group}\x1f${skillSlug(s)}`, s);
  }
  // Assign a disambiguating invocation slug only when two survivors share a bare
  // leaf. Unique leaves keep their bare slug (the common case, no UX change);
  // collisions get a stable `-2`/`-3` suffix in sorted-dir order so assignment is
  // deterministic across runs.
  // Note: numeric suffix, not group-qualified `group:leaf`; bump to qualified
  // if users want readable disambiguated commands.
  const survivors = Array.from(byId.values()).sort((a, b) => a.dir.localeCompare(b.dir));
  const taken = new Set<string>();
  for (const s of survivors) {
    const base = skillSlug(s);
    if (!taken.has(base)) {
      taken.add(base);
      continue;
    }
    let n = 2;
    let alt = `${base}-${n}`;
    while (taken.has(alt)) alt = `${base}-${++n}`;
    s.slugOverride = alt;
    taken.add(alt);
  }
  const skills = await attachSkillState(survivors);
  cache.set(key, { skills, at: Date.now() });
  loadedSkills = skills;
  return skills;
}

/** Skills under the global `~/.tedi/skills`. */
export async function loadInstalledSkills(): Promise<SkillMeta[]> {
  const home = await homeSkillsDir();
  const skills = home ? await scanDir(home) : [];
  return attachSkillState(skills);
}

/** Skills under a workspace's `.tedi/skills` (project-local). */
export async function loadProjectSkills(workspaceRoot: string | null): Promise<SkillMeta[]> {
  if (!workspaceRoot) return [];
  const skills = await scanDir(`${normSlashes(workspaceRoot)}/${SKILLS_SUBPATH}`);
  return attachSkillState(skills);
}

function invalidateSkillsCache(): void {
  cache.clear();
  skillFileCache.clear();
  _updateCheckCache = null;
}

/** System-prompt block. Stable across turns (only changes when skills change),
 *  so it stays inside the cacheable prefix. Null when there are no skills. */
export function formatSkillsPrompt(skills: SkillMeta[]): string | null {
  if (skills.length === 0) return null;
  // Just a proactive nudge; the `skill` tool carries the actual names + blurbs,
  // so there's no need to duplicate the list here.
  return `## SKILLS\nYou have installed skills (expert playbooks). When a request matches one, use the \`skill\` tool (it lists them) to load and follow it.`;
}

function parseGithubRef(ref: string): { owner: string; repo: string } {
  const s = ref
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("Use `owner/repo` or a GitHub URL.");
  return { owner: parts[0], repo: parts[1] };
}

/** A repo's text files fetched off codeload (no GitHub REST API, so no 60/hr
 *  rate limit and no token needed). `files` keys are repo-relative paths. */
type RepoTextFiles = { branch: string; sha: string; files: Array<{ path: string; content: string }> };

function friendlyGhError(e: unknown, owner: string, repo: string): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (/HTTP 404/.test(msg)) {
    return new Error(`"${owner}/${repo}" not found, or it's private (skills install needs a public repo).`);
  }
  if (/download too large/.test(msg)) {
    return new Error(`"${owner}/${repo}" is too large to download as a skills archive.`);
  }
  return e instanceof Error ? e : new Error(msg);
}

// Single-slot cache so Preview → Install doesn't download the same repo twice.
let _repoCache: { key: string; at: number; data: RepoTextFiles } | null = null;

/** Fetch a repo's text files via the backend's codeload path. No API, no rate
 *  limit, no token. Cached 60s by owner/repo so the common preview→install
 *  flow downloads once. */
async function fetchRepoFiles(owner: string, repo: string): Promise<RepoTextFiles> {
  const key = `${owner}/${repo}`.toLowerCase();
  if (_repoCache && _repoCache.key === key && Date.now() - _repoCache.at < 60_000) {
    return _repoCache.data;
  }
  try {
    const data = await invoke<RepoTextFiles>("github_repo_text_files", { owner, repo });
    _repoCache = { key, at: Date.now(), data };
    return data;
  } catch (e) {
    throw friendlyGhError(e, owner, repo);
  }
}

/** Default branch + latest commit SHA, off github.com's git smart-HTTP (not the
 *  REST API). Cheap and rate-limit-free — used by the update check so it never
 *  downloads the repo just to see if a newer commit exists. */
async function fetchHeadSha(owner: string, repo: string): Promise<{ branch: string; sha: string }> {
  try {
    return await invoke<{ branch: string; sha: string }>("github_head_sha", { owner, repo });
  } catch (e) {
    throw friendlyGhError(e, owner, repo);
  }
}

/** Score a SKILL.md path to prefer canonical `skills/<name>/SKILL.md`. */
function scoreSkillPath(p: string): number {
  const lp = p.toLowerCase();
  if (/^skills\/[^/]+\/skill\.md$/.test(lp)) return 2;
  if (/(^|\/)skills\/[^/]+\/skill\.md$/.test(lp)) return 1;
  return 0;
}

/** Sanitize a (possibly untrusted) folder name into a slash/path-safe slug. */
function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Resolve the best SKILL.md path per skill slug from a GitHub tree. Keys are the
 *  SANITIZED invocation slug (so the install preview shows the real `/command`),
 *  and two distinct parent-leaves that sanitize to the same slug are disambiguated
 *  with a `-2`/`-3` suffix instead of silently dropping one. */
function resolveSkillSlugs(skillFiles: string[], repo: string): Map<string, string> {
  // First pick the best SKILL.md per raw parent-leaf (canonical path wins on score).
  const byLeaf = new Map<string, string>();
  for (const p of skillFiles) {
    const parts = p.split("/");
    const leaf = parts.length >= 2 ? parts[parts.length - 2] : repo;
    const existing = byLeaf.get(leaf);
    if (!existing || scoreSkillPath(p) > scoreSkillPath(existing)) byLeaf.set(leaf, p);
  }
  // Then map to sanitized slugs, disambiguating sanitize-collisions.
  const bySlug = new Map<string, string>();
  for (const [leaf, p] of byLeaf) {
    let slug = sanitizeSlug(leaf) || sanitizeSlug(repo) || "skill";
    if (bySlug.has(slug)) {
      let n = 2;
      while (bySlug.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    bySlug.set(slug, p);
  }
  return bySlug;
}

/**
 * Preview skills in a GitHub repo without installing. Returns count, slugs,
 * branch info so the UI can show "X skills found" before the user confirms.
 */
export async function previewSkillsFromGithub(ref: string): Promise<SkillPreview> {
  const { owner, repo } = parseGithubRef(ref);

  const { branch, files } = await fetchRepoFiles(owner, repo);
  const skillFiles = files.map((f) => f.path).filter((p) => /(^|\/)SKILL\.md$/i.test(p));

  if (skillFiles.length === 0) {
    const looksMcp = /mcp/i.test(repo) || files.some((f) => /(^|\/)package\.json$/i.test(f.path));
    throw new Error(
      looksMcp
        ? `"${owner}/${repo}" has no SKILL.md - it looks like an MCP server or npm package, not a TEDI skill.`
        : `No SKILL.md found in "${owner}/${repo}".`,
    );
  }

  const skills = resolveSkillSlugs(skillFiles, repo);
  const group = sanitizeSlug(repo) || "skills";

  return { owner, repo, branch, skills, count: skills.size, group };
}

// Bounds for writing a skill's bundled sibling files.
const COFETCH_MAX_FILES = 50;
const COFETCH_MAX_BYTES = 512 * 1024;

/**
 * Write a skill's bundled sibling files (scripts, reference docs) from the
 * already-downloaded repo file map so a multi-file skill isn't installed
 * half-broken (the agent's read_file on a referenced script would otherwise
 * fail at runtime). The backend already dropped binaries (text-only archive),
 * so this is a pure in-memory walk — no network. Bounded so a misshaped repo
 * can't write an unbounded tree; untrusted paths that escape the dir are rejected.
 */
async function writeSkillSiblings(
  skillMdPath: string,
  destDir: string,
  fileMap: Map<string, string>,
): Promise<void> {
  const slash = skillMdPath.lastIndexOf("/");
  if (slash === -1) return; // root-level skill: no prefix → never pull whole repo
  const prefix = skillMdPath.slice(0, slash + 1); // trailing slash included
  let count = 0;
  for (const [p, body] of fileMap) {
    if (count >= COFETCH_MAX_FILES) break;
    if (p === skillMdPath || !p.startsWith(prefix)) continue;
    const rel = p.slice(prefix.length);
    if (!rel || rel.includes("..") || rel.startsWith("/")) continue; // path-safety
    if (body.length > COFETCH_MAX_BYTES) continue;
    const relSlash = rel.lastIndexOf("/");
    try {
      if (relSlash !== -1) await native.createDir(`${destDir}/${rel.slice(0, relSlash)}`);
      await native.writeFile(`${destDir}/${rel}`, body);
      count++;
    } catch {
      /* skip an unwritable sibling rather than aborting the install */
    }
  }
}

/**
 * Install every `SKILL.md` found in a GitHub repo into a skills root. Targets
 * the workspace `.tedi/skills` when `workspaceRoot` is given, else the global
 * `~/.tedi/skills`. The whole repo is downloaded once via codeload (no GitHub
 * API, no rate limit, no token); SKILL.md files and their bundled text siblings
 * are written from that in-memory archive (binaries were dropped backend-side).
 *
 * Also saves metadata (SHA, version, requires, install date) to skillState store.
 */
export async function installSkillsFromGithub(
  ref: string,
  workspaceRoot?: string | null,
): Promise<{
  installed: string[];
  failed: string[];
  group: string;
  branch: string;
  sha: string | null;
}> {
  const { owner, repo } = parseGithubRef(ref);
  const base = workspaceRoot
    ? `${normSlashes(workspaceRoot)}/${SKILLS_SUBPATH}`
    : await homeSkillsDir();
  if (!base) throw new Error("Could not resolve a skills directory.");

  const { branch, sha, files } = await fetchRepoFiles(owner, repo);
  const fileMap = new Map(files.map((f) => [f.path, f.content]));
  const skillFiles = [...fileMap.keys()].filter((p) => /(^|\/)SKILL\.md$/i.test(p));
  if (skillFiles.length === 0) {
    const looksMcp = /mcp/i.test(repo) || fileMap.has("package.json");
    throw new Error(
      looksMcp
        ? `"${owner}/${repo}" has no SKILL.md - it looks like an MCP server or npm package, not a TEDI skill. TEDI doesn't run MCP servers; for browser automation it already has built-in browser tools (open_browser, browser_click, …).`
        : `No SKILL.md found in "${owner}/${repo}". A skill is a folder with a SKILL.md (name + description frontmatter).`,
    );
  }

  const bySlug = resolveSkillSlugs(skillFiles, repo);

  // Group every skill from this repo under one folder.
  const group = sanitizeSlug(repo) || "skills";
  const groupDir = `${base}/${group}`;

  const installed: string[] = [];
  const failed: string[] = [];
  const stateEntries: [string, SkillState][] = [];

  for (const [rawSlug, filePath] of bySlug) {
    // resolveSkillSlugs already sanitized the slug; keep idempotent guard.
    const slug = sanitizeSlug(rawSlug);
    if (!slug) continue;
    const content = fileMap.get(filePath);
    if (content === undefined) {
      failed.push(slug);
      continue;
    }
    const destDir = `${groupDir}/${slug}`;
    try {
      await native.createDir(destDir); // recursive; throws if it already exists
    } catch {
      /* already there - we overwrite the SKILL.md below */
    }
    try {
      await native.writeFile(`${destDir}/${SKILL_FILE}`, content);
    } catch {
      failed.push(slug); // skip on write failure so state stays in sync with disk
      continue;
    }
    installed.push(slug);

    // Write bundled siblings from the same archive so a multi-file skill isn't
    // half-installed.
    await writeSkillSiblings(filePath, destDir, fileMap);

    // Parse frontmatter for version and requires.
    const fm = parseFrontmatter(content);
    stateEntries.push([
      destDir,
      {
        sha,
        source: `${owner}/${repo}`,
        installedAt: new Date().toISOString(),
        version: fm.version ?? null,
        requires: fm.requires ?? [],
        branch,
      },
    ]);
  }

  if (installed.length === 0) throw new Error("Found SKILL.md files but none could be downloaded.");

  // Save all metadata at once.
  await setSkillStates(stateEntries);
  invalidateSkillsCache();
  invalidateSkillDescriptionCache();
  return { installed, failed, group, branch, sha };
}

/** Split a skill dir `<base>/.tedi/skills/<group>/<slug>` into {base, group}.
 *  Anchors on the `.tedi/skills` marker (not a bare "skills" component) so an
 *  ancestor dir literally named "skills" isn't mistaken for the skills root. */
function splitSkillDir(dir: string): { base: string; group: string } | null {
  const norm = dir.replace(/\\/g, "/");
  const marker = `/${SKILLS_SUBPATH}/`;
  const idx = norm.indexOf(marker);
  if (idx === -1) return null;
  const base = norm.slice(0, idx);
  const group = norm.slice(idx + marker.length).split("/")[0] ?? "";
  return group ? { base, group } : null;
}

/**
 * Check if an installed skill group has updates available.
 * Returns null when the group is not update-tracked or already current; THROWS
 * on a real fetch failure (network) so callers don't mistake an unreachable
 * check for "up to date". Resolves the repo's current HEAD off git smart-HTTP
 * (no API, no rate limit) and compares its SHA — a renamed default branch is
 * handled automatically since HEAD always points at whatever is current.
 */
export async function checkSkillUpdate(group: string): Promise<{
  hasUpdate: boolean;
  currentSha: string | null;
  latestSha: string | null;
  latestCommitMsg: string | null;
} | null> {
  const state = await getAllSkillStates();
  // Find any skill in this group to get the source repo.
  const skillInGroup = Object.entries(state).find(([dir]) => splitSkillDir(dir)?.group === group);
  if (!skillInGroup) return null;

  const [, meta] = skillInGroup;
  if (!meta.source || !meta.sha) return null;

  const [owner, repo] = meta.source.split("/");
  const { sha: latestSha } = await fetchHeadSha(owner, repo);
  return {
    hasUpdate: latestSha !== meta.sha,
    currentSha: meta.sha,
    latestSha,
    // No commit message without the REST API; the badge only needs hasUpdate.
    latestCommitMsg: null,
  };
}

type SkillUpdateInfo = {
  hasUpdate: boolean;
  currentSha: string | null;
  latestSha: string | null;
  latestCommitMsg: string | null;
};
/** Result of a bulk update check: groups that have updates, plus how many group
 *  checks could not be completed (offline / rate-limited) so the UI can say
 *  "couldn't check" instead of silently implying everything is current. */
export type SkillUpdateCheck = { updates: Map<string, SkillUpdateInfo>; failed: number };

// TTL-cache the update check (one git info/refs call per group — no API, no rate
// limit) so Settings re-render / refresh churn doesn't re-hit the network each time.
// Cleared by invalidateSkillsCache on install/update/remove.
let _updateCheckCache: { at: number; result: SkillUpdateCheck } | null = null;
const UPDATE_CHECK_TTL_MS = 5 * 60_000;

/**
 * Check all installed skill groups for updates. Returns the groups that have an
 * update plus a count of checks that failed (so a rate-limit/offline state is
 * not reported as "all up to date").
 */
export async function checkAllSkillUpdates(): Promise<SkillUpdateCheck> {
  if (_updateCheckCache && Date.now() - _updateCheckCache.at < UPDATE_CHECK_TTL_MS) {
    return _updateCheckCache.result;
  }
  const state = await getAllSkillStates();
  const groups = new Set<string>();
  for (const [dir, meta] of Object.entries(state)) {
    if (meta.source) {
      const g = splitSkillDir(dir)?.group;
      if (g) groups.add(g);
    }
  }

  const updates = new Map<string, SkillUpdateInfo>();
  let failed = 0;
  for (const group of groups) {
    try {
      const info = await checkSkillUpdate(group);
      if (info?.hasUpdate) updates.set(group, info);
    } catch {
      failed++; // couldn't reach GitHub for this group — not the same as up-to-date
    }
  }
  const result: SkillUpdateCheck = { updates, failed };
  _updateCheckCache = { at: Date.now(), result };
  return result;
}

/**
 * Update a skill group by re-downloading from the source repo (via codeload, no
 * API/rate limit). Updates EVERY root that holds the group (a repo installed
 * both globally and into a project updates both, not just the first match).
 * A renamed default branch is handled automatically (HEAD is always current),
 * writes bundled text siblings, and reports per-skill failures.
 */
export async function updateSkillGroup(group: string): Promise<{
  updated: string[];
  failed: string[];
  sha: string | null;
} | null> {
  const state = await getAllSkillStates();
  // Every distinct base (root) that holds this group, with a representative meta.
  const bases = new Map<string, SkillState>();
  for (const [dir, meta] of Object.entries(state)) {
    const sd = splitSkillDir(dir);
    if (sd?.group === group && meta.source && !bases.has(sd.base)) {
      bases.set(sd.base, meta);
    }
  }
  if (bases.size === 0) return null;

  const updated: string[] = [];
  const failed: string[] = [];
  let lastSha: string | null = null;
  const stateEntries: [string, SkillState][] = [];

  for (const [base, meta] of bases) {
    const [owner, repo] = meta.source.split("/");

    let branch: string;
    let sha: string | null;
    let fileMap: Map<string, string>;
    try {
      const data = await fetchRepoFiles(owner, repo);
      branch = data.branch;
      sha = data.sha;
      fileMap = new Map(data.files.map((f) => [f.path, f.content]));
    } catch {
      continue; // couldn't fetch this root — leave it; other roots may still update
    }

    const skillFiles = [...fileMap.keys()].filter((p) => /(^|\/)SKILL\.md$/i.test(p));
    if (skillFiles.length === 0) continue;

    const bySlug = resolveSkillSlugs(skillFiles, repo);
    const groupDir = `${base}/${SKILLS_SUBPATH}/${group}`;
    lastSha = sha ?? lastSha;

    for (const [rawSlug, filePath] of bySlug) {
      const slug = sanitizeSlug(rawSlug);
      if (!slug) continue;
      const content = fileMap.get(filePath);
      if (content === undefined) {
        failed.push(slug);
        continue;
      }
      const destDir = `${groupDir}/${slug}`;
      // A slug added upstream since install has no directory yet, so create it,
      // and guard the write: a single failure must not abort the whole loop and
      // leave the written files out of sync with the state map recorded below.
      try {
        await native.createDir(destDir); // recursive; throws if it already exists
      } catch {
        /* already there - we overwrite the SKILL.md below */
      }
      try {
        await native.writeFile(`${destDir}/${SKILL_FILE}`, content);
      } catch {
        failed.push(slug); // skip on write failure so state stays in sync with disk
        continue;
      }
      updated.push(slug);

      await writeSkillSiblings(filePath, destDir, fileMap);

      const fm = parseFrontmatter(content);
      stateEntries.push([
        destDir,
        {
          sha,
          source: meta.source,
          installedAt: new Date().toISOString(),
          // Per-skill defaults (not the first sibling's old state).
          version: fm.version ?? null,
          requires: fm.requires ?? [],
          branch,
        },
      ]);
    }
  }

  if (updated.length === 0) return null;

  await setSkillStates(stateEntries);
  invalidateSkillsCache();
  invalidateSkillDescriptionCache();
  return { updated, failed, sha: lastSha };
}

/**
 * Update all installed skill groups that have available updates.
 */
export async function updateAllSkillGroups(): Promise<{
  updated: string[];
  groups: string[];
} | null> {
  const { updates } = await checkAllSkillUpdates();
  if (updates.size === 0) return null;

  const allUpdated: string[] = [];
  const allGroups: string[] = [];

  for (const group of updates.keys()) {
    const result = await updateSkillGroup(group);
    if (result) {
      allUpdated.push(...result.updated);
      allGroups.push(group);
    }
  }

  if (allUpdated.length === 0) return null;
  return { updated: allUpdated, groups: allGroups };
}

/** Remove an installed skill folder (global root). */
export async function removeSkill(dir: string): Promise<void> {
  await native.deletePath(dir);
  await removeSkillState(dir);
  invalidateSkillsCache();
  invalidateSkillDescriptionCache();
}

/** Remove an entire skill group. */
export async function removeSkillGroup(groupDir: string): Promise<void> {
  await native.deletePath(groupDir);
  await removeGroupStates(groupDir);
  invalidateSkillsCache();
  invalidateSkillDescriptionCache();
}

// External cache invalidation for the description memoizers in skill.ts
// and subagent.ts — called whenever skills/subagents change at runtime.
const _descriptionCacheInvalidators = new Set<() => void>();
export function registerDescriptionCacheInvalidator(fn: () => void): void {
  _descriptionCacheInvalidators.add(fn);
}
export function invalidateSkillDescriptionCache(): void {
  for (const fn of _descriptionCacheInvalidators) fn();
}
