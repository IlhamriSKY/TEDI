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
import { sectionTools, toolRowLabel, type ToolDescriptor } from "../tools/catalog";
import { listAvailableTools, listLocalTools } from "../tools/tools";
import { getToolContext } from "../store/chatStore";
import { ChevronRight, Wrench } from "lucide-react";

/**
 * Last enumerated tool list, kept OUTSIDE the component on purpose.
 *
 * The picker lives in the panel header, so closing the panel unmounts it and
 * used to throw the list away, blanking the trigger's count until the popover
 * was reopened. Surviving the remount also keeps MCP tools in that number
 * without reconnecting to their servers.
 */
let lastToolList: ToolDescriptor[] | null = null;

/**
 * Per-tool on/off: one grouped checkbox each, covering built-ins, MCP servers
 * and extension tools alike. The turn applies the result in ONE place
 * (`applyToolFilter`), so unchecked here is what the model never receives.
 *
 * Read from the live session's ToolContext, not a static table, so it always
 * shows exactly what this session would send.
 */
export function ToolsPicker() {
  const disabled = usePreferencesStore((s) => s.disabledTools);
  const chatMode = usePreferencesStore((s) => s.chatMode);
  const [open, setOpen] = useState(false);
  const [tools, setToolsState] = useState<ToolDescriptor[] | null>(() => lastToolList);
  const [query, setQuery] = useState("");
  // OPPOSITE DEFAULTS, on purpose. Sections start OPEN and groups start CLOSED,
  // so the list opens on the same thing it always did: one screen of group
  // headers, each with its own count, one click from the tools. Defaulting both
  // levels closed would have put three headings and nothing else on screen and
  // made every tool two clicks away - a nested list that hides more than the
  // flat one it replaced is not an improvement.
  //
  // Two sets rather than one keyed map, because the two defaults are genuinely
  // different: a name in `closedSections` means closed, a name in `openGroups`
  // means open.
  const [closedSections, setClosedSections] = useState<Set<string>>(new Set());
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const flip = (set: (fn: (prev: Set<string>) => Set<string>) => void) => (key: string) => {
    set((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleSection = useCallback(flip(setClosedSections), []);
  const toggleGroup = useCallback(flip(setOpenGroups), []);

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
    // Seed synchronously so the trigger has a number on the very first paint:
    // built-ins and extension tools, both of which are already in memory.
    if (!lastToolList) setTools(listLocalTools(ctx));

    // Then fold in MCP, WITHOUT waiting for the popover to be opened.
    //
    // The trigger's count claims to be what the model receives, so it has to
    // include the MCP servers - leaving them until the popover opens would put a
    // number on screen that the next turn contradicts, and one the on/off maths
    // is computed against.
    //
    // Connecting here costs nothing extra in practice: this component exists only
    // while the AI panel is mounted, and any turn from that panel connects the
    // same servers. Nothing blocks on it either - the cheap list above is already
    // painted, and this only corrects it.
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
    // Group too: typing "browser" or "schedule" is how you find a whole family,
    // and those words are not always in every member's name or blurb.
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        t.group.toLowerCase().includes(q) ||
        // Section too, so "mcp" finds every server's tools and "extension"
        // finds everything an installed extension lends the agent.
        t.section.toLowerCase().includes(q),
    );
  }, [tools, query]);

  const sections = useMemo(() => sectionTools(filtered), [filtered]);
  const total = tools?.length ?? 0;
  const onCount = tools ? tools.filter((t) => !disabledSet.has(t.name)).length : 0;

  // With a filter on, the bulk buttons must act on what is VISIBLE. "All off"
  // wiping 88 tools while the list shows 3 is the kind of surprise you only
  // discover one turn later, when the model has no tools.
  const scoped = useMemo(
    () => (query.trim() ? filtered : (tools ?? [])).map((t) => t.name),
    [query, filtered, tools],
  );
  const scopedOn = useMemo(
    () => scoped.filter((n) => !disabledSet.has(n)).length,
    [scoped, disabledSet],
  );
  const scopeLabel = query.trim() ? "Shown" : "All";

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
        // Still read: `collisionPadding` feeds the SIZE middleware as well as
        // the (now disabled) collision ones, so it is what keeps the 8px of
        // breathing room in the available-space numbers below.
        collisionPadding={8}
        // OPENS DOWNWARD, ALWAYS. The AI panel is one section in a dockable
        // stack, so this trigger can sit anywhere from the top of the window to
        // the bottom of it - and with collision handling on, Radix flipped the
        // panel above the button whenever the section happened to be docked low.
        // Same click, different direction, depending on a layout choice made
        // days earlier. Turning the flip off is what makes the position fixed.
        //
        // The flip was also doing real work, so both of its jobs are taken over
        // by `size`, which runs unconditionally:
        //   - vertical: max-height is the space actually available below the
        //     trigger, so a short window shrinks the list and scrolls it instead
        //     of clipping the All on / All off footer,
        //   - horizontal: width is capped by the space available in the align
        //     direction, so losing `shift` cannot push the panel off-screen when
        //     the AI section is docked to a narrow left column.
        // Both vars come from the same `size` pass, and with no flip to fight
        // there is nothing for them to oscillate against.
        avoidCollisions={false}
        // `gap-0`: the sections carry their own divider borders, and the
        // popover base class ships `gap-4`, which pushed a 1rem hole between
        // each divider and the content under it.
        className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(30rem,var(--radix-popover-content-available-width))] flex-col gap-0 p-0"
      >
        <div className="border-border/60 shrink-0 border-b p-1.5">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter tools…"
            aria-label="Filter tools"
            className="h-6 text-[11px]"
          />
        </div>

        {chatMode ? (
          <p className="text-muted-foreground shrink-0 px-2 py-1.5 text-[10.5px]">
            Chat mode is on, so no tools are sent this turn whatever is ticked here.
          </p>
        ) : null}

        {/* The only part that gives: `flex-1 min-h-0` lets it absorb whatever
            the filter row and footer leave over, so those two stay put however
            little room the popover was given. `max-h` still caps it on a tall
            screen, where "all the space available" would be a 1500px list. */}
        <div className="max-h-[26rem] min-h-0 flex-1 overflow-x-hidden overflow-y-auto py-0.5">
          {tools === null ? (
            <div className="text-muted-foreground flex items-center gap-2 px-2.5 py-2 text-[11px]">
              <Spinner className="size-3" />
              Loading tools…
            </div>
          ) : sections.length === 0 ? (
            <p className="text-muted-foreground px-2.5 py-2 text-[11px]">
              {total === 0
                ? "No tools yet. Open a chat first, then reopen this."
                : `No tool matches "${query}".`}
            </p>
          ) : (
            sections.map(({ section, tools: all, groups }) => {
              const offInSection = all.filter((t) => disabledSet.has(t.name)).length;
              const sectionState =
                offInSection === 0 ? true : offInSection === all.length ? false : "indeterminate";
              // A section with ONE group would be a header wrapping a header
              // saying nearly the same thing, so it collapses to just the
              // group rows. Common in practice: MCP with only `tedi` connected.
              const flat = groups.length === 1;
              const sectionOpen = !!query || !closedSections.has(section);
              return (
                <div key={section}>
                  <Collapsible open={sectionOpen} onOpenChange={() => toggleSection(section)}>
                    <div className="bg-popover hover:bg-accent/40 sticky top-0 z-20 flex items-center gap-1.5 px-2 py-1">
                      <Checkbox
                        checked={sectionState}
                        onCheckedChange={() =>
                          setDisabled(
                            all.map((t) => t.name),
                            sectionState === true,
                          )
                        }
                        aria-label={`Toggle all ${section} tools`}
                      />
                      <CollapsibleTrigger className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left">
                        <ChevronRight
                          size={11}
                          strokeWidth={2}
                          className={cn(
                            "text-muted-foreground/70 shrink-0 transition-transform",
                            sectionOpen && "rotate-90",
                          )}
                        />
                        <span className="truncate text-[10px] font-semibold tracking-wide uppercase">
                          {section}
                        </span>
                        <span className="text-muted-foreground/60 ml-auto text-[10px] tabular-nums">
                          {all.length - offInSection}/{all.length}
                        </span>
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent>
                      {groups.map(({ group, tools: rows }) => {
                        const offInGroup = rows.filter((t) => disabledSet.has(t.name)).length;
                        const groupState =
                          offInGroup === 0
                            ? true
                            : offInGroup === rows.length
                              ? false
                              : "indeterminate";
                        const key = `${section}/${group}`;
                        // A filter force-opens everything: a hit you cannot see
                        // reads as no hit.
                        const isOpen = !!query || flat || openGroups.has(key);
                        return (
                          <Collapsible
                            key={key}
                            open={isOpen}
                            onOpenChange={() => toggleGroup(key)}
                          >
                            {/* The group checkbox sits beside the trigger, not
                                inside it: a checkbox nested in a trigger button
                                is button-in-button. */}
                            {flat ? null : (
                              <div className="bg-popover hover:bg-accent/40 flex items-center gap-1.5 py-1 pr-2 pl-5">
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
                                  <span className="text-muted-foreground truncate text-[10px] font-medium tracking-wide">
                                    {group}
                                  </span>
                                  <span className="text-muted-foreground/60 ml-auto text-[10px] tabular-nums">
                                    {rows.length - offInGroup}/{rows.length}
                                  </span>
                                </CollapsibleTrigger>
                              </div>
                            )}
                            <CollapsibleContent className="pb-0.5">
                              {rows.map((t) => (
                                // One line per tool: name then dimmed description. They are
                                // SEPARATE truncating spans - as one run under a single
                                // `truncate`, a long name (every MCP tool) consumed the
                                // whole row and the description never rendered. The name is
                                // also capped so it can never do that again, and the full
                                // text stays in the app's own tooltip (a native `title` was
                                // the odd one out here: OS styling, second-long delay).
                                <IconTooltip
                                  key={t.name}
                                  label={t.description ? `${t.name} - ${t.description}` : t.name}
                                  side="left"
                                >
                                  <label className="hover:bg-accent/40 flex cursor-pointer items-center gap-1.5 py-1 pr-2 pl-7">
                                    <Checkbox
                                      checked={!disabledSet.has(t.name)}
                                      onCheckedChange={(v) => setDisabled([t.name], v !== true)}
                                      aria-label={t.name}
                                    />
                                    <span className="max-w-[55%] shrink-0 truncate font-mono text-[11px] leading-4">
                                      {toolRowLabel(t.name)}
                                    </span>
                                    {t.description ? (
                                      <span className="text-muted-foreground/60 min-w-0 flex-1 truncate text-[10.5px] leading-4">
                                        {t.description}
                                      </span>
                                    ) : null}
                                  </label>
                                </IconTooltip>
                              ))}
                            </CollapsibleContent>
                          </Collapsible>
                        );
                      })}
                    </CollapsibleContent>
                  </Collapsible>
                </div>
              );
            })
          )}
        </div>

        <div className="border-border/60 flex shrink-0 items-center justify-between gap-2 border-t py-1 pr-1 pl-2">
          {/* While a filter is on, "1 of 88 on" answers a question nobody asked:
              what you want to know is how much of the list you are looking at. */}
          <span className="text-muted-foreground/70 min-w-0 truncate text-[10px] tabular-nums">
            {total === 0
              ? ""
              : query.trim()
                ? `${filtered.length} of ${total} shown`
                : `${onCount} of ${total} on`}
          </span>
          <span className="flex shrink-0 gap-0.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10.5px]"
              disabled={!tools || scoped.length === 0 || scopedOn === scoped.length}
              onClick={() => setDisabled(scoped, false)}
            >
              {scopeLabel} on
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-5 px-1.5 text-[10.5px]"
              disabled={!tools || scoped.length === 0 || scopedOn === 0}
              onClick={() => setDisabled(scoped, true)}
            >
              {scopeLabel} off
            </Button>
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
