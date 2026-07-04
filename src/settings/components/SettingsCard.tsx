import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type Props = {
  title: ReactNode;
  description?: ReactNode;
  /** Inline node right after the title (e.g. a count / "updates available" badge). */
  badge?: ReactNode;
  /** Right-aligned header slot (e.g. a Switch or an action button). */
  headerRight?: ReactNode;
  children?: ReactNode;
  className?: string;
};

/**
 * Static titled settings card. Shares {@link SettingsAccordion}'s chrome
 * (border, background, padding, header typography) so a page can mix collapsible
 * accordions and always-open cards without a visual seam. Use for grouped
 * controls that should stay visible; reach for SettingsAccordion when the body
 * is long or optional enough to tuck behind a chevron.
 */
export function SettingsCard({
  title,
  description,
  badge,
  headerRight,
  children,
  className,
}: Props) {
  return (
    <section
      className={cn(
        "border-border/60 bg-card flex flex-col gap-2.5 rounded-lg border px-3 py-2.5",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-medium">{title}</span>
            {badge}
          </div>
          {description ? (
            <span className="text-muted-foreground text-[10.5px] leading-relaxed">
              {description}
            </span>
          ) : null}
        </div>
        {headerRight ? <div className="flex shrink-0 items-center gap-2">{headerRight}</div> : null}
      </div>
      {children}
    </section>
  );
}
