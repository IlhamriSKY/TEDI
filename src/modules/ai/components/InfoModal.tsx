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
 * Generic info dialog rendered globally (always mounted by AiInputBar). Used
 * by slash commands that need to surface persistent content (e.g. `/help`,
 * `/model` list, `/agents` list, `/cost`) — those produce information the
 * user wants to read, not a transient acknowledgement, so they cannot be
 * surfaced via toast (which auto-dismisses after a few seconds).
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
                                "bg-muted/60 text-foreground rounded px-1.5 py-0.5 font-mono text-[11px]",
                                row.tone === "ok" && "text-emerald-700 dark:text-emerald-300",
                                row.tone === "warn" && "text-amber-700 dark:text-amber-300",
                                row.tone === "err" && "text-red-700 dark:text-red-300",
                              )}
                            >
                              {row.kbd}
                            </code>
                          ) : (
                            <span className="text-muted-foreground text-[11.5px]">{row.label}</span>
                          )}
                          <span className="text-muted-foreground/95 text-[11.5px] leading-snug">
                            {row.kbd ? (
                              <>
                                <span className="text-foreground font-medium">{row.label}</span>
                                {row.desc ? (
                                  <span className="text-muted-foreground"> — {row.desc}</span>
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
