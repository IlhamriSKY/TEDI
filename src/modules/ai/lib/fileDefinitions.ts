/**
 * Sub-agents and skills defined as markdown files, beside the slash commands in `fileCommands.ts`.
 *
 *   <workspace>/.tedi/agents/<name>.md        <workspace>/.tedi/skills/<name>/SKILL.md
 *   <workspace>/.claude/agents/<name>.md      <workspace>/.claude/skills/<name>/SKILL.md
 *   ~/.tedi/agents/<name>.md                  ~/.tedi/skills/<name>/SKILL.md
 *
 * A repository's agent is read-only whatever its file says. A worker runs with no further cards, so
 * "may this edit my files" is not a question a cloned repository gets to answer: only your own
 * `~/.tedi/agents` may name write tools. No file picks a model either, which would be a way to send
 * the chat to a provider nobody chose.
 *
 * `~/.claude/skills` is left out on purpose: its names would be billed on every step of every chat
 * here, for skills written for another tool.
 *
 * Read at the start of a turn, not watched: a few small files, only when someone is about to use them.
 */
import { homeDir } from "@tauri-apps/api/path";
import { READ_ONLY_TOOLS, WORKER_TOOLS, type SubagentDef } from "../agents/registry";
import { commandNameFromFile, parseFrontmatter } from "./fileCommands";
import { native } from "./native";
import { checkReadableResolved } from "./security";

const MAX_BYTES = 64 * 1024;
/** Names on the `tedi` tool's description, which is billed per step. The rest are one verb away. */
const SKILLS_LISTED = 20;

/** Claude Code's names for the same tools, so an agent file written for it works here. */
const CLAUDE_TOOLS: Record<string, string[]> = {
  read: ["read_file"],
  ls: ["list_directory"],
  grep: ["grep"],
  glob: ["glob"],
  edit: ["edit"],
  multiedit: ["multi_edit"],
  write: ["write_file"],
  bash: ["bash_run"],
};

export type Skill = {
  name: string;
  description: string;
  body: string;
  /** Its folder, for the files the body refers to. */
  dir: string;
  source: "project" | "user";
};

/** One agent file -> its definition, or null when it has no prompt. Pure, for the verify. */
export function parseAgentFile(
  file: string,
  text: string,
  source: "project" | "user",
): SubagentDef | null {
  const { meta, body } = parseFrontmatter(text);
  const id = commandNameFromFile(meta.name ? `${meta.name}.md` : file);
  if (!id || !body) return null;
  const wanted = (meta.tools ?? "")
    .replace(/[[\]"']/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .flatMap((t) => CLAUDE_TOOLS[t.toLowerCase()] ?? [t]);
  const allowed = source === "user" ? WORKER_TOOLS : READ_ONLY_TOOLS;
  const tools = wanted.filter((t) => allowed.includes(t));
  return {
    id,
    label: meta.name || id,
    description:
      meta.description ||
      body
        .split("\n")[0]
        .replace(/^#+\s*/, "")
        .slice(0, 100),
    tools: tools.length ? [...new Set(tools)] : READ_ONLY_TOOLS,
    systemPrompt: body,
  };
}

/** A file's text, under the bar `read_file` clears: a repository can make any of these a link, and
 *  what comes back goes to the model with no card. */
async function readGuarded(path: string): Promise<string | null> {
  if (!(await checkReadableResolved(path)).ok) return null;
  const r = await native.readFile(path).catch(() => null);
  return r?.kind === "text" ? r.content : null;
}

async function readAgents(dir: string, source: "project" | "user"): Promise<SubagentDef[]> {
  const entries = await native.readDir(dir).catch(() => []);
  const out: SubagentDef[] = [];
  for (const e of entries) {
    if (e.kind === "dir" || e.size > MAX_BYTES || !/\.md$/i.test(e.name)) continue;
    const text = await readGuarded(`${dir}/${e.name}`);
    const def = text === null ? null : parseAgentFile(e.name, text, source);
    if (def) out.push(def);
  }
  return out;
}

async function readSkills(dir: string, source: "project" | "user"): Promise<Skill[]> {
  const entries = await native.readDir(dir).catch(() => []);
  const out: Skill[] = [];
  for (const e of entries) {
    if (e.kind !== "dir") continue;
    const folder = `${dir}/${e.name}`;
    const text = await readGuarded(`${folder}/SKILL.md`);
    if (text === null || text.length > MAX_BYTES) continue;
    const { meta, body } = parseFrontmatter(text);
    const name = commandNameFromFile(`${meta.name || e.name}.md`);
    if (name && body) {
      out.push({ name, description: meta.description ?? "", body, dir: folder, source });
    }
  }
  return out;
}

let homePromise: Promise<string | null> | null = null;
const home = () =>
  (homePromise ??= homeDir()
    .then((h) => h.replace(/\\/g, "/").replace(/\/+$/, ""))
    .catch(() => null));

const clean = (root: string | null | undefined) =>
  root?.replace(/\\/g, "/").replace(/\/+$/, "") ?? null;

/** The first definition of a name wins, in the order the folders are listed. */
function firstOfEach<T>(lists: T[][], nameOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return lists.flat().filter((item) => {
    const name = nameOf(item);
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

export async function loadSkills(workspaceRoot: string | null | undefined): Promise<Skill[]> {
  const root = clean(workspaceRoot);
  const h = await home();
  const lists = await Promise.all([
    root ? readSkills(`${root}/.tedi/skills`, "project") : [],
    root ? readSkills(`${root}/.claude/skills`, "project") : [],
    h ? readSkills(`${h}/.tedi/skills`, "user") : [],
  ]);
  return firstOfEach(lists, (s) => s.name).sort((a, b) => a.name.localeCompare(b.name));
}

let agentsNow: SubagentDef[] = [];
let skillsNow: Skill[] = [];

/** What `getAllSubagentDefs` folds in. Sync, because the tool descriptions are built sync. */
export const fileAgents = (): readonly SubagentDef[] => agentsNow;

/** The line the `tedi` tool's description gains, or nothing: no skills, no cost. */
export function skillsLine(): string {
  if (!skillsNow.length) return "";
  const shown = skillsNow
    .slice(0, SKILLS_LISTED)
    .map((s) => (s.description ? `${s.name} (${s.description.slice(0, 60)})` : s.name));
  const more = skillsNow.length - shown.length;
  return `\n- Skills, loaded with skill {name} when one fits: ${shown.join("; ")}${more > 0 ? `; ${more} more, skill lists them` : ""}.`;
}

/** Re-read the folders for this workspace. Called once per turn, before the tools are built. */
export async function refreshFileDefinitions(workspaceRoot: string | null | undefined) {
  const root = clean(workspaceRoot);
  const h = await home();
  const [agents, skills] = await Promise.all([
    Promise.all([
      root ? readAgents(`${root}/.tedi/agents`, "project") : [],
      root ? readAgents(`${root}/.claude/agents`, "project") : [],
      h ? readAgents(`${h}/.tedi/agents`, "user") : [],
    ]),
    loadSkills(root),
  ]);
  agentsNow = firstOfEach(agents, (a) => a.id);
  skillsNow = skills;
}

/** The `skills` capability: the list, or one skill in full. */
export async function skillCapability(name: string | null, root: string | null): Promise<unknown> {
  const skills = await loadSkills(root);
  if (!name)
    return skills.map(({ name: n, description, source }) => ({ name: n, description, source }));
  const found = skills.find((s) => s.name === name);
  if (!found) {
    throw new Error(`No skill "${name}". Have: ${skills.map((s) => s.name).join(", ") || "none"}.`);
  }
  return { name: found.name, dir: found.dir, body: found.body };
}
