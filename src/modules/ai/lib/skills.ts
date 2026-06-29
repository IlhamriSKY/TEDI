import { homeDir } from "@tauri-apps/api/path";
import { native, type DirEntry } from "./native";

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
};

const SKILLS_SUBPATH = ".tedi/skills";
const SKILL_FILE = "SKILL.md";

const normSlashes = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

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
function parseFrontmatter(md: string): { name?: string; description?: string; argHint?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out: { name?: string; description?: string; argHint?: string } = {};
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
  }
  return out;
}

/** Read one skill folder (needs a SKILL.md with a description). */
async function readSkill(
  dir: string,
  fallbackName: string,
  group: string,
): Promise<SkillMeta | null> {
  const path = `${dir}/${SKILL_FILE}`;
  try {
    const r = await native.readFile(path);
    if (r.kind !== "text") return null;
    const fm = parseFrontmatter(r.content);
    const description = (fm.description ?? "").trim();
    if (!description) return null; // the AI needs a description to decide relevance
    return { name: (fm.name || fallbackName).trim(), description, path, dir, group, argHint: fm.argHint };
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
  for (const e of entries) {
    if (e.kind !== "dir") continue;
    const dir = `${skillsDir}/${e.name}`;
    const direct = await readSkill(dir, e.name, "");
    if (direct) out.push(direct);
    // Grouped skills: one level down, group = this folder's name.
    let children: DirEntry[] = [];
    try {
      children = await native.readDir(dir);
    } catch {
      // group folder unreadable -> no grouped skills
    }
    for (const c of children) {
      if (c.kind !== "dir") continue;
      const child = await readSkill(`${dir}/${c.name}`, c.name, e.name);
      if (child) out.push(child);
    }
  }
  return out;
}

type CacheEntry = { skills: SkillMeta[]; at: number };
const cache = new Map<string, CacheEntry>();

/** Last loadSkills() result, for synchronous consumers (the `/` slash picker). */
let loadedSkills: SkillMeta[] = [];
export function getLoadedSkills(): SkillMeta[] {
  return loadedSkills;
}

/** Slash-safe token for a skill: its folder name, used as its `/` command. */
export function skillSlug(s: SkillMeta): string {
  const last = s.dir.split("/").pop() ?? s.name;
  return last.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
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

  const byName = new Map<string, SkillMeta>();
  for (const root of roots) {
    for (const s of await scanDir(root)) byName.set(s.name, s); // later root (workspace) overrides
  }
  const skills = [...byName.values()];
  cache.set(key, { skills, at: Date.now() });
  loadedSkills = skills;
  return skills;
}

/** Skills under the global `~/.tedi/skills`. */
export async function loadInstalledSkills(): Promise<SkillMeta[]> {
  const home = await homeSkillsDir();
  return home ? scanDir(home) : [];
}

/** Skills under a workspace's `.tedi/skills` (project-local). */
export async function loadProjectSkills(workspaceRoot: string | null): Promise<SkillMeta[]> {
  if (!workspaceRoot) return [];
  return scanDir(`${normSlashes(workspaceRoot)}/${SKILLS_SUBPATH}`);
}

function invalidateSkillsCache(): void {
  cache.clear();
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

/**
 * Install every `SKILL.md` found in a GitHub repo into a skills root. Targets
 * the workspace `.tedi/skills` when `workspaceRoot` is given, else the global
 * `~/.tedi/skills`. Only the SKILL.md is fetched (instructions); bundled scripts
 * are not - add that if a skill needs them.
 */
export async function installSkillsFromGithub(
  ref: string,
  workspaceRoot?: string | null,
): Promise<{ installed: string[]; group: string }> {
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
    // No SKILL.md -> not a TEDI skill. MCP servers / npm packages are a common
    // mix-up; flag them so the user isn't left guessing.
    const looksMcp = /mcp/i.test(repo) || tree.tree.some((n) => /(^|\/)package\.json$/i.test(n.path));
    throw new Error(
      looksMcp
        ? `"${owner}/${repo}" has no SKILL.md - it looks like an MCP server or npm package, not a TEDI skill. TEDI doesn't run MCP servers; for browser automation it already has built-in browser tools (open_browser, browser_click, …).`
        : `No SKILL.md found in "${owner}/${repo}". A skill is a folder with a SKILL.md (name + description frontmatter).`,
    );
  }

  // One install per skill folder. Repos often ship the same skill in several
  // formats (canonical `skills/<name>/SKILL.md` plus pi/gemini/opencode variants
  // that strip the frontmatter). Prefer the `skills/` copy so we don't install a
  // stripped one (missing `argument-hint`, short description). Slug = the folder
  // holding SKILL.md, or the repo name at root.
  const score = (p: string) => {
    const lp = p.toLowerCase();
    if (/^skills\/[^/]+\/skill\.md$/.test(lp)) return 2; // top-level skills/<name> (canonical)
    if (/(^|\/)skills\/[^/]+\/skill\.md$/.test(lp)) return 1; // nested (.openclaw/, pi-extension/, …)
    return 0;
  };
  const bySlug = new Map<string, string>();
  for (const p of skillFiles) {
    const parts = p.split("/");
    const slug = parts.length >= 2 ? parts[parts.length - 2] : repo;
    const existing = bySlug.get(slug);
    if (!existing || score(p) > score(existing)) bySlug.set(slug, p);
  }

  // Group every skill from this repo under one folder so they install, list,
  // and delete together: ~/.tedi/skills/<repo>/<skill>/SKILL.md.
  const group = repo.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "skills";
  const groupDir = `${base}/${group}`;

  const installed: string[] = [];
  for (const [slug, filePath] of bySlug) {
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
    await native.writeFile(`${destDir}/${SKILL_FILE}`, content);
    installed.push(slug);
  }
  if (installed.length === 0) throw new Error("Found SKILL.md files but none could be downloaded.");
  invalidateSkillsCache();
  return { installed, group };
}

/** Remove an installed skill folder (global root). */
export async function removeSkill(dir: string): Promise<void> {
  await native.deletePath(dir);
  invalidateSkillsCache();
}
