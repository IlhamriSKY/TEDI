import { useEffect, useRef } from "react";
import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { fileIconUrl, folderIconUrl } from "@/modules/explorer/lib/iconResolver";
import { CodeIcon, TerminalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

export type MentionItem =
  | {
      kind: "file";
      /** Absolute path. */
      path: string;
      /** Path relative to workspace root, for display. */
      rel: string;
      /** Basename. */
      name: string;
      /** True if open in an editor tab; boosted to top. */
      open: boolean;
    }
  | {
      kind: "folder";
      path: string;
      rel: string;
      name: string;
    }
  | {
      kind: "selection";
      source: "editor" | "terminal";
      /** Single-line truncated preview. */
      preview: string;
      lineCount: number;
      text: string;
    };

type Props = {
  items: readonly MentionItem[];
  activeIndex: number;
  onPick: (item: MentionItem) => void;
  onHover: (index: number) => void;
  loading?: boolean;
  query: string;
};

export function MentionPickerContent({
  items,
  activeIndex,
  onPick,
  onHover,
  loading,
  query,
}: Props) {
  // Sections in order: selections, open files, other files, folders. Caller
  // must pre-sort `items` in this order so `absIndex` matches visual order.
  const sections: {
    label: string;
    items: { item: MentionItem; absIndex: number }[];
  }[] = [];
  const indexed = items.map((item, i) => ({ item, absIndex: i }));
  const sel = indexed.filter((x) => x.item.kind === "selection");
  const openFiles = indexed.filter((x) => x.item.kind === "file" && x.item.open);
  const otherFiles = indexed.filter((x) => x.item.kind === "file" && !x.item.open);
  const folders = indexed.filter((x) => x.item.kind === "folder");
  if (sel.length) sections.push({ label: "Current selection", items: sel });
  if (openFiles.length) sections.push({ label: "Open files", items: openFiles });
  if (otherFiles.length) sections.push({ label: "Workspace files", items: otherFiles });
  if (folders.length) sections.push({ label: "Folders", items: folders });

  // Item refs by absIndex so ArrowUp/Down can scroll the highlighted row into view.
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  itemRefs.current.length = items.length;
  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

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
          {loading
            ? "Searching workspace…"
            : query
              ? `No matches for "${query}"`
              : "Type to search files, folders, or selections"}
        </div>
      ) : (
        <div className="max-h-96 overflow-y-auto py-1">
          {sections.map((s) => (
            <div key={s.label}>
              <SectionHeader label={s.label} />
              <ul>
                {s.items.map(({ item, absIndex }) => (
                  <li key={`${item.kind}-${itemKey(item, absIndex)}`}>
                    <button
                      ref={(el) => {
                        itemRefs.current[absIndex] = el;
                      }}
                      type="button"
                      onMouseEnter={() => onHover(absIndex)}
                      onClick={() => onPick(item)}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 px-2 py-1.5 text-left text-[12px]",
                        absIndex === activeIndex ? "bg-accent" : "hover:bg-accent/60",
                      )}
                    >
                      <ItemIcon item={item} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{itemPrimary(item)}</span>
                        <span className="text-muted-foreground truncate text-[10.5px]">
                          {itemSecondary(item)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </PopoverContent>
  );
}

function ItemIcon({ item }: { item: MentionItem }) {
  if (item.kind === "selection") {
    return (
      <HugeiconsIcon
        icon={item.source === "editor" ? CodeIcon : TerminalIcon}
        size={13}
        strokeWidth={1.75}
        className="text-muted-foreground shrink-0"
      />
    );
  }
  if (item.kind === "folder") {
    return (
      <img src={folderIconUrl(item.name, false)} alt="" aria-hidden className="size-3.5 shrink-0" />
    );
  }
  // Fallback icon when the extension doesn't map cleanly.
  return <img src={fileIconUrl(item.name)} alt="" aria-hidden className="size-3.5 shrink-0" />;
}

function itemPrimary(item: MentionItem): string {
  if (item.kind === "selection") {
    return item.source === "editor" ? "Editor selection" : "Terminal selection";
  }
  return item.name;
}

function itemSecondary(item: MentionItem): string {
  if (item.kind === "selection") {
    return `${item.lineCount} line${item.lineCount === 1 ? "" : "s"} · ${item.preview}`;
  }
  if (item.kind === "folder") return item.rel ? `${item.rel}/` : "/";
  return item.rel || item.path;
}

function itemKey(item: MentionItem, fallback: number): string {
  if (item.kind === "selection") return `sel-${fallback}`;
  return item.path;
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="text-muted-foreground/70 px-2 pt-1.5 pb-1 text-[10px] font-medium tracking-wide uppercase">
      {label}
    </div>
  );
}
