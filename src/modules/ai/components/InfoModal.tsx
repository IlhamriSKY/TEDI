import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useInfoModalStore } from "../store/infoModalStore";

/**
 * Generic info dialog mounted globally by AiInputBar. Used by slash commands
 * (`/help`, `/model`, `/agents`, `/cost`) that need persistent content rather
 * than a transient toast.
 */
export function InfoModal() {
  const current = useInfoModalStore((s) => s.current);
  const dismiss = useInfoModalStore((s) => s.dismiss);
  const open = current !== null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) dismiss();
      }}
    >
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-2xl">
        {current ? (
          <>
            <DialogHeader className="border-border/60 gap-1 border-b px-5 pt-4 pb-3">
              <DialogTitle className="text-sm">{current.title}</DialogTitle>
              {current.subtitle ? (
                <DialogDescription className="text-[11.5px]">{current.subtitle}</DialogDescription>
              ) : null}
            </DialogHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <div className="flex flex-col gap-4">
                {current.sections.map((section, idx) => (
                  <div key={section.title ?? `s-${idx}`} className="flex flex-col gap-1.5">
                    {section.title ? (
                      <h3 className="text-muted-foreground/80 text-[10px] font-medium tracking-wider uppercase">
                        {section.title}
                      </h3>
                    ) : null}
                    <ul className="flex flex-col gap-1">
                      {section.rows.map((row, ri) => (
                        <li
                          key={`${idx}-${ri}-${row.label}`}
                          className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-baseline gap-3 text-[12px]"
                        >
                          {row.kbd ? (
                            <code
                              className={cn(
                                "bg-muted/60 text-foreground min-w-0 rounded px-1.5 py-0.5 font-mono text-[11px] break-words",
                                row.tone === "ok" && "text-diff-added",
                                row.tone === "warn" && "text-icon-working",
                                row.tone === "err" && "text-destructive",
                              )}
                            >
                              {row.kbd}
                            </code>
                          ) : (
                            // No kbd: the label IS the left column (e.g. an MCP
                            // server name). Prominent by default; tinted by tone
                            // (green = enabled/connected).
                            <span
                              className={cn(
                                "min-w-0 text-[11.5px] font-medium break-words",
                                row.tone === "ok"
                                  ? "text-diff-added"
                                  : row.tone === "warn"
                                    ? "text-icon-working"
                                    : row.tone === "err"
                                      ? "text-destructive"
                                      : "text-foreground",
                              )}
                            >
                              {row.label}
                            </span>
                          )}
                          <span className="text-muted-foreground/95 min-w-0 text-[11.5px] leading-snug break-words">
                            {row.kbd ? (
                              <>
                                <span className="text-foreground font-medium">{row.label}</span>
                                {row.desc ? (
                                  <span className="text-muted-foreground"> - {row.desc}</span>
                                ) : null}
                              </>
                            ) : (
                              row.desc
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>

            {current.footer ? (
              <div className="border-border/60 border-t px-5 py-2.5">
                <p className="text-muted-foreground text-[10.5px]">{current.footer}</p>
              </div>
            ) : null}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
