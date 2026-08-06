import { useEffect, useRef } from "react";
import { Terminal } from "lucide-react";
import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { TerminalInfo } from "@/modules/scheduler/types";
import type { SlashCommandMeta } from "../lib/slashCommands";
import type { Snippet } from "../lib/snippets";

export type PickerItem =
  | { kind: "terminal"; terminal: TerminalInfo }
  | { kind: "snippet"; snippet: Snippet }
  | { kind: "command"; command: SlashCommandMeta };

type Props = {
  items: readonly PickerItem[];
  activeIndex: number;
  onPick: (item: PickerItem) => void;
  onHover: (index: number) => void;
  /** Empty-state copy. Callers swap based on the triggering sigil. */
  emptyText?: string;
};

export function SnippetPickerContent({ items, activeIndex, onPick, onHover, emptyText }: Props) {
  // Open terminals, built-in commands, installed skills, and snippets render in
  // separate sections (Claude-Code style). Order matches the flat `items` array
  // so the running `cursor` stays in sync with keyboard nav.
  const terminals = items.filter((it) => it.kind === "terminal");
  const builtinCommands = items.filter((it) => it.kind === "command" && !it.command.isSkill);
  const skillCommands = items.filter((it) => it.kind === "command" && it.command.isSkill);
  const snippets = items.filter((it) => it.kind === "snippet");
  let cursor = -1;

  // Row refs so ArrowUp/Down can scroll the highlighted entry into view.
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  itemRefs.current.length = items.length;
  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const renderCommand = (it: PickerItem, i: number) => {
    if (it.kind !== "command") return null;
    const c = it.command;
    const Icon = c.icon;
    return (
      <li key={`cmd-${c.name}`}>
        <button
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          type="button"
          onMouseEnter={() => onHover(i)}
          onClick={() => onPick(it)}
          className={cn(
            "flex w-full cursor-pointer flex-col items-start gap-0.5 px-2 py-1.5 text-left text-[12px]",
            i === activeIndex ? "bg-accent" : "hover:bg-accent/60",
          )}
        >
          <span className="flex w-full items-center gap-1.5">
            <Icon size={13} strokeWidth={1.75} className="text-muted-foreground shrink-0" />
            <span className="text-primary font-mono font-medium">{c.invocation}</span>
            {c.argHint ? (
              <span className="text-icon-working font-mono text-[10.5px]">{c.argHint}</span>
            ) : null}
            {c.label && c.label !== c.name ? <span className="font-medium">{c.label}</span> : null}
          </span>
          <span className="text-muted-foreground line-clamp-2 pl-[18px] text-[10.5px]">
            {c.description}
          </span>
        </button>
      </li>
    );
  };

  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={6}
      onOpenAutoFocus={(e) => e.preventDefault()}
      onCloseAutoFocus={(e) => e.preventDefault()}
      onMouseDown={(e) => e.preventDefault()}
      className="border-border/60 bg-popover/95 w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border p-0 shadow-xl backdrop-blur-xl"
    >
      {items.length === 0 ? (
        <div className="text-muted-foreground px-3 py-2.5 text-[11px]">
          {emptyText ?? "No matches. Add snippets in Settings → Agents."}
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto py-1">
          {terminals.length > 0 && (
            <>
              <SectionHeader label="Terminals" />
              <ul>
                {terminals.map((it) => {
                  cursor += 1;
                  const i = cursor;
                  if (it.kind !== "terminal") return null;
                  const t = it.terminal;
                  return (
                    <li key={`term-${t.leafId}`}>
                      <button
                        ref={(el) => {
                          itemRefs.current[i] = el;
                        }}
                        type="button"
                        onMouseEnter={() => onHover(i)}
                        onClick={() => onPick(it)}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-1.5 px-2 py-1.5 text-left text-[12px]",
                          i === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                        )}
                      >
                        <Terminal
                          size={13}
                          strokeWidth={1.75}
                          className="text-muted-foreground shrink-0"
                        />
                        {/* Same `#<ordinal>` the model sees in `<env>` and writes
                            back in its replies, so the two notations match. */}
                        <span className="text-primary font-mono font-medium">#{t.ordinal}</span>
                        <span className="font-medium">{t.title || "shell"}</span>
                        {t.isActive ? (
                          <span className="text-icon-working text-[10.5px]">active</span>
                        ) : null}
                        <span className="text-muted-foreground ml-auto truncate pl-2 text-[10.5px]">
                          {t.cwd ?? ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {builtinCommands.length > 0 && (
            <>
              <SectionHeader label="Commands" />
              <ul>
                {builtinCommands.map((it) => {
                  cursor += 1;
                  return renderCommand(it, cursor);
                })}
              </ul>
            </>
          )}
          {skillCommands.length > 0 && (
            <>
              <SectionHeader label="Skills" />
              <ul>
                {skillCommands.map((it) => {
                  cursor += 1;
                  return renderCommand(it, cursor);
                })}
              </ul>
            </>
          )}
          {snippets.length > 0 && (
            <>
              <SectionHeader label="Snippets" />
              <ul>
                {snippets.map((it) => {
                  cursor += 1;
                  const i = cursor;
                  if (it.kind !== "snippet") return null;
                  const s = it.snippet;
                  return (
                    <li key={`sn-${s.id}`}>
                      <button
                        ref={(el) => {
                          itemRefs.current[i] = el;
                        }}
                        type="button"
                        onMouseEnter={() => onHover(i)}
                        onClick={() => onPick(it)}
                        className={cn(
                          "flex w-full cursor-pointer flex-col items-start gap-0.5 px-2 py-1.5 text-left text-[12px]",
                          i === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                        )}
                      >
                        <span className="flex w-full items-center gap-1.5">
                          <span className="text-muted-foreground font-mono">&gt;{s.handle}</span>
                          <span className="font-medium">{s.name}</span>
                        </span>
                        {s.description ? (
                          <span className="text-muted-foreground line-clamp-1 text-[10.5px]">
                            {s.description}
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      )}
    </PopoverContent>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="text-muted-foreground/70 px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide uppercase">
      {label}
    </div>
  );
}
