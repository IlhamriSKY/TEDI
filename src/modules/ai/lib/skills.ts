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

/** Minimal YAML frontmatter reader for `name` / `description`. Handles plain,
 *  quoted, AND block-scalar (`>` / `|`) values - the folded `description: >`
 *  form is why a description was rendering as just ">". */
function parseFrontmatter(md: string): ParsedFrontmatter {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
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
      // Parse: requires: [skill-a, skill-b] or requires: skill-a
      const list = val
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
  return skills.map((s) => {
    const state = allStates[s.dir] ?? null;
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

/** Slash-safe token for a skill: its folder name, used as its `/` command. */
export function skillSlug(s: SkillMeta): string {
  const last = s.dir.split("/").pop() ?? s.name;
  return last
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

  // Key by slug (the invocation identity = folder leaf), not the display name:
  // two skills sharing a frontmatter `name` but distinct slugs must both survive
  // (every consumer resolves by skillSlug). Later root (workspace) still wins.
  const bySlug = new Map<string, SkillMeta>();
  for (const root of roots) {
    for (const s of await scanDir(root)) bySlug.set(skillSlug(s), s);
  }
  const skills = await attachSkillState(Array.from(bySlug.values()));
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

async function ghJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) {
    throw new Error(res.status === 404 ? "Repo not found." : `GitHub error ${res.status}.`);
  }
  return res.json() as Promise<T>;
}

/** Score a SKILL.md path to prefer canonical `skills/<name>/SKILL.md`. */
function scoreSkillPath(p: string): number {
  const lp = p.toLowerCase();
  if (/^skills\/[^/]+\/skill\.md$/.test(lp)) return 2;
  if (/(^|\/)skills\/[^/]+\/skill\.md$/.test(lp)) return 1;
  return 0;
}

/** Resolve the best SKILL.md path per skill slug from a GitHub tree. */
function resolveSkillSlugs(skillFiles: string[], repo: string): Map<string, string> {
  const bySlug = new Map<string, string>();
  for (const p of skillFiles) {
    const parts = p.split("/");
    const slug = parts.length >= 2 ? parts[parts.length - 2] : repo;
    const existing = bySlug.get(slug);
    if (!existing || scoreSkillPath(p) > scoreSkillPath(existing)) bySlug.set(slug, p);
  }
  return bySlug;
}

/**
 * Preview skills in a GitHub repo without installing. Returns count, slugs,
 * branch info so the UI can show "X skills found" before the user confirms.
 */
export async function previewSkillsFromGithub(ref: string): Promise<SkillPreview> {
  const { owner, repo } = parseGithubRef(ref);

  const info = await ghJson<{ default_branch: string }>(
    `https://api.github.com/repos/${owner}/${repo}`,
  );
  const branch = info.default_branch || "main";
  const tree = await ghJson<{ tree: Array<{ path: string; type: string }> }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
  );
  const skillFiles = tree.tree
    .filter((n) => n.type === "blob" && /(^|\/)SKILL\.md$/i.test(n.path))
    .map((n) => n.path);

  if (skillFiles.length === 0) {
    const looksMcp =
      /mcp/i.test(repo) || tree.tree.some((n) => /(^|\/)package\.json$/i.test(n.path));
    throw new Error(
      looksMcp
        ? `"${owner}/${repo}" has no SKILL.md - it looks like an MCP server or npm package, not a TEDI skill.`
        : `No SKILL.md found in "${owner}/${repo}".`,
    );
  }

  const skills = resolveSkillSlugs(skillFiles, repo);
  const group =
    repo
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skills";

  return { owner, repo, branch, skills, count: skills.size, group };
}

/**
 * Install every `SKILL.md` found in a GitHub repo into a skills root. Targets
 * the workspace `.tedi/skills` when `workspaceRoot` is given, else the global
 * `~/.tedi/skills`. Only the SKILL.md is fetched (instructions); bundled scripts
 * are not - add that if a skill needs them.
 *
 * Also saves metadata (SHA, version, requires, install date) to skillState store.
 */
export async function installSkillsFromGithub(
  ref: string,
  workspaceRoot?: string | null,
): Promise<{ installed: string[]; group: string; branch: string; sha: string | null }> {
  const { owner, repo } = parseGithubRef(ref);
  const base = workspaceRoot
    ? `${normSlashes(workspaceRoot)}/${SKILLS_SUBPATH}`
    : await homeSkillsDir();
  if (!base) throw new Error("Could not resolve a skills directory.");

  const info = await ghJson<{ default_branch: string }>(
    `https://api.github.com/repos/${owner}/${repo}`,
  );
  const branch = info.default_branch || "main";
  const tree = await ghJson<{ tree: Array<{ path: string; type: string }> }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
  );
  const skillFiles = tree.tree
    .filter((n) => n.type === "blob" && /(^|\/)SKILL\.md$/i.test(n.path))
    .map((n) => n.path);
  if (skillFiles.length === 0) {
    const looksMcp =
      /mcp/i.test(repo) || tree.tree.some((n) => /(^|\/)package\.json$/i.test(n.path));
    throw new Error(
      looksMcp
        ? `"${owner}/${repo}" has no SKILL.md - it looks like an MCP server or npm package, not a TEDI skill. TEDI doesn't run MCP servers; for browser automation it already has built-in browser tools (open_browser, browser_click, …).`
        : `No SKILL.md found in "${owner}/${repo}". A skill is a folder with a SKILL.md (name + description frontmatter).`,
    );
  }

  const bySlug = resolveSkillSlugs(skillFiles, repo);

  // Group every skill from this repo under one folder.
  const group =
    repo
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skills";
  const groupDir = `${base}/${group}`;

  // Get the latest commit SHA for the branch (used for version tracking).
  const commits = await ghJson<Array<{ sha: string }>>(
    `https://api.github.com/repos/${owner}/${repo}/commits?sha=${branch}&per_page=1`,
  );
  const sha = commits[0]?.sha ?? null;

  const installed: string[] = [];
  const stateEntries: [string, SkillState][] = [];

  for (const [rawSlug, filePath] of bySlug) {
    // Sanitize the slug from the (untrusted) repo tree before it becomes a path.
    const slug = rawSlug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) continue;
    const raw = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`,
    );
    if (!raw.ok) continue;
    const content = await raw.text();
    const destDir = `${groupDir}/${slug}`;
    try {
      await native.createDir(destDir); // recursive; throws if it already exists
    } catch {
      /* already there - we overwrite the SKILL.md below */
    }
    try {
      await native.writeFile(`${destDir}/${SKILL_FILE}`, content);
    } catch {
      continue; // skip on write failure so state stays in sync with disk
    }
    installed.push(slug);

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
  return { installed, group, branch, sha };
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
 * Returns null if no update, or the new SHA + commit message if there is one.
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
  if (!meta.source || !meta.branch || !meta.sha) return null;

  const [owner, repo] = meta.source.split("/");
  try {
    const commits = await ghJson<Array<{ sha: string; commit: { message: string } }>>(
      `https://api.github.com/repos/${owner}/${repo}/commits?sha=${meta.branch}&per_page=1`,
    );
    if (commits.length === 0) return null;
    const latestSha = commits[0].sha;
    return {
      hasUpdate: latestSha !== meta.sha,
      currentSha: meta.sha,
      latestSha,
      latestCommitMsg: commits[0].commit.message.split("\n")[0] ?? null,
    };
  } catch {
    return null;
  }
}

type SkillUpdateInfo = {
  hasUpdate: boolean;
  currentSha: string | null;
  latestSha: string | null;
  latestCommitMsg: string | null;
};
// TTL-cache the update check (one unauthenticated GitHub /commits call per group)
// so Settings re-render / refresh churn can't spam the 60 req/hr rate limit.
// Cleared by invalidateSkillsCache on install/update/remove.
let _updateCheckCache: { at: number; result: Map<string, SkillUpdateInfo> } | null = null;
const UPDATE_CHECK_TTL_MS = 5 * 60_000;

/**
 * Check all installed skill groups for updates. Returns a map of
 * group → update info for groups that have updates.
 */
export async function checkAllSkillUpdates(): Promise<
  Map<
    string,
    {
      hasUpdate: boolean;
      currentSha: string | null;
      latestSha: string | null;
      latestCommitMsg: string | null;
    }
  >
> {
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

  const results = new Map<
    string,
    {
      hasUpdate: boolean;
      currentSha: string | null;
      latestSha: string | null;
      latestCommitMsg: string | null;
    }
  >();
  for (const group of groups) {
    const info = await checkSkillUpdate(group);
    if (info?.hasUpdate) results.set(group, info);
  }
  _updateCheckCache = { at: Date.now(), result: results };
  return results;
}

/**
 * Update a skill group by re-downloading from the source repo.
 */
export async function updateSkillGroup(group: string): Promise<{
  updated: string[];
  sha: string | null;
} | null> {
  const state = await getAllSkillStates();
  const skillInGroup = Object.entries(state).find(([dir]) => splitSkillDir(dir)?.group === group);
  if (!skillInGroup) return null;

  const [firstDir, meta] = skillInGroup;
  if (!meta.source || !meta.branch) return null;

  const [owner, repo] = meta.source.split("/");

  // Determine base dir from the first skill's path (anchored on `.tedi/skills`).
  const split = splitSkillDir(firstDir);
  if (!split) return null;
  const base = split.base;

  const tree = await ghJson<{ tree: Array<{ path: string; type: string }> }>(
    `https://api.github.com/repos/${owner}/${repo}/git/trees/${meta.branch}?recursive=1`,
  );
  const skillFiles = tree.tree
    .filter((n) => n.type === "blob" && /(^|\/)SKILL\.md$/i.test(n.path))
    .map((n) => n.path);

  if (skillFiles.length === 0) return null;

  const bySlug = resolveSkillSlugs(skillFiles, repo);
  const groupDir = `${base}/${SKILLS_SUBPATH}/${group}`;

  const commits = await ghJson<Array<{ sha: string }>>(
    `https://api.github.com/repos/${owner}/${repo}/commits?sha=${meta.branch}&per_page=1`,
  );
  const sha = commits[0]?.sha ?? null;

  const updated: string[] = [];
  const stateEntries: [string, SkillState][] = [];

  for (const [rawSlug, filePath] of bySlug) {
    // Sanitize the slug from the (untrusted) repo tree before it becomes a path.
    const slug = rawSlug
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) continue;
    const raw = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repo}/${meta.branch}/${filePath}`,
    );
    if (!raw.ok) continue;
    const content = await raw.text();
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
      continue; // skip on write failure so state stays in sync with disk
    }
    updated.push(slug);

    const fm = parseFrontmatter(content);
    stateEntries.push([
      destDir,
      {
        sha,
        source: meta.source,
        installedAt: new Date().toISOString(),
        version: fm.version ?? meta.version,
        requires: fm.requires ?? meta.requires,
        branch: meta.branch,
      },
    ]);
  }

  if (updated.length === 0) return null;

  await setSkillStates(stateEntries);
  invalidateSkillsCache();
  invalidateSkillDescriptionCache();
  return { updated, sha };
}

/**
 * Update all installed skill groups that have available updates.
 */
export async function updateAllSkillGroups(): Promise<{
  updated: string[];
  groups: string[];
} | null> {
  const updates = await checkAllSkillUpdates();
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
