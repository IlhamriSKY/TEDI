import { extToolMedia } from "@mcp/tools.mjs";
import type { UIMessage } from "@ai-sdk/react";
import { LazyStore } from "@tauri-apps/plugin-store";

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

const STORE_PATH = "tedi-sessions.json";
const KEY_SESSIONS = "sessions";
const KEY_ACTIVE = "activeId";
const messagesKey = (id: string) => `messages:${id}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export type LoadedSessions = {
  sessions: SessionMeta[];
  activeId: string | null;
};

export async function loadAll(): Promise<LoadedSessions> {
  // Two targeted get()s, NOT entries(). This same store file also holds every
  // conversation under `messages:<id>` (see saveMessages), so entries() shipped
  // the entire accumulated chat history over IPC + JSON.parsed it on the main
  // thread just to read these two small keys - it grows unbounded with usage.
  // The whole file is still loaded once natively by the LazyStore, but only
  // these values cross the bridge. Messages stay lazy via `loadMessages`.
  const [sessions, activeId] = await Promise.all([
    store.get<SessionMeta[]>(KEY_SESSIONS),
    store.get<string | null>(KEY_ACTIVE),
  ]);
  return { sessions: sessions ?? [], activeId: activeId ?? null };
}

export async function loadMessages(id: string): Promise<UIMessage[] | null> {
  return (await store.get<UIMessage[]>(messagesKey(id))) ?? null;
}

export async function saveSessionsList(sessions: SessionMeta[]): Promise<void> {
  await store.set(KEY_SESSIONS, sessions);
}

export async function saveActiveId(id: string | null): Promise<void> {
  await store.set(KEY_ACTIVE, id);
}

/**
 * A tool's image is for the model, this turn. Saved, it is megabytes of base64 in
 * the one store file, which is rewritten whole on every save, and whatever was on
 * screen sitting on disk in plaintext. `extToolMedia` reads an empty `data` as no
 * media, so a reopened chat sends the note instead of a broken image.
 */
function withoutMedia(messages: UIMessage[]): UIMessage[] {
  type Part = UIMessage["parts"][number];
  const strip = (part: Part): Part => {
    const output = (part as { output?: unknown }).output;
    const media = extToolMedia(output);
    if (!media) return part;
    const content = media.text || "[image not kept]";
    return { ...part, output: { ...(output as object), data: "", content } } as Part;
  };
  return messages.map((m) => (m.parts ? { ...m, parts: m.parts.map(strip) } : m));
}

export async function saveMessages(id: string, messages: UIMessage[]): Promise<void> {
  await store.set(messagesKey(id), withoutMedia(messages));
}

/** Force a durable write of all pending store mutations. `autoSave: 200` only
 *  re-arms a 200ms timer, so an abrupt quit within that window loses the tail;
 *  explicit flush points call this to guarantee the write landed on disk. */
export async function saveNow(): Promise<void> {
  await store.save();
}

export async function deleteSessionData(id: string): Promise<void> {
  await store.delete(messagesKey(id));
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function deriveTitle(messages: UIMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      const text = (p as { text: string }).text
        .replace(/<tedi-command[^>]*\/>\s*/g, "")
        .replace(/<terminal-context[\s\S]*?<\/terminal-context>\s*/g, "")
        .replace(/<selection[\s\S]*?<\/selection>\s*/g, "")
        .replace(/<file[\s\S]*?<\/file>\s*/g, "")
        .trim();
      if (!text) continue;
      const first = text.split("\n")[0].trim();
      return first.length > 40 ? `${first.slice(0, 40)}…` : first;
    }
  }
  return "New chat";
}
