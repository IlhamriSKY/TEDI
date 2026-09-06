/**
 * The "AI Chat" entry shared by the two menus that can open one as a pane: the
 * header `+` (tabs view) and the canvas Add menu. One component, so the two
 * cannot offer different chats or different rules about which are already open.
 *
 * Picking a chat opens it as a PANE bound to that session. `openAiPane` dedupes
 * on the session, so choosing one that is already open focuses it instead of
 * making a second view of the same conversation; `openSessions` is what lets a
 * caller that knows its panes grey those entries out first.
 */
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useChatStore } from "../store/chatStore";
import { MessageSquarePlus, Sparkles } from "lucide-react";

/** Recent chats offered inline. The full history lives in the panel's own
 *  session picker; a menu is not a place to scroll a hundred rows. */
const MAX_LISTED = 12;

export function AiChatMenuItems({
  openSessions,
  onOpen,
}: {
  /** Sessions already open in a pane, greyed out. Omitted by callers that do
   *  not have the pane list to hand - `openAiPane` still refuses a duplicate. */
  openSessions?: ReadonlySet<string>;
  onOpen: (sessionId: string) => void;
}) {
  const sessions = useChatStore((s) => s.sessions);
  const newSession = useChatStore((s) => s.newSession);
  const recent = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_LISTED);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Sparkles size={14} strokeWidth={2} />
        <span className="flex-1 whitespace-nowrap">AI Chat</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-w-64 min-w-52">
        <DropdownMenuItem onSelect={() => onOpen(newSession())}>
          <MessageSquarePlus size={14} strokeWidth={2} />
          <span className="flex-1 whitespace-nowrap">New chat</span>
        </DropdownMenuItem>
        {recent.length > 0 ? <DropdownMenuSeparator /> : null}
        {recent.map((s) => {
          const already = openSessions?.has(s.id) ?? false;
          return (
            <DropdownMenuItem key={s.id} disabled={already} onSelect={() => onOpen(s.id)}>
              <span className="min-w-0 flex-1 truncate">{s.title.trim() || "New chat"}</span>
              {already ? (
                <span className="text-muted-foreground ml-2 shrink-0 text-[10px]">open</span>
              ) : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
