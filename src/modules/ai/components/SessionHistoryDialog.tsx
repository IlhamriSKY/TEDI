import { useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Add01Icon, Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useChatStore } from "../store/chatStore";

/**
 * Modal session-history picker. Triggered by `/history`, the slash picker,
 * or the title bar. Same data as SessionPicker, but a full dialog so slash
 * commands can target it without depending on the title bar.
 */
export function SessionHistoryDialog() {
  const open = useChatStore((s) => s.showHistoryPicker);
  const setOpen = useChatStore((s) => s.setShowHistoryPicker);
  const sessions = useChatStore((s) => s.sessions);
  const activeId = useChatStore((s) => s.activeSessionId);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<{ id: string; title: string } | null>(null);

  const sorted = useMemo(() => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt), [sessions]);
  const filtered = useMemo(() => {
    if (!query.trim()) return sorted;
    const q = query.toLowerCase();
    return sorted.filter((s) => (s.title || "New chat").toLowerCase().includes(q));
  }, [sorted, query]);

  const close = () => setOpen(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQuery("");
      }}
    >
      <DialogContent className="flex max-h-[70vh] flex-col gap-0 p-0 sm:max-w-xl">
        <DialogHeader className="border-border/60 gap-2 border-b px-4 pt-4 pb-3">
          <DialogTitle className="text-sm">Chat history</DialogTitle>
          <DialogDescription className="text-[11.5px]">
            Switch to a past session, or start a fresh one.
          </DialogDescription>
          <div className="relative mt-1">
            <HugeiconsIcon
              icon={Search01Icon}
              size={13}
              strokeWidth={1.75}
              className="text-muted-foreground absolute top-1/2 left-2 -translate-y-1/2"
            />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  close();
                }
              }}
              placeholder="Filter sessions…"
              spellCheck={false}
              className="h-8 pl-7 text-[12px]"
            />
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
          {filtered.length === 0 ? (
            <div className="text-muted-foreground px-3 py-6 text-center text-[11.5px]">
              {query ? `No matches for "${query}"` : "No sessions yet."}
            </div>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {filtered.map((s) => {
                const isActive = s.id === activeId;
                return (
                  <li key={s.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      className={cn(
                        "group hover:bg-accent flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-[12px]",
                        isActive && "bg-accent/60",
                      )}
                      onClick={() => {
                        switchSession(s.id);
                        close();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          switchSession(s.id);
                          close();
                        }
                      }}
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate font-medium">{s.title || "New chat"}</span>
                        <span className="text-muted-foreground text-[10.5px]">
                          {formatRelativeTime(s.updatedAt)}
                          {isActive ? " · active" : ""}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPendingDelete({ id: s.id, title: s.title || "New chat" });
                        }}
                        aria-label={`Delete ${s.title || "session"}`}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0 cursor-pointer rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-border/60 flex items-center justify-between gap-2 border-t px-4 py-2.5">
          <span className="text-muted-foreground text-[10.5px]">
            {sessions.length} session{sessions.length === 1 ? "" : "s"} · Esc to close
          </span>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              newSession();
              close();
            }}
            className="h-7 gap-1.5 text-[11.5px]"
          >
            <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={2} />
            New chat
          </Button>
        </div>

        <AlertDialog
          open={pendingDelete !== null}
          onOpenChange={(o) => !o && setPendingDelete(null)}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete chat?</AlertDialogTitle>
              <AlertDialogDescription>
                {pendingDelete
                  ? `"${pendingDelete.title}" and its messages will be permanently deleted. This cannot be undone.`
                  : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  if (pendingDelete) deleteSession(pendingDelete.id);
                  setPendingDelete(null);
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}
