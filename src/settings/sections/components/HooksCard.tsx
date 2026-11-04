import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { addAiHook, type AiHook, removeAiHook } from "@/modules/settings/store";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { SettingsAccordion } from "../../components/SettingsAccordion";

const EVENTS: AiHook["event"][] = ["PreToolUse", "PostToolUse", "Stop"];

/**
 * Shell commands around the agent's tools. Only ever added here, by a person: a hook runs with no
 * approval card, so an agent is refused the write (`AGENT_DENIED_PREFS`) and a repository has no file
 * that defines one.
 */
export function HooksCard() {
  const hooks = usePreferencesStore((s) => s.aiHooks);
  const [event, setEvent] = useState<AiHook["event"]>("PostToolUse");
  const [tool, setTool] = useState("");
  const [command, setCommand] = useState("");

  const add = () => {
    if (!command.trim()) return;
    void addAiHook({
      event,
      command: command.trim(),
      ...(tool.trim() && event !== "Stop" ? { tool: tool.trim() } : {}),
    });
    setCommand("");
  };

  return (
    <SettingsAccordion
      title="Hooks"
      description="Your own shell commands around the agent's tools, with no approval card. Before a tool, exit 2 blocks it and stderr tells the agent why, and so does a command that times out or will not start. After a tool, a non-zero exit shows the agent the output. Stop runs when a turn ends. A command reads TEDI_TOOL, TEDI_TOOL_INPUT and TEDI_FILE from its environment."
      summary={hooks.length > 0 ? `${hooks.length} hook${hooks.length === 1 ? "" : "s"}` : "None"}
    >
      <div className="flex flex-col gap-2">
        {hooks.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {hooks.map((h) => (
              <li
                key={`${h.event}\u0000${h.tool ?? ""}\u0000${h.command}`}
                className="border-border/60 bg-card flex items-center gap-2 rounded-lg border px-3 py-2"
              >
                <code className="bg-muted/50 text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px]">
                  {h.event}
                  {h.tool ? ` ${h.tool}` : ""}
                </code>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{h.command}</span>
                <IconTooltip label="Remove" side="left">
                  <Button
                    size="icon"
                    variant="ghost"
                    className={cn(DESTRUCTIVE_ACTION, "size-7")}
                    onClick={() => void removeAiHook(h)}
                    aria-label="Remove"
                  >
                    <Trash2 size={12} strokeWidth={1.75} />
                  </Button>
                </IconTooltip>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-1" role="group" aria-label="When">
          {EVENTS.map((e) => (
            <Button
              key={e}
              size="sm"
              variant={event === e ? "secondary" : "ghost"}
              aria-pressed={event === e}
              onClick={() => setEvent(e)}
            >
              {e}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Input
            className="w-36 shrink-0 font-mono"
            placeholder={event === "Stop" ? "any" : "edit|write_file"}
            aria-label="Tools, any when empty"
            disabled={event === "Stop"}
            value={event === "Stop" ? "" : tool}
            onChange={(e) => setTool(e.target.value)}
          />
          <Input
            className="min-w-0 flex-1 font-mono"
            placeholder="pnpm exec prettier --write $TEDI_FILE"
            aria-label="Command"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <Button size="sm" variant="secondary" disabled={!command.trim()} onClick={add}>
            Add
          </Button>
        </div>
      </div>
    </SettingsAccordion>
  );
}
