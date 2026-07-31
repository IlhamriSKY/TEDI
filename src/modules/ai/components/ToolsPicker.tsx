import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setDisabledTools } from "@/modules/settings/store";
import { groupTools, type ToolDescriptor } from "../tools/catalog";
import { listAvailableTools } from "../tools/tools";
import { getToolContext } from "../store/chatStore";
import { Wrench } from "lucide-react";

/**
 * Per-tool on/off, the way Copilot's chat does it: one checkbox per tool,
 * grouped, covering built-ins, every installed MCP server, and extension tools
 * alike. The turn applies the result in ONE place (`applyToolFilter` in
 * agent.ts), so what is unchecked here is what the model does not receive.
 *
 * The list is read from the live session's ToolContext rather than a static
 * table, so it always shows exactly what this session would send.
 */
export function ToolsPicker() {
  const disabled = usePreferencesStore((s) => s.disabledTools);
  const chatMode = usePreferencesStore((s) => s.chatMode);
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<ToolDescriptor[] | null>(null);
  const [query, setQuery] = useState("");

  // Enumerated on open, not on mount: it awaits the MCP servers, and a user who
  // never opens the picker should not pay for that.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const ctx = getToolContext();
    if (!ctx) {
      setTools([]);
      return;
    }
    void listAvailableTools(ctx).then((list) => {
      if (!cancelled) setTools(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const disabledSet = useMemo(() => new Set(disabled), [disabled]);

  const setDisabled = useCallback(
    (names: string[], off: boolean) => {
      const next = new Set(disabled);
      for (const n of names) {
        if (off) next.add(n);
        else next.delete(n);
      }
      void setDisabledTools([...next]);
    },
    [disabled],
  );

  const filtered = useMemo(() => {
    if (!tools) return [];
    const q = query.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
  }, [tools, query]);

  const groups = useMemo(() => groupTools(filtered), [filtered]);
  const total = tools?.length ?? 0;
  const onCount = tools ? tools.filter((t) => !disabledSet.has(t.name)).length : 0;
  const someOff = total > 0 && onCount < total;

  const label = chatMode
    ? "Tools are off in chat mode"
    : someOff
      ? `Tools: ${onCount} of ${total} on`
      : "Tools";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <IconTooltip label={label} side="top">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={label}
            className={cn(
              "text-muted-foreground hover:text-foreground h-6 gap-1 rounded-md px-1.5 text-[10.5px]",
              chatMode && "opacity-50",
            )}
          >
            <Wrench size={12} strokeWidth={1.75} className="shrink-0" />
            {someOff ? (
              <span className="tabular-nums">
                {onCount}/{total}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
      </IconTooltip>

      <PopoverContent align="start" side="top" className="w-80 p-0">
        <div className="border-border/60 flex items-center gap-2 border-b p-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter tools…"
            aria-label="Filter tools"
            className="h-7 text-[12px]"
          />
        </div>

        {chatMode ? (
          <p className="text-muted-foreground px-3 py-2 text-[11px]">
            Chat mode is on, so no tools are sent this turn whatever is ticked here.
          </p>
        ) : null}

        <div className="max-h-80 overflow-y-auto py-1">
          {tools === null ? (
            <div className="text-muted-foreground flex items-center gap-2 px-3 py-3 text-[11.5px]">
              <Spinner className="size-3" />
              Loading tools…
            </div>
          ) : groups.length === 0 ? (
            <p className="text-muted-foreground px-3 py-3 text-[11.5px]">
              {total === 0
                ? "No tools yet. Open a chat first, then reopen this."
                : `No tool matches "${query}".`}
            </p>
          ) : (
            groups.map(({ group, tools: rows }) => {
              const offInGroup = rows.filter((t) => disabledSet.has(t.name)).length;
              const groupState =
                offInGroup === 0 ? true : offInGroup === rows.length ? false : "indeterminate";
              return (
                <div key={group} className="pb-1">
                  <label className="hover:bg-accent/40 flex cursor-pointer items-center gap-2 px-2.5 py-1">
                    <Checkbox
                      checked={groupState}
                      onCheckedChange={() =>
                        setDisabled(
                          rows.map((t) => t.name),
                          groupState === true,
                        )
                      }
                      aria-label={`Toggle all ${group} tools`}
                    />
                    <span className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                      {group}
                    </span>
                    <span className="text-muted-foreground/60 ml-auto text-[10px] tabular-nums">
                      {rows.length - offInGroup}/{rows.length}
                    </span>
                  </label>
                  {rows.map((t) => (
                    <label
                      key={t.name}
                      title={t.description}
                      className="hover:bg-accent/40 flex cursor-pointer items-start gap-2 py-0.5 pr-2.5 pl-6"
                    >
                      <Checkbox
                        checked={!disabledSet.has(t.name)}
                        onCheckedChange={(v) => setDisabled([t.name], v !== true)}
                        className="mt-0.5"
                        aria-label={t.name}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-[11px]">{t.name}</span>
                        {t.description ? (
                          <span className="text-muted-foreground line-clamp-1 text-[10.5px]">
                            {t.description}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              );
            })
          )}
        </div>

        <div className="border-border/60 flex items-center justify-between gap-2 border-t p-2">
          <span className="text-muted-foreground text-[10.5px]">
            {total > 0 ? `${onCount} of ${total} on` : ""}
          </span>
          <span className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={!tools || onCount === total}
              onClick={() => setDisabled(tools?.map((t) => t.name) ?? [], false)}
            >
              All on
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={!tools || onCount === 0}
              onClick={() => setDisabled(tools?.map((t) => t.name) ?? [], true)}
            >
              All off
            </Button>
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
