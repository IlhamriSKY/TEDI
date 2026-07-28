import { useChat, type UIMessage } from "@ai-sdk/react";
import type { ToolUIPart, UIMessagePart } from "ai";
import { memo, useEffect, useMemo, useRef } from "react";
import type { AiDiffStatus } from "@/modules/tabs";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { native } from "../lib/native";
import { checkReadable, checkShellCommand } from "../lib/security";
import { resolvePath } from "../tools/tools";
import {
  flushPersist,
  getOrCreateChat,
  useChatStore,
  type AgentRunStatus,
} from "../store/chatStore";

/**
 * Mirrors chat lifecycle into the store so the status pill, mini-window, and
 * panel can react outside the chat hook tree.
 * Patches `agentMeta`, auto-opens the mini-window on pending approvals, opens
 * AI diff tabs for pending file mutations, and persists messages on change.
 */

type DiffOpenInput = {
  path: string;
  originalContent: string;
  proposedContent: string;
  approvalId: string;
  isNewFile: boolean;
};

type Props = {
  openAiDiffTab: (input: DiffOpenInput) => number | null;
  setAiDiffStatus: (approvalId: string, status: AiDiffStatus) => void;
};

// Memoised so unrelated App.tsx re-renders (tabs/workspaces/live-bridge) don't
// re-render this bridge. Props come from stable useCallback values in useTabs().
export const AgentRunBridge = memo(function AgentRunBridge(props: Props) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  if (!sessionId) return null;
  return <Bridge sessionId={sessionId} {...props} />;
});

type WriteFileInput = { path?: unknown; content?: unknown };

type ToolPartLike = ToolUIPart & {
  approval?: { id: string };
  input?: WriteFileInput;
};

type AnyPart = UIMessagePart<Record<string, never>, Record<string, never>>;

function Bridge({ sessionId, openAiDiffTab, setAiDiffStatus }: { sessionId: string } & Props) {
  const chat = useMemo(() => getOrCreateChat(sessionId), [sessionId]);
  const { status, messages, addToolApprovalResponse } = useChat<UIMessage>({
    chat,
  });
  const patch = useChatStore((s) => s.patchAgentMeta);
  const openMini = useChatStore((s) => s.openMini);
  const persistMessages = useChatStore((s) => s.persistMessages);
  const setApprovalResponder = useChatStore((s) => s.setApprovalResponder);

  // Expose the approval responder so the diff tab can resolve approvals.
  useEffect(() => {
    setApprovalResponder((id, approved) => addToolApprovalResponse({ id, approved }));
    return () => setApprovalResponder(null);
  }, [setApprovalResponder, addToolApprovalResponse]);

  // Auto-approve based on approvalMode:
  //   ask  - every mutating tool needs the user
  //   semi - shell auto-approves if plainly read-only; file mutations still ask
  //   yolo - everything auto-approves
  // Dedup by approvalId so re-renders don't fire twice.
  const approvalMode = usePreferencesStore((s) => s.approvalMode);
  const autoRespondedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (approvalMode === "ask") return;
    // Track which approval IDs are still in `approval-requested` this pass so
    // entries whose part has transitioned (responded / output-*) can be pruned
    // from the dedup set. Without this, a long-running yolo session accrues
    // approval IDs indefinitely.
    const stillRequested = new Set<string>();
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const part of m.parts as AnyPart[]) {
        const state = (part as { state?: string }).state;
        if (state !== "approval-requested") continue;
        const type = (part as { type?: string }).type ?? "";
        if (!type.startsWith("tool-")) continue;
        const toolName = type.slice("tool-".length);
        const approvalId = (part as { approval?: { id?: string } }).approval?.id;
        if (!approvalId) continue;
        stillRequested.add(approvalId);
        if (autoRespondedRef.current.has(approvalId)) continue;
        const input = (part as ToolPartLike).input as Record<string, unknown> | undefined;
        if (shouldAutoApprove(approvalMode, toolName, input)) {
          autoRespondedRef.current.add(approvalId);
          addToolApprovalResponse({ id: approvalId, approved: true });
        }
      }
    }
    for (const id of autoRespondedRef.current) {
      if (!stillRequested.has(id)) autoRespondedRef.current.delete(id);
    }
  }, [messages, approvalMode, addToolApprovalResponse]);

  useEffect(() => {
    persistMessages(sessionId, messages);
  }, [sessionId, messages, persistMessages]);

  // Flush debounced writes on idle/error and on unmount so a closed app or
  // session switch never loses the tail.
  useEffect(() => {
    if (status !== "submitted" && status !== "streaming") {
      flushPersist(sessionId);
    }
  }, [sessionId, status]);
  useEffect(() => {
    return () => flushPersist(sessionId);
  }, [sessionId]);

  // Single-pass scan: approvalsPending and fileMutationFingerprint share one
  // message walk. Splitting them doubled the work on every streamed token.
  const messageStats = useMemo(() => {
    let approvals = 0;
    let mutationFp = "";
    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const p of m.parts as AnyPart[]) {
        const state = (p as { state?: string }).state;
        if (state === "approval-requested") approvals++;
        const t = (p as { type?: string }).type;
        if (t === "tool-write_file" || t === "tool-edit" || t === "tool-multi_edit") {
          const id = (p as { approval?: { id?: string } }).approval?.id ?? "";
          mutationFp += `${id}:${state ?? ""}|`;
        }
      }
    }
    return { approvalsPending: approvals, fileMutationFingerprint: mutationFp };
  }, [messages]);
  const { approvalsPending, fileMutationFingerprint } = messageStats;

  useEffect(() => {
    let runStatus: AgentRunStatus;
    if (approvalsPending > 0) runStatus = "awaiting-approval";
    else if (status === "submitted") runStatus = "thinking";
    else if (status === "streaming") runStatus = "streaming";
    else if (status === "error") runStatus = "error";
    else runStatus = "idle";
    patch({
      status: runStatus,
      approvalsPending,
      ...(runStatus === "idle" || runStatus === "error" ? { step: null } : {}),
      ...(runStatus === "idle" ? { error: null } : {}),
    });
  }, [status, approvalsPending, patch]);

  useEffect(() => {
    if (approvalsPending > 0) openMini();
  }, [approvalsPending, openMini]);

  // AI diff tab management. Track opened approvalIds so re-renders don't
  // double-open. Reset on session change.
  const openedRef = useRef<Set<string>>(new Set());
  const fileMutationFingerprintRef = useRef<string>("");
  useEffect(() => {
    openedRef.current = new Set();
    fileMutationFingerprintRef.current = "";
    // Prune the auto-approve dedup set on session switch.
    autoRespondedRef.current = new Set();
  }, [sessionId]);

  // fileMutationFingerprint comes from the same pass as approvalsPending (see
  // `messageStats`). Short-circuits when unchanged so text-only tokens stay cheap.
  useEffect(() => {
    type Pending = {
      approvalId: string;
      path: string;
      /** Literal content (write_file) or edits applied to the on-disk original. */
      derive: { kind: "literal"; content: string } | { kind: "edits"; edits: EditOp[] };
    };
    type StatusUpdate = { approvalId: string; status: AiDiffStatus };

    if (fileMutationFingerprint === fileMutationFingerprintRef.current) {
      return;
    }
    fileMutationFingerprintRef.current = fileMutationFingerprint;

    const pending: Pending[] = [];
    const statusUpdates: StatusUpdate[] = [];
    // Track currently-requested approval ids so `openedRef` can be pruned
    // when a part transitions past `approval-requested`. Keeps the set
    // bounded over long sessions with many file mutations.
    const stillRequested = new Set<string>();

    for (const m of messages) {
      if (m.role !== "assistant") continue;
      for (const part of m.parts as AnyPart[]) {
        const info = extractFileMutation(part);
        if (!info) continue;
        const { state, approvalId, path, derive } = info;
        if (!approvalId) continue;
        if (state === "approval-requested") {
          stillRequested.add(approvalId);
          if (!openedRef.current.has(approvalId)) {
            pending.push({ approvalId, path, derive });
          }
        } else if (state === "approval-responded") {
          // If `approved` is missing, leave it pending; the next output-* settles it.
          const approved = (part as { approval?: { approved?: boolean } }).approval?.approved;
          if (typeof approved === "boolean") {
            statusUpdates.push({
              approvalId,
              status: approved ? "approved" : "rejected",
            });
          }
        } else if (state === "output-available") {
          statusUpdates.push({ approvalId, status: "approved" });
        } else if (state === "output-error") {
          statusUpdates.push({ approvalId, status: "rejected" });
        }
      }
    }

    for (const u of statusUpdates) setAiDiffStatus(u.approvalId, u.status);
    for (const id of openedRef.current) {
      if (!stillRequested.has(id)) openedRef.current.delete(id);
    }

    if (pending.length === 0) return;

    let cancelled = false;
    void (async () => {
      const cwd = useChatStore.getState().live.getCwd();
      for (const p of pending) {
        if (cancelled) return;
        // Mark opened up-front so a re-render mid-await doesn't double-open.
        openedRef.current.add(p.approvalId);
        let abs: string;
        try {
          abs = resolvePath(p.path, cwd);
        } catch {
          abs = p.path;
        }
        const original = await readOriginal(abs);
        if (cancelled) return;
        let proposed = "";
        if (p.derive.kind === "literal") {
          proposed = p.derive.content;
        } else {
          const r = applyEditsLocally(original.content, p.derive.edits);
          if (!r.ok) {
            // Edit failed (string not found or not unique). The approval modal surfaces the error.
            continue;
          }
          proposed = r.content;
        }
        openAiDiffTab({
          path: abs,
          originalContent: original.content,
          proposedContent: proposed,
          approvalId: p.approvalId,
          isNewFile: original.isNewFile,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [messages, fileMutationFingerprint, openAiDiffTab, setAiDiffStatus]);

  return null;
}

type EditOp = { old_string: string; new_string: string; replace_all?: boolean };

type FileMutation =
  | {
      state: string;
      approvalId: string | null;
      path: string;
      derive: { kind: "literal"; content: string };
    }
  | {
      state: string;
      approvalId: string | null;
      path: string;
      derive: { kind: "edits"; edits: EditOp[] };
    };

function extractFileMutation(part: AnyPart): FileMutation | null {
  const type = (part as { type?: string }).type;
  const p = part as ToolPartLike;
  const state = (p as { state?: string }).state ?? "";
  const approvalId = p.approval?.id ?? null;

  if (type === "tool-write_file") {
    const input = (p.input ?? {}) as WriteFileInput;
    const path = typeof input.path === "string" ? input.path : "";
    const content = typeof input.content === "string" ? input.content : "";
    if (!path) return null;
    return { state, approvalId, path, derive: { kind: "literal", content } };
  }
  if (type === "tool-edit") {
    const input = (p.input ?? {}) as {
      path?: unknown;
      old_string?: unknown;
      new_string?: unknown;
      replace_all?: unknown;
    };
    const path = typeof input.path === "string" ? input.path : "";
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    if (!path) return null;
    return {
      state,
      approvalId,
      path,
      derive: {
        kind: "edits",
        edits: [
          {
            old_string: oldStr,
            new_string: newStr,
            replace_all: Boolean(input.replace_all),
          },
        ],
      },
    };
  }
  if (type === "tool-multi_edit") {
    const input = (p.input ?? {}) as { path?: unknown; edits?: unknown };
    const path = typeof input.path === "string" ? input.path : "";
    if (!path || !Array.isArray(input.edits)) return null;
    const edits: EditOp[] = (input.edits as Record<string, unknown>[]).flatMap((e) => {
      const old_string = typeof e.old_string === "string" ? e.old_string : "";
      if (old_string.length === 0) return [];
      return [
        {
          old_string,
          new_string: typeof e.new_string === "string" ? e.new_string : "",
          replace_all: Boolean(e.replace_all),
        },
      ];
    });
    if (edits.length === 0) return null;
    return { state, approvalId, path, derive: { kind: "edits", edits } };
  }
  return null;
}

function applyEditsLocally(
  original: string,
  edits: EditOp[],
): { ok: true; content: string } | { ok: false } {
  let content = original;
  // Mirror `applyEditsLocked` (ai/tools/edit.ts): the model emits LF-only text
  // while `native.readFile` preserves the file's CRLF, so a multi-line
  // old_string only matches after translation. Without this every multi-line
  // edit to a CRLF file (the norm on Windows) returned !ok, the caller
  // `continue`d, and the side-by-side review tab silently never opened - the
  // user approved the write having seen no diff.
  const crlf = original.includes("\r\n");
  const norm = (s: string) => (crlf ? s.replace(/\r?\n/g, "\r\n") : s);
  for (const e of edits) {
    if (e.old_string === e.new_string || e.old_string.length === 0) return { ok: false };
    const oldS = norm(e.old_string);
    const newS = norm(e.new_string);
    if (e.replace_all) {
      if (!content.includes(oldS)) return { ok: false };
      content = content.split(oldS).join(newS);
    } else {
      const first = content.indexOf(oldS);
      if (first === -1) return { ok: false };
      const second = content.indexOf(oldS, first + 1);
      if (second !== -1) return { ok: false };
      content = content.slice(0, first) + newS + content.slice(first + oldS.length);
    }
  }
  return { ok: true, content };
}

/** Read-only shell prefixes auto-approved in "semi" mode. Anything that pipes,
 *  chains, or redirects falls back to asking, and the whole command still has
 *  to clear `checkShellCommand` (see `shouldAutoApprove`).
 *
 *  `find` is deliberately NOT here: `-delete`, `-exec` and friends make it a
 *  mutation tool wearing a read-only name, and neither the metachar filter
 *  (`find . -delete` has none) nor the secret denylist would stop it. The
 *  auto-approved `glob` / `grep` tools already cover the read-only use. */
const READ_ONLY_BASH_PREFIXES = [
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "whoami",
  "which",
  "where",
  "echo",
  "du",
  "df",
  "stat",
  "file",
  "tree",
  "git status",
  "git log",
  "git diff",
  "git show",
  "git branch",
  "git remote",
  "git config --get",
  "npm test",
  "npm run test",
  "pnpm test",
  "yarn test",
  "cargo test",
  "cargo check",
  "npm ls",
  "pnpm ls",
  "node -v",
  "node --version",
  "rustc --version",
  "python --version",
];

function isReadOnlyBashCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;
  // Disallow chaining/redirection/substitution; these can hide side effects.
  if (/[;&|><`$()]/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  return READ_ONLY_BASH_PREFIXES.some((p) => lower === p || lower.startsWith(`${p} `));
}

function shouldAutoApprove(
  mode: "semi" | "yolo",
  toolName: string,
  input: Record<string, unknown> | undefined,
): boolean {
  if (mode === "yolo") return true;
  // mode === "semi"
  if (toolName === "bash_run") {
    const cmd = typeof input?.command === "string" ? input.command : "";
    if (!isReadOnlyBashCommand(cmd)) return false;
    // A prefix match alone said nothing about the ARGUMENT, so `cat` and
    // `head` auto-ran on `~/.ssh/id_rsa` or `.env` with the secret denylist
    // never consulted. Auto-approving is exactly the no-approver situation
    // `unattended` exists for, so run that same pass: the secret-basename /
    // protected-directory check on every path token, plus the destructive
    // -command heuristics. Failing it only downgrades to asking, so the user
    // can still approve a deliberate `cat .env` from the card.
    return checkShellCommand(cmd, { unattended: true }).ok;
  }
  // File mutations and bash_background still need explicit approval in semi.
  return false;
}

async function readOriginal(abs: string): Promise<{ content: string; isNewFile: boolean }> {
  // Mirror the fs guard so sensitive paths show an empty "before" instead of erroring.
  const safety = checkReadable(abs);
  if (!safety.ok) return { content: "", isNewFile: false };
  try {
    const r = await native.readFile(abs);
    if (r.kind === "text") return { content: r.content, isNewFile: false };
    // Binary or oversized. Show proposed content as a "new" view; user can still cancel.
    return { content: "", isNewFile: false };
  } catch (e) {
    const msg = String(e).toLowerCase();
    const notFound =
      msg.includes("no such file") || msg.includes("not found") || msg.includes("os error 2");
    return { content: "", isNewFile: notFound };
  }
}
