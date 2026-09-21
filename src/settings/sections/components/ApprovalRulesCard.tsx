import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { removeApprovalRule } from "@/modules/settings/store";
import { Trash2 } from "lucide-react";
import { SettingsAccordion } from "../../components/SettingsAccordion";

/**
 * Every "Always allow" made from an approval card, with a way to take it back.
 * Rules are only ever ADDED from a card, by a person clicking it; an agent is
 * refused the write (`AGENT_DENIED_PREFS`), which is why there is no "add" here.
 */
export function ApprovalRulesCard() {
  const rules = usePreferencesStore((s) => s.approvalRules);
  return (
    <SettingsAccordion
      title="Always allowed"
      description="Tool calls you approved with Always allow on an approval card. They run without asking in Ask and Semi mode, in every chat. A shell rule covers one command prefix and never a line that chains, pipes or redirects; a request rule covers GETs to one host."
      summary={rules.length > 0 ? `${rules.length} rule${rules.length === 1 ? "" : "s"}` : "None"}
    >
      {rules.length === 0 ? (
        <div className="border-border/60 bg-card/30 text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-[11px]">
          Nothing yet. Choose Always allow on an approval card to stop being asked for that call.
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rules.map((r) => (
            <li
              key={`${r.tool}\u0000${r.match ?? ""}`}
              className="border-border/60 bg-card flex items-center gap-2 rounded-lg border px-3 py-2"
            >
              <code className="bg-muted/50 text-muted-foreground shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px]">
                {r.tool}
              </code>
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
                {r.match ?? <span className="text-muted-foreground font-sans">any call</span>}
              </span>
              <IconTooltip label="Remove" side="left">
                <Button
                  size="icon"
                  variant="ghost"
                  className={cn(DESTRUCTIVE_ACTION, "size-7")}
                  onClick={() => void removeApprovalRule(r)}
                  aria-label="Remove"
                >
                  <Trash2 size={12} strokeWidth={1.75} />
                </Button>
              </IconTooltip>
            </li>
          ))}
        </ul>
      )}
    </SettingsAccordion>
  );
}
