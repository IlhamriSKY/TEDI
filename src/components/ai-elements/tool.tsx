"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  CheckListIcon,
  Edit02Icon,
  EyeIcon,
  File01Icon,
  FileEditIcon,
  FilePlusIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  GlobalSearchIcon,
  RobotIcon,
  SparklesIcon,
  TerminalIcon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement, memo, useState } from "react";

export type ToolPart = ToolUIPart | DynamicToolUIPart;

const TOOL_META: Record<string, { label: string; icon: typeof File01Icon }> = {
  read_file: { label: "Read", icon: File01Icon },
  list_directory: { label: "List", icon: FolderOpenIcon },
  write_file: { label: "Write", icon: FilePlusIcon },
  create_directory: { label: "Create dir", icon: FolderAddIcon },
  edit: { label: "Edit", icon: FileEditIcon },
  multi_edit: { label: "Edit", icon: Edit02Icon },
  bash_run: { label: "Run", icon: TerminalIcon },
  bash_background: { label: "Spawn", icon: TerminalIcon },
  bash_logs: { label: "Logs", icon: TerminalIcon },
  bash_list: { label: "Jobs", icon: TerminalIcon },
  bash_kill: { label: "Kill", icon: TerminalIcon },
  grep: { label: "Search", icon: GlobalSearchIcon },
  glob: { label: "Glob", icon: Folder01Icon },
  suggest_command: { label: "Suggest", icon: SparklesIcon },
  open_preview: { label: "Preview", icon: EyeIcon },
  run_subagent: { label: "Subagent", icon: RobotIcon },
  todo_write: { label: "Todos", icon: CheckListIcon },
};

// Small rounded status indicator left of the tool icon: green on success,
// red on error, orange on deny.
const STATUS_DOT: Record<ToolPart["state"], string> = {
  "approval-requested": "bg-amber-500/80 border border-amber-500",
  "approval-responded": "bg-sky-500/80 border border-sky-500",
  "input-streaming": "bg-muted-foreground/30 border border-muted-foreground/40",
  "input-available": "bg-amber-500/80 border border-amber-500",
  "output-available": "bg-emerald-500/80 border border-emerald-500",
  "output-denied": "bg-orange-500/80 border border-orange-500",
  "output-error": "bg-destructive/80 border border-destructive",
};

const STATUS_LABEL: Record<ToolPart["state"], string> = {
  "approval-requested": "awaiting approval",
  "approval-responded": "responded",
  "input-streaming": "preparing",
  "input-available": "running",
  "output-available": "done",
  "output-denied": "denied",
  "output-error": "error",
};

function deriveSummary(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : null);

  switch (toolName) {
    case "read_file":
    case "write_file":
    case "edit":
    case "multi_edit":
    case "create_directory":
    case "list_directory":
      return str("path");
    case "bash_run":
    case "bash_background":
      return str("command");
    case "bash_logs":
    case "bash_kill":
      return str("id");
    case "grep":
      return str("pattern") ?? str("query");
    case "glob":
      return str("pattern");
    case "suggest_command":
      return str("intent") ?? str("description");
    case "open_preview":
      return str("path") ?? str("url");
    case "run_subagent": {
      const desc = str("description");
      const type = str("type");
      if (desc && type) return `${type} · ${desc}`;
      return desc ?? type;
    }
    case "todo_write": {
      const items = Array.isArray(i.todos) ? i.todos : null;
      return items ? `${items.length} item${items.length === 1 ? "" : "s"}` : null;
    }
    default:
      return null;
  }
}

export type ToolProps = ComponentProps<typeof Collapsible> & {
  toolName: string;
  state: ToolPart["state"];
  input?: unknown;
  output?: unknown;
  errorText?: string;
};

// Tools whose `input` carries large or streaming content (file bodies, subagent
// prompts, todo lists). Hides the raw input body; file changes show in the diff
// tab, todos in their own strip, subagent prompts via header summary. Output
// still renders via custom renderers in `renderToolOutput`.
const HEAVY_INPUT_TOOLS = new Set([
  "write_file",
  "edit",
  "multi_edit",
  "run_subagent",
  "todo_write",
]);

const ToolImpl = ({
  className,
  toolName,
  state,
  input,
  output,
  errorText,
  defaultOpen,
  ...props
}: ToolProps) => {
  const meta = TOOL_META[toolName];
  const Icon = meta?.icon ?? ToolsIcon;
  const label = meta?.label ?? toolName;
  const summary = deriveSummary(toolName, input);
  const isError = state === "output-error";
  // Open by default on error or when a subagent summary is present.
  const hasSubagentSummary =
    toolName === "run_subagent" &&
    output !== undefined &&
    output !== null &&
    typeof (output as { summary?: unknown }).summary === "string";
  const open = defaultOpen ?? (isError || hasSubagentSummary);
  const heavyInput = HEAVY_INPUT_TOOLS.has(toolName);
  // Hide streamed input body for heavy tools; output always shows since it's
  // the final result, not per-token streaming.
  const showInputBody = !heavyInput && Boolean(input);
  const showOutputBody = output !== undefined;
  const hasDetails = showInputBody || showOutputBody || Boolean(errorText);

  return (
    <Collapsible
      defaultOpen={open}
      className={cn("group/tool not-prose w-full", className)}
      {...props}
    >
      <CollapsibleTrigger
        disabled={!hasDetails}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
          "text-[12px] transition-colors",
          "hover:bg-muted/60 cursor-pointer",
          "disabled:cursor-default disabled:hover:bg-transparent",
          "focus-visible:ring-ring focus-visible:ring-1 focus-visible:outline-none",
        )}
      >
        <span
          className={cn("size-2 shrink-0 rounded-xs transition-colors", STATUS_DOT[state])}
          aria-label={STATUS_LABEL[state]}
        />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="text-muted-foreground shrink-0"
        />
        <span className="text-foreground shrink-0 font-medium">{label}</span>
        {summary ? (
          <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]">
            {summary}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {isError && (
          <span className="text-destructive shrink-0 text-[10px] font-medium">failed</span>
        )}
      </CollapsibleTrigger>

      {hasDetails && (
        <CollapsibleContent
          className={cn(
            "overflow-hidden",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
          )}
        >
          <div className="border-border/60 mt-1 ml-3 space-y-2 border-l pb-1 pl-3">
            {showInputBody ? <ToolInput toolName={toolName} input={input} /> : null}
            {showOutputBody || errorText ? (
              <ToolOutput
                toolName={toolName}
                output={showOutputBody ? output : undefined}
                errorText={errorText}
              />
            ) : null}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
};

// For heavy tools, re-render only on state transitions or summary changes,
// not on every input-content token. Compare derived summary instead of input ref.
export const Tool = memo(ToolImpl, (a, b) => {
  if (a.toolName !== b.toolName || a.state !== b.state) return false;
  if (a.errorText !== b.errorText) return false;
  if (a.output !== b.output) return false;
  if (a.className !== b.className) return false;
  if (HEAVY_INPUT_TOOLS.has(a.toolName)) {
    return deriveSummary(a.toolName, a.input) === deriveSummary(b.toolName, b.input);
  }
  return a.input === b.input;
});

function ToolInput({ toolName, input }: { toolName: string; input: unknown }) {
  if (input == null) return null;
  const preview = renderInputPreview(toolName, input);
  if (preview) {
    return (
      <div className="space-y-1">
        <div className="text-muted-foreground text-[10px] font-medium">Input</div>
        {preview}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-[10px] font-medium">Input</div>
      <CodeBlockMini
        code={typeof input === "string" ? input : JSON.stringify(input, null, 2)}
        language="json"
      />
    </div>
  );
}

function renderInputPreview(toolName: string, input: unknown): ReactNode | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : null);

  if (toolName === "bash_run" || toolName === "bash_background") {
    const cmd = str("command");
    const cwd = str("cwd");
    if (!cmd) return null;
    return (
      <div className="space-y-1">
        {cwd ? <div className="text-muted-foreground font-mono text-[10px]">{cwd}</div> : null}
        <pre className="bg-muted/40 overflow-auto rounded p-2 font-mono text-[11px] leading-relaxed">
          {cmd}
        </pre>
      </div>
    );
  }
  if (
    toolName === "read_file" ||
    toolName === "list_directory" ||
    toolName === "create_directory" ||
    toolName === "open_preview"
  ) {
    const path = str("path") ?? str("url");
    if (!path) return null;
    return <div className="text-muted-foreground font-mono text-[11px]">{path}</div>;
  }
  if (toolName === "grep") {
    const pat = str("pattern") ?? str("query");
    const path = str("path") ?? str("root");
    if (!pat) return null;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-foreground">{pat}</div>
        {path ? <div className="text-muted-foreground">{path}</div> : null}
      </div>
    );
  }
  return null;
}

function ToolOutput({
  toolName,
  output,
  errorText,
}: {
  toolName: string;
  output: unknown;
  errorText?: string;
}) {
  if (errorText) {
    return (
      <div className="space-y-1">
        <div className="text-destructive text-[10px] font-medium">Error</div>
        <div className="bg-destructive/10 text-destructive rounded px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
          {errorText}
        </div>
      </div>
    );
  }
  if (output === undefined || output === null) return null;

  const custom = renderToolOutput(toolName, output);
  if (custom) return custom;

  let body: ReactNode;
  if (typeof output === "string") {
    body = <CodeBlockMini code={output} language="text" />;
  } else if (typeof output === "object" && !isValidElement(output)) {
    body = <CodeBlockMini code={JSON.stringify(output, null, 2)} language="json" />;
  } else {
    body = <div className="text-[12px]">{output as ReactNode}</div>;
  }

  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-[10px] font-medium">Output</div>
      {body}
    </div>
  );
}

function renderToolOutput(toolName: string, output: unknown): ReactNode | null {
  if (!output || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;

  if (toolName === "read_file") {
    const path = typeof o.path === "string" ? o.path : "";
    const size = typeof o.size === "number" ? o.size : null;
    const content = typeof o.content === "string" ? o.content : "";
    const lines = content ? content.split("\n").length : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">read</span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {lines != null ? (
          <span className="text-muted-foreground">
            ({lines} line{lines === 1 ? "" : "s"}
            {size != null ? `, ${formatBytes(size)}` : ""})
          </span>
        ) : null}
      </div>
    );
  }

  if (toolName === "list_directory") {
    const entries = Array.isArray(o.entries)
      ? (o.entries as Array<{ name: string; kind: string }>)
      : [];
    if (entries.length === 0) {
      return <div className="text-muted-foreground text-[11px] italic">empty</div>;
    }
    const dirs = entries.filter((e) => e.kind === "directory" || e.kind === "dir");
    const files = entries.filter((e) => !(e.kind === "directory" || e.kind === "dir"));
    return (
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono text-[11px]">
        {dirs.map((e) => (
          <div key={`d-${e.name}`} className="flex items-center gap-1.5 truncate">
            <HugeiconsIcon
              icon={FolderOpenIcon}
              size={11}
              strokeWidth={1.75}
              className="text-muted-foreground shrink-0"
            />
            <span className="text-foreground truncate">{e.name}/</span>
          </div>
        ))}
        {files.map((e) => (
          <div key={`f-${e.name}`} className="flex items-center gap-1.5 truncate">
            <HugeiconsIcon
              icon={File01Icon}
              size={11}
              strokeWidth={1.75}
              className="text-muted-foreground shrink-0"
            />
            <span className="text-muted-foreground truncate">{e.name}</span>
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "bash_run") {
    return <BashRunOutput data={o} />;
  }

  if (toolName === "grep") {
    const hits = Array.isArray(o.hits)
      ? (o.hits as Array<{
          rel?: string;
          path?: string;
          line: number;
          text: string;
        }>)
      : [];
    const pattern = typeof o.pattern === "string" ? o.pattern : null;
    const truncated = Boolean(o.truncated);
    const filesScanned = typeof o.files_scanned === "number" ? o.files_scanned : null;

    if (hits.length === 0) {
      return (
        <div className="text-muted-foreground text-[11px] italic">
          no matches
          {filesScanned != null ? ` · ${filesScanned} files scanned` : ""}
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <div className="bg-muted/30 max-h-72 overflow-auto rounded font-mono text-[11px]">
          {hits.slice(0, 200).map((h, idx) => (
            <div
              key={`${h.rel ?? h.path}-${h.line}-${idx}`}
              className="border-border/30 hover:bg-muted/60 flex gap-2 border-b px-2 py-1 last:border-b-0"
            >
              <span className="text-muted-foreground shrink-0">
                {h.rel ?? h.path}:{h.line}
              </span>
              <span className="text-foreground min-w-0 flex-1 truncate">
                {pattern ? highlightMatch(h.text, pattern) : h.text}
              </span>
            </div>
          ))}
        </div>
        <div className="text-muted-foreground flex items-center justify-between text-[10px]">
          <span>
            {hits.length} hit{hits.length === 1 ? "" : "s"}
            {filesScanned != null ? ` · ${filesScanned} files` : ""}
          </span>
          {truncated ? (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-700 dark:text-amber-400">
              truncated
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (toolName === "glob") {
    const matches = Array.isArray(o.matches)
      ? (o.matches as string[])
      : Array.isArray(o.paths)
        ? (o.paths as string[])
        : [];
    if (matches.length === 0) {
      return <div className="text-muted-foreground text-[11px] italic">no matches</div>;
    }
    return (
      <div className="bg-muted/30 max-h-60 overflow-auto rounded px-2 py-1 font-mono text-[11px]">
        {matches.slice(0, 300).map((p) => (
          <div key={p} className="text-muted-foreground truncate">
            {p}
          </div>
        ))}
      </div>
    );
  }

  if (toolName === "edit" || toolName === "multi_edit") {
    const ok = o.ok === true || typeof o.replacements === "number";
    if (ok) {
      const reps = typeof o.replacements === "number" ? o.replacements : null;
      const path = typeof o.path === "string" ? o.path : "";
      return (
        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">✓</span>
          {reps != null ? (
            <span className="text-foreground">
              {reps} replacement{reps === 1 ? "" : "s"}
            </span>
          ) : null}
          {path ? <span className="text-muted-foreground">· {path}</span> : null}
        </div>
      );
    }
  }

  if (toolName === "write_file" || toolName === "create_directory") {
    const path = typeof o.path === "string" ? o.path : "";
    const bytes = typeof o.bytesWritten === "number" ? o.bytesWritten : null;
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-emerald-600 dark:text-emerald-400">✓</span>
        <span className="text-foreground">
          {toolName === "create_directory" ? "created" : "wrote"}
        </span>
        {path ? <span className="text-muted-foreground">· {path}</span> : null}
        {bytes != null ? (
          <span className="text-muted-foreground">({formatBytes(bytes)})</span>
        ) : null}
      </div>
    );
  }

  if (toolName === "run_subagent") {
    if (typeof o.error === "string") {
      return (
        <div className="bg-destructive/10 text-destructive rounded px-2 py-1.5 font-mono text-[11px]">
          {o.error}
        </div>
      );
    }
    const summary = typeof o.summary === "string" ? o.summary : "";
    const type = typeof o.type === "string" ? o.type : null;
    const description = typeof o.description === "string" ? o.description : null;
    const stepCount = typeof o.stepCount === "number" ? o.stepCount : null;
    const durationMs = typeof o.durationMs === "number" ? o.durationMs : null;
    return (
      <div className="space-y-2">
        {(type || description) && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {type ? (
              <span className="bg-foreground/10 text-foreground rounded px-1.5 py-0.5 font-mono font-medium">
                {type}
              </span>
            ) : null}
            {description ? <span className="text-muted-foreground">{description}</span> : null}
          </div>
        )}
        {summary ? (
          <div className="border-border/60 bg-muted/30 rounded border p-2 text-[12px] leading-relaxed whitespace-pre-wrap">
            {summary}
          </div>
        ) : (
          <div className="text-muted-foreground text-[11px] italic">(no output)</div>
        )}
        {(stepCount != null || durationMs != null) && (
          <div className="text-muted-foreground flex items-center gap-2 text-[10px]">
            {stepCount != null ? (
              <span>
                {stepCount} step{stepCount === 1 ? "" : "s"}
              </span>
            ) : null}
            {stepCount != null && durationMs != null ? <span aria-hidden>·</span> : null}
            {durationMs != null ? <span>{formatDuration(durationMs)}</span> : null}
          </div>
        )}
      </div>
    );
  }

  if (toolName === "bash_background") {
    const handle = typeof o.handle === "string" ? o.handle : null;
    const cmd = typeof o.command === "string" ? o.command : "";
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
          {handle ? <span className="text-foreground">{handle}</span> : null}
          <span className="text-muted-foreground">running</span>
        </div>
        {cmd ? <div className="text-muted-foreground truncate">{cmd}</div> : null}
      </div>
    );
  }

  return null;
}

function BashRunOutput({ data }: { data: Record<string, unknown> }) {
  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const exit = typeof data.exit_code === "number" ? data.exit_code : null;
  const cwdAfter = typeof data.cwd_after === "string" ? data.cwd_after : null;
  const truncated = Boolean(data.truncated);
  const timedOut = Boolean(data.timed_out);

  const hasStdout = stdout.length > 0;
  const hasStderr = stderr.length > 0;
  const initial = hasStdout ? "stdout" : hasStderr ? "stderr" : "stdout";
  const [tab, setTab] = useState<"stdout" | "stderr">(initial);

  const tabs: Array<{
    key: "stdout" | "stderr";
    label: string;
    count: number;
  }> = [
    { key: "stdout", label: "stdout", count: stdout.length },
    { key: "stderr", label: "stderr", count: stderr.length },
  ];

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              "cursor-pointer rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
              tab === t.key
                ? "bg-foreground/10 text-foreground"
                : "text-muted-foreground hover:text-foreground",
              t.count === 0 && "cursor-default opacity-40",
            )}
            disabled={t.count === 0}
          >
            {t.label}
            {t.count > 0 ? <span className="text-muted-foreground ml-1">{t.count}</span> : null}
          </button>
        ))}
        <span className="flex-1" />
        {exit != null ? (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              exit === 0
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                : "bg-destructive/15 text-destructive",
            )}
          >
            exit {exit}
          </span>
        ) : null}
        {timedOut ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            timed out
          </span>
        ) : null}
        {truncated ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            truncated
          </span>
        ) : null}
      </div>
      <pre className="bg-muted/40 max-h-72 overflow-auto rounded p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
        {tab === "stdout" ? stdout || " " : stderr || " "}
      </pre>
      {cwdAfter ? (
        <div className="text-muted-foreground font-mono text-[10px]">cwd → {cwdAfter}</div>
      ) : null}
    </div>
  );
}

function highlightMatch(text: string, pattern: string): ReactNode {
  if (!pattern) return text;
  let re: RegExp;
  try {
    re = new RegExp(`(${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  } catch {
    return text;
  }
  const parts = text.split(re);
  return parts.map((p, i) =>
    i % 2 === 1 ? (
      <mark key={i} className="text-foreground rounded bg-amber-500/30 px-0.5">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function CodeBlockMini({ code }: { code: string; language: string }) {
  // Debug-grade detail: JSON arrives pre-formatted and file content shows in
  // the editor diff tab. Skip syntax highlighting.
  return (
    <pre className="bg-muted/40 text-foreground max-h-60 overflow-auto rounded p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
      {code}
    </pre>
  );
}

// Compatibility re-exports. The previous API exposed these subcomponents;
// the new compact <Tool /> takes everything via props. No-ops to avoid
// breaking accidental imports.
export const ToolHeader = () => null;
export const ToolContent = ({ children }: { children?: ReactNode }) => <>{children}</>;
export { ToolInput, ToolOutput };
