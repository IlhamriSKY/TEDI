import { Switch } from "@/components/ui/switch";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setSubagentsEnabled } from "@/modules/settings/store";
import { SettingsAccordion } from "../../components/SettingsAccordion";
import { SettingRow } from "../../components/SettingRow";

/**
 * Sub-agents: a single on/off. On exposes run_subagent / run_subagents AND turns
 * on auto-orchestration, so broad explore/review/audit work is delegated to
 * parallel sub-agents (with depends_on scatter -> gather) instead of being done
 * inline. The AI decides every NUMBER (parallelism, steps, task count, summary
 * size) per call, bounded by built-in backstops, so there are no numeric
 * settings. Per-type prompt/model overrides live in the System prompts card above.
 */
export function SubagentsCard() {
  const enabled = usePreferencesStore((s) => s.subagentsEnabled);

  return (
    <SettingsAccordion
      title="Sub-agents"
      description="Read-only workers the AI can spawn to research/review. On, broad tasks auto-delegate to parallel sub-agents (the AI decides how many, their depth, and the summary size); off does everything inline."
      summary={enabled ? "On" : "Off"}
    >
      <div className="flex flex-col gap-2">
        <SettingRow
          title="Enable sub-agents"
          description="On exposes run_subagent / run_subagents and auto-delegates broad explore/review/audit work to parallel sub-agents, chained with depends_on (scatter, then gather / synthesize). Off drops the tools from the AI's next message: zero sub-agent token spend."
        >
          <Switch checked={enabled} onCheckedChange={(v) => void setSubagentsEnabled(v)} />
        </SettingRow>
      </div>
    </SettingsAccordion>
  );
}
