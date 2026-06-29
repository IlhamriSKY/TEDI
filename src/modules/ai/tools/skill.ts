import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import { getLoadedSkills, skillSlug } from "../lib/skills";
import type { ToolContext } from "./context";

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * `skill` tool: load an installed skill's SKILL.md so the agent can follow it.
 * First-class invocation (more reliable than a system-prompt hint): the tool's
 * description enumerates the installed skills, so the model always sees what's
 * available and which name to pass. Rebuilt each turn (see `buildTools`) so a
 * freshly installed skill appears without an app restart. Read-only -> auto.
 */
export function buildSkillTools(_ctx: ToolContext) {
  const skills = getLoadedSkills();
  const list = skills.length
    ? skills.map((s) => `- ${skillSlug(s)}: ${trunc(s.description, 400)}`).join("\n")
    : "(none installed yet)";
  return {
    skill: tool({
      description: `Load an installed skill (an expert playbook) and follow its instructions for the current task. Call this whenever the user's request matches one of these skills:\n${list}\n\nReturns the skill's full SKILL.md text. Auto.`,
      inputSchema: z.object({
        name: z.string().describe("Skill name from the list above."),
      }),
      execute: async ({ name }: { name: string }) => {
        const q = name.trim().toLowerCase();
        const all = getLoadedSkills();
        const skill =
          all.find((s) => skillSlug(s) === q) ?? all.find((s) => s.name.toLowerCase() === q);
        if (!skill) {
          return {
            error: `Unknown skill "${name}". Available: ${all.map(skillSlug).join(", ") || "(none)"}`,
          };
        }
        try {
          const r = await native.readFile(skill.path);
          return { name: skill.name, content: r.kind === "text" ? r.content : "" };
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
      },
    }),
  } as const;
}
