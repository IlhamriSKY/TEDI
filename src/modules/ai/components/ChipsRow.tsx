import { AnimatePresence, motion } from "motion/react";
import { fileIconUrl } from "@/modules/explorer/lib/iconResolver";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { FileAttachment } from "../lib/composer";
import type { Snippet } from "../lib/snippets";
import { Code, Hash, Terminal, X, type LucideIcon } from "lucide-react";

export function ChipsRow({
  files,
  onRemoveFile,
  snippets,
  onRemoveSnippet,
  commands,
  onRemoveCommand,
}: {
  files: FileAttachment[];
  onRemoveFile: (id: string) => void;
  snippets: Snippet[];
  onRemoveSnippet: (id: string) => void;
  commands: { name: string; label: string; icon: LucideIcon }[];
  onRemoveCommand: (name: string) => void;
}) {
  if (files.length === 0 && snippets.length === 0 && commands.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <AnimatePresence initial={false}>
        {commands.map((cmd) => {
          const CmdIcon = cmd.icon;
          return (
            <Tooltip key={`cmd-${cmd.name}`}>
              <TooltipTrigger asChild>
                <motion.div
                  layout
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.92 }}
                  transition={{ duration: 0.12 }}
                  className="group border-border/60 bg-card flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]"
                >
                  <CmdIcon size={11} strokeWidth={2} className="text-muted-foreground" />
                  <span className="font-medium">&gt;{cmd.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveCommand(cmd.name)}
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive ml-0.5 cursor-pointer rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Remove command"
                  >
                    <X size={10} strokeWidth={2} />
                  </button>
                </motion.div>
              </TooltipTrigger>
              <TooltipContent side="top">{cmd.label}</TooltipContent>
            </Tooltip>
          );
        })}
        {snippets.map((s) => (
          <Tooltip key={`snip-${s.id}`}>
            <TooltipTrigger asChild>
              <motion.div
                layout
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{ duration: 0.12 }}
                className="group border-primary/30 bg-primary/10 text-primary flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]"
              >
                <Hash size={11} strokeWidth={2} className="opacity-80" />
                <span className="font-medium">{s.handle}</span>
                <button
                  type="button"
                  onClick={() => onRemoveSnippet(s.id)}
                  className="hover:bg-destructive/10 hover:text-destructive ml-0.5 cursor-pointer rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                  aria-label="Remove snippet"
                >
                  <X size={10} strokeWidth={2} />
                </button>
              </motion.div>
            </TooltipTrigger>
            <TooltipContent side="top">{s.description || s.name}</TooltipContent>
          </Tooltip>
        ))}
        {files.map((f) => {
          const isImage = f.kind === "image" && Boolean(f.url);
          return (
            <Tooltip key={f.id}>
              <TooltipTrigger asChild>
                <motion.div
                  layout
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.92 }}
                  transition={{ duration: 0.12 }}
                  className="group border-border/60 bg-card flex max-w-full min-w-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]"
                >
                  {f.kind === "selection" ? (
                    f.source === "editor" ? (
                      <Code size={11} strokeWidth={2} className="text-muted-foreground shrink-0" />
                    ) : (
                      <Terminal
                        size={11}
                        strokeWidth={2}
                        className="text-muted-foreground shrink-0"
                      />
                    )
                  ) : (
                    <img
                      src={fileIconUrl(f.name)}
                      alt=""
                      aria-hidden
                      className="size-3.5 shrink-0"
                    />
                  )}
                  <span className="max-w-35 truncate">
                    {f.name}
                    {f.kind === "selection" && f.text ? (
                      <span className="text-muted-foreground ml-1">· {selLineCount(f.text)}L</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    onClick={() => onRemoveFile(f.id)}
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive ml-0.5 cursor-pointer rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Remove"
                  >
                    <X size={10} strokeWidth={2} />
                  </button>
                </motion.div>
              </TooltipTrigger>
              {/* Hover shows the actual picture for image attachments. Sized
                  against the viewport so it stays neat on a narrow/short panel. */}
              <TooltipContent
                side="top"
                className={isImage ? "max-w-[min(20rem,85vw)] overflow-hidden p-1" : undefined}
              >
                {isImage ? (
                  <img
                    src={f.url}
                    alt={f.name}
                    className="block h-auto max-h-[min(14rem,50vh)] w-auto max-w-full rounded-md object-contain"
                  />
                ) : (
                  f.name
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function selLineCount(text: string): number {
  if (!text) return 0;
  const trimmed = text.replace(/\n+$/, "");
  if (!trimmed) return 0;
  return trimmed.split("\n").length;
}
