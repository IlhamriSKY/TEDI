import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState, type ReactNode } from "react";

type Props = {
  title: ReactNode;
  description?: ReactNode;
  /** Optional right-aligned hint in the header (e.g. "3 folders", "Default")
   *  so the collapsed row still says what's inside without opening it. */
  summary?: ReactNode;
  defaultOpen?: boolean;
  /** Controlled mode: when provided, the parent owns the open state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
};

/**
 * A bordered, collapsible settings card. Visually matches `SettingRow` when
 * closed (same border/background/padding) so a page can mix plain rows and
 * accordions without a seam; the header is the trigger and a chevron flips on
 * open. Use to tuck long/optional controls (sound uploads, PATH lists,
 * per-language formatters) behind a single tidy row.
 */
export function SettingsAccordion({
  title,
  description,
  summary,
  defaultOpen = false,
  open,
  onOpenChange,
  children,
  className,
}: Props) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : internalOpen;
  const setOpen = (v: boolean) => {
    if (!isControlled) setInternalOpen(v);
    onOpenChange?.(v);
  };

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setOpen}
      className={cn("border-border/60 bg-card/60 overflow-hidden rounded-lg border", className)}
    >
      <CollapsibleTrigger className="group hover:bg-card/80 flex w-full items-center justify-between gap-4 px-3 py-2.5 text-left transition-colors">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[12.5px] font-medium">{title}</span>
          {description ? (
            <span className="text-muted-foreground text-[10.5px] leading-relaxed">
              {description}
            </span>
          ) : null}
        </div>
        <div className="text-muted-foreground flex shrink-0 items-center gap-2 text-[10.5px]">
          {summary ? <span>{summary}</span> : null}
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            size={14}
            strokeWidth={2}
            className="transition-transform duration-200 group-data-[state=open]:rotate-180"
          />
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border/50 border-t px-3 py-2.5">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
