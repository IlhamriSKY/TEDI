import type { UIMessage } from "ai";
import type { ProviderId } from "../config";
import { TEDI_CMD_RE } from "./slashCommands";

export type ExtractedFile = { name: string };
export type ExtractedSelection = {
  source: "terminal" | "editor";
  lines: number;
};

/** Metadata stamped onto outgoing user messages so the chat view can render
 *  the send-time model and provider. Client-side only; not sent to the LLM. */
export type TediUserMetadata = {
  tediModel: string;
  tediModelLabel: string;
  /** The provider gateway id (e.g. "openai-compatible"). */
  tediProvider: ProviderId;
  /** Raw `owned_by` from `/v1/models` if known. Preferred over the gateway
   *  label so the chip credits the model maker, not the proxy. */
  tediOwnedBy?: string;
  sentAt: number;
};

/** Returns the metadata bag if it looks like ours, else null. */
export function getTediUserMetadata(message: UIMessage): TediUserMetadata | null {
  const m = message.metadata as { [k: string]: unknown } | undefined;
  if (!m) return null;
  if (typeof m.tediModel !== "string") return null;
  if (typeof m.tediModelLabel !== "string") return null;
  if (typeof m.tediProvider !== "string") return null;
  return {
    tediModel: m.tediModel,
    tediModelLabel: m.tediModelLabel,
    tediProvider: m.tediProvider as ProviderId,
    tediOwnedBy: typeof m.tediOwnedBy === "string" ? m.tediOwnedBy : undefined,
    sentAt: typeof m.sentAt === "number" ? m.sentAt : 0,
  };
}

export type ExtractedMessage = {
  files: ExtractedFile[];
  selections: ExtractedSelection[];
  snippets: string[];
  commandName: string | null;
  body: string;
};

/** Same shape the composer originally embedded. Used to rebuild composer
 *  state during history recall (ArrowUp/Down). */
export type RecalledFile = {
  name: string;
  mediaType: string;
  content: string;
};
export type RecalledSelection = {
  source: "terminal" | "editor";
  text: string;
};
export type RecalledMessage = {
  body: string;
  commandName: string | null;
  files: RecalledFile[];
  selections: RecalledSelection[];
  /** Snippet handles. Resolve via the snippets store for the full record. */
  snippetHandles: string[];
};

/** Strip `<file>`, `<selection>`, `<snippet>`, and leading `<tedi-command />`
 *  blocks from a user message. Returns the surviving body and a summary of
 *  each block for chip rendering. */
export function extractUserMessage(raw: string): ExtractedMessage {
  const cmdMatch = raw.match(TEDI_CMD_RE);
  const commandName = cmdMatch?.[1] ?? null;
  let body = cmdMatch ? raw.slice(cmdMatch[0].length) : raw;

  const files: ExtractedFile[] = [];
  const selections: ExtractedSelection[] = [];
  const snippets: string[] = [];

  body = body.replace(
    /<file\s+name="([^"]+)"(?:\s+mediaType="[^"]*")?>[\s\S]*?<\/file>/g,
    (_m, name) => {
      files.push({ name });
      return "";
    },
  );
  body = body.replace(
    /<selection\s+source="([^"]+)">([\s\S]*?)<\/selection>/g,
    (_m, source, content: string) => {
      const trimmed = content.replace(/^\n+/, "").replace(/\n+$/, "");
      const lines = trimmed ? trimmed.split("\n").length : 0;
      const src = source === "editor" ? "editor" : "terminal";
      selections.push({ source: src, lines });
      return "";
    },
  );
  body = body.replace(/<snippet\s+name="([^"]+)">[\s\S]*?<\/snippet>/g, (_m, name) => {
    snippets.push(name);
    return "";
  });
  // Composer joins with "\n\n"; collapse orphan blank lines.
  body = body
    .replace(/^\s+/, "")
    .replace(/\s+$/, "")
    .replace(/\n{3,}/g, "\n\n");

  return { files, selections, snippets, commandName, body };
}

/** Concatenate text parts of a user UIMessage and return the visible body
 *  (no markup, no embedded blocks). Empty string if attachments-only. */
export function getUserMessageBody(message: UIMessage): string {
  if (message.role !== "user") return "";
  const raw = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  return extractUserMessage(raw).body;
}

/** Full recall payload: body, command, files, selections, snippets. File and
 *  selection contents are preserved so the input bar can restore chips. */
export function recallUserMessage(message: UIMessage): RecalledMessage {
  if (message.role !== "user") {
    return {
      body: "",
      commandName: null,
      files: [],
      selections: [],
      snippetHandles: [],
    };
  }
  const raw = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");

  const cmdMatch = raw.match(TEDI_CMD_RE);
  const commandName = cmdMatch?.[1] ?? null;
  let body = cmdMatch ? raw.slice(cmdMatch[0].length) : raw;

  const files: RecalledFile[] = [];
  const selections: RecalledSelection[] = [];
  const snippetHandles: string[] = [];

  body = body.replace(
    /<file\s+name="([^"]+)"(?:\s+mediaType="([^"]*)")?>([\s\S]*?)<\/file>/g,
    (_m, name, mediaType, content: string) => {
      files.push({
        name,
        mediaType: mediaType || "text/plain",
        content: content.replace(/^\n+/, "").replace(/\n+$/, ""),
      });
      return "";
    },
  );
  body = body.replace(
    /<selection\s+source="([^"]+)">([\s\S]*?)<\/selection>/g,
    (_m, source: string, content: string) => {
      selections.push({
        source: source === "editor" ? "editor" : "terminal",
        text: content.replace(/^\n+/, "").replace(/\n+$/, ""),
      });
      return "";
    },
  );
  body = body.replace(/<snippet\s+name="([^"]+)">[\s\S]*?<\/snippet>/g, (_m, name) => {
    snippetHandles.push(name);
    return "";
  });
  body = body
    .replace(/^\s+/, "")
    .replace(/\s+$/, "")
    .replace(/\n{3,}/g, "\n\n");

  return { body, commandName, files, selections, snippetHandles };
}
