import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { setDisabledTools } from "@/modules/settings/store";
import { groupTools, type ToolDescriptor } from "../tools/catalog";
import { listAvailableTools, listLocalTools } from "../tools/tools";
import { getToolContext } from "../store/chatStore";
import { ChevronRight, Wrench } from "lucide-react";

/**
 * Last enumerated tool list, kept OUTSIDE the component on purpose.
 *
 * The picker lives in the AI panel header, so closing the panel unmounts it and
 * used to throw the list away: the trigger's count silently disappeared until
 * the user opened the popover again. Surviving the remount here is what makes
 * the count permanent, and it also keeps MCP tools in the number without
 * reconnecting to their servers.
 */
let lastToolList: ToolDescriptor[] | null = null;

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
  const [tools, setToolsState] = useState<ToolDescriptor[] | null>(() => lastToolList);
  const [query, setQuery] = useState("");
  // Collapsed by default: a group header per server is the compact view, and
  // the header already carries the on/off count.
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const toggleGroup = useCallback((group: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }, []);

  const setTools = useCallback((list: ToolDescriptor[]) => {
    lastToolList = list;
    setToolsState(list);
  }, []);

  useEffect(() => {
    const ctx = getToolContext();
    if (!ctx) {
      // No session yet. Show the "open a chat first" hint when the popover is
      // open, but leave the cached count alone: a transient missing context is
      // not evidence that the tool list is empty.
      if (open) setToolsState([]);
      return;
    }
    if (!open) {
      // Cheap seed so the trigger shows a count straight away. Built-ins +
      // extension tools only: enumerating MCP here would spawn every enabled
      // server's subprocess for a user who may never open the picker.
      if (!lastToolList) setTools(listLocalTools(ctx));
      return;
    }
    // Opened: the full list, MCP included. The connect is deduped with the one
    // a turn makes, so it costs nothing extra.
    let cancelled = false;
    void listAvailableTools(ctx).then((list) => {
      if (!cancelled) setTools(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open, setTools]);

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

  const count = total > 0 ? `${onCount} of ${total} on` : null;
  const label = chatMode
    ? `Tools are off in chat mode${count ? ` (${count})` : ""}`
    : count
      ? `Tools: ${count}`
      : "Tools";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <IconTooltip label={label} side="bottom">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-label={label}
            className={cn(
              "text-muted-foreground hover:text-foreground h-7 gap-1 rounded-md px-1.5 text-[10.5px]",
              chatMode && "opacity-50",
            )}
          >
            <Wrench size={12} strokeWidth={1.75} className="shrink-0" />
            {/* Always rendered once the list is known, all-on included. Hiding
                it at 77/77 was read as the count "disappearing". */}
            {total > 0 ? (
              <span className="tabular-nums">
                {onCount}/{total}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
      </IconTooltip>

      <PopoverContent
        align="end"
        side="bottom"
        collisionPadding={8}
        className="w-80 max-w-[calc(100vw-1rem)] p-0"
      >
        <div className="border-border/60 border-b p-1.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter tools…"
            aria-label="Filter tools"
            className="h-6 text-[11px]"
          />
        </div>

        {chatMode ? (
          <p className="text-muted-foreground px-2 py-1.5 text-[10.5px]">
            Chat mode is on, so no tools are sent this turn whatever is ticked here.
          </p>
        ) : null}

        <div className="max-h-80 overflow-y-auto py-0.5">
          {tools === null ? (
            <div className="text-muted-foreground flex items-center gap-2 px-2.5 py-2 text-[11px]">
              <Spinner className="size-3" />
              Loading tools…
            </div>
          ) : groups.length === 0 ? (
            <p className="text-muted-foreground px-2.5 py-2 text-[11px]">
              {total === 0
                ? "No tools yet. Open a chat first, then reopen this."
                : `No tool matches "${query}".`}
            </p>
          ) : (
            groups.map(({ group, tools: rows }) => {
              const offInGroup = rows.filter((t) => disabledSet.has(t.name)).length;
              const groupState =
                offInGroup === 0 ? true : offInGroup === rows.length ? false : "indeterminate";
              // A filter force-opens every group: a hit you cannot see reads as no hit.
              const isOpen = !!query || openGroups.has(group);
              return (
                <Collapsible key={group} open={isOpen} onOpenChange={() => toggleGroup(group)}>
                  {/* The group checkbox sits beside the trigger, not inside it:
                      a checkbox nested in a trigger button is button-in-button. */}
                  <div className="hover:bg-accent/40 flex items-center gap-1.5 px-2 py-0.5">
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
                    <CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left">
                      <ChevronRight
                        size={11}
                        strokeWidth={2}
                        className={cn(
                          "text-muted-foreground/70 shrink-0 transition-transform",
                          isOpen && "rotate-90",
                        )}
                      />
                      <span className="text-muted-foreground truncate text-[10px] font-medium tracking-wide uppercase">
                        {group}
                      </span>
                      <span className="text-muted-foreground/60 ml-auto text-[10px] tabular-nums">
                        {rows.length - offInGroup}/{rows.length}
                      </span>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent className="pb-0.5">
                    {rows.map((t) => (
                      // One line per tool: the name leads, the description
                      // trails dimmed and ellipsises. The full text lives in the
                      // app's own tooltip - a native `title` was the odd one out
                      // here, with OS styling and a second-long delay.
                      <IconTooltip key={t.name} label={t.description || t.name} side="left">
                        <label className="hover:bg-accent/40 flex cursor-pointer items-center gap-1.5 py-0.5 pr-2 pl-7">
                          <Checkbox
                            checked={!disabledSet.has(t.name)}
                            onCheckedChange={(v) => setDisabled([t.name], v !== true)}
                            aria-label={t.name}
                          />
                          <span className="min-w-0 flex-1 truncate leading-4">
                            <span className="font-mono text-[11px]">{t.name}</span>
                            {t.description ? (
                              <span className="text-muted-foreground/60 ml-1.5 text-[10.5px]">
                                {t.description}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </IconTooltip>
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              );
            })
          )}
        </div>

        <div className="border-border/60 flex items-center justify-between gap-2 border-t py-1 pr-1 pl-2">
          <span className="text-muted-foreground/70 text-[10px] tabular-nums">
            {total > 0 ? `${onCount} of ${total} on` : ""}
          </span>
          <span className="flex gap-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10.5px]"
              disabled={!tools || onCount === total}
              onClick={() => setDisabled(tools?.map((t) => t.name) ?? [], false)}
            >
              All on
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-5 px-1.5 text-[10.5px]"
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
