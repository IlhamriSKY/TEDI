"use client";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  AddSquareIcon,
  Calendar01Icon,
  CancelSquareIcon,
  CheckListIcon,
  Copy01Icon,
  Cursor01Icon,
  CursorInWindowIcon,
  Delete02Icon,
  Edit02Icon,
  EyeIcon,
  File01Icon,
  FileEditIcon,
  FilePlusIcon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  GlobalSearchIcon,
  InternetIcon,
  KeyboardIcon,
  Layers01Icon,
  ListViewIcon,
  MouseLeftClick01Icon,
  Move01Icon,
  Navigation03Icon,
  PlaySquareIcon,
  RobotIcon,
  RotateClockwiseIcon,
  ScrollVerticalIcon,
  SearchReplaceIcon,
  SentIcon,
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
  // Filesystem
  read_file: { label: "Read", icon: File01Icon },
  list_directory: { label: "List", icon: FolderOpenIcon },
  write_file: { label: "Write", icon: FilePlusIcon },
  create_directory: { label: "Create dir", icon: FolderAddIcon },
  move_file: { label: "Move", icon: Move01Icon },
  copy_file: { label: "Copy", icon: Copy01Icon },
  delete_file: { label: "Delete", icon: Delete02Icon },
  edit: { label: "Edit", icon: FileEditIcon },
  multi_edit: { label: "Edit", icon: Edit02Icon },
  // Search
  grep: { label: "Search", icon: GlobalSearchIcon },
  glob: { label: "Glob", icon: Folder01Icon },
  replace_in_files: { label: "Replace", icon: SearchReplaceIcon },
  // Shell
  bash_run: { label: "Run", icon: TerminalIcon },
  bash_background: { label: "Spawn", icon: TerminalIcon },
  bash_logs: { label: "Logs", icon: TerminalIcon },
  bash_list: { label: "Jobs", icon: TerminalIcon },
  bash_kill: { label: "Kill", icon: TerminalIcon },
  // Data / web
  fetch: { label: "Fetch", icon: InternetIcon },
  open_preview: { label: "Preview", icon: EyeIcon },
  control_browser: { label: "Browser", icon: Navigation03Icon },
  navigate_and_read: { label: "Navigate", icon: Navigation03Icon },
  read_browser: { label: "Read page", icon: EyeIcon },
  browser_type: { label: "Type", icon: KeyboardIcon },
  browser_click: { label: "Click", icon: MouseLeftClick01Icon },
  browser_click_at: { label: "Click at", icon: Cursor01Icon },
  browser_hover: { label: "Hover", icon: CursorInWindowIcon },
  browser_press_key: { label: "Press key", icon: KeyboardIcon },
  browser_scroll: { label: "Scroll", icon: ScrollVerticalIcon },
  browser_screenshot: { label: "Screenshot", icon: EyeIcon },
  // Terminal control
  suggest_command: { label: "Suggest", icon: SparklesIcon },
  open_terminal: { label: "Open terminal", icon: AddSquareIcon },
  close_terminal: { label: "Close terminal", icon: CancelSquareIcon },
  consolidate_terminals: { label: "Consolidate", icon: Layers01Icon },
  group_tabs: { label: "Group tabs", icon: Layers01Icon },
  rotate_pane: { label: "Rotate pane", icon: RotateClockwiseIcon },
  run_in_terminal: { label: "Run in terminal", icon: PlaySquareIcon },
  run_in_terminal_by_id: { label: "Run in terminal", icon: PlaySquareIcon },
  send_to_terminal: { label: "Send to terminal", icon: SentIcon },
  list_terminals: { label: "List terminals", icon: ListViewIcon },
  // Scheduling
  schedule_command: { label: "Schedule", icon: Calendar01Icon },
  list_schedules: { label: "Schedules", icon: Calendar01Icon },
  cancel_schedule: { label: "Cancel schedule", icon: Calendar01Icon },
  // Delegation / planning
  run_subagent: { label: "Subagent", icon: RobotIcon },
  todo_write: { label: "Todos", icon: CheckListIcon },
};

// Icon color per tool state: the color indicator lives on the icon itself,
// replacing the old separate status dot for a more compact look.
const STATUS_ICON_COLOR: Record<ToolPart["state"], string> = {
  "approval-requested": "text-icon-working",
  "approval-responded": "text-info",
  "input-streaming": "text-muted-foreground/50",
  "input-available": "text-icon-working",
  "output-available": "text-diff-added",
  "output-denied": "text-destructive",
  "output-error": "text-destructive",
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
    case "delete_file":
      return str("path");
    case "move_file":
    case "copy_file": {
      const from = str("from");
      const to = str("to");
      if (from && to) return `${baseName(from)} → ${baseName(to)}`;
      return to ?? from;
    }
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
    case "replace_in_files": {
      const pat = str("pattern");
      if (pat == null) return null;
      const rep = str("replacement");
      return rep == null ? pat : `${pat} → ${rep}`;
    }
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
  const label = meta?.label ?? toTitleCase(toolName);
  const summary = deriveSummary(toolName, input);
  const isError = state === "output-error";
  // Open by default on error or when a subagent summary is present.
  const hasSubagentSummary =
    toolName === "run_subagent" &&
    output !== undefined &&
    output !== null &&
    typeof (output as { summary?: unknown }).summary === "string";
  const hasScreenshot =
    toolName === "browser_screenshot" &&
    output !== null &&
    typeof output === "object" &&
    typeof (output as { image?: unknown }).image === "string";
  const open = defaultOpen ?? (isError || hasSubagentSummary || hasScreenshot);
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
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className={cn("shrink-0 transition-colors", STATUS_ICON_COLOR[state])}
          aria-label={STATUS_LABEL[state]}
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
  if (toolName === "delete_file") {
    const path = str("path");
    if (!path) return null;
    return <div className="text-destructive font-mono text-[11px]">{path}</div>;
  }
  if (toolName === "move_file" || toolName === "copy_file") {
    const from = str("from");
    const to = str("to");
    if (!from && !to) return null;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground">{from}</div>
        <div className="text-foreground">→ {to}</div>
      </div>
    );
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
  if (toolName === "replace_in_files") {
    const pat = str("pattern");
    if (!pat) return null;
    const rep = str("replacement");
    const root = str("root");
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-foreground">{pat}</div>
        <div className="text-muted-foreground">→ {rep ?? ""}</div>
        {root ? <div className="text-muted-foreground/80 text-[10px]">root: {root}</div> : null}
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
    const size = typeof o.size === "number" ? o.size : null;
    const content = typeof o.content === "string" ? o.content : "";
    const lines = content ? content.split("\n").length : null;
    // The path already shows in the header summary and the Input block, so the
    // output stays compact: just the read confirmation plus line/byte stats.
    const stats: string[] = [];
    if (lines != null) stats.push(`${lines} line${lines === 1 ? "" : "s"}`);
    if (size != null) stats.push(formatBytes(size));
    return (
      <div className="flex items-center gap-1.5 font-mono text-[11px]">
        <span className="text-diff-added">✓</span>
        <span className="text-foreground">read</span>
        {stats.length > 0 ? (
          <span className="text-muted-foreground">· {stats.join(" · ")}</span>
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
            <span className="bg-icon-working/15 text-icon-working rounded px-1.5 py-0.5">
              truncated
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (toolName === "replace_in_files") {
    const filesChanged = typeof o.files_changed === "number" ? o.files_changed : null;
    const totalReps = typeof o.total_replacements === "number" ? o.total_replacements : null;
    const edits = Array.isArray(o.edits)
      ? (o.edits as Array<{ rel?: string; path?: string; replacements: number }>)
      : [];
    const truncated = Boolean(o.truncated);
    if (filesChanged === 0) {
      return <div className="text-muted-foreground text-[11px] italic">no matches replaced</div>;
    }
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 font-mono text-[11px]">
          <span className="text-diff-added">✓</span>
          <span className="text-foreground">replaced</span>
          <span className="text-muted-foreground">
            · {totalReps} in {filesChanged} file{filesChanged === 1 ? "" : "s"}
          </span>
        </div>
        {edits.length > 0 ? (
          <div className="bg-muted/30 max-h-60 overflow-auto rounded font-mono text-[11px]">
            {edits.slice(0, 200).map((e, i) => (
              <div
                key={`${e.rel ?? e.path}-${i}`}
                className="border-border/30 flex justify-between gap-2 border-b px-2 py-0.5 last:border-b-0"
              >
                <span className="text-muted-foreground truncate">{e.rel ?? e.path}</span>
                <span className="text-diff-added shrink-0">+{e.replacements}</span>
              </div>
            ))}
          </div>
        ) : null}
        {truncated ? (
          <div className="text-icon-working text-[10px]">edit list truncated</div>
        ) : null}
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
          <span className="text-diff-added">✓</span>
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
        <span className="text-diff-added">✓</span>
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

  if (toolName === "move_file" || toolName === "copy_file") {
    const from = typeof o.from === "string" ? o.from : "";
    const to = typeof o.to === "string" ? o.to : "";
    return (
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
        <span className="text-diff-added shrink-0">✓</span>
        <span className="text-foreground shrink-0">
          {toolName === "copy_file" ? "copied" : "moved"}
        </span>
        {from && to ? (
          <span className="text-muted-foreground truncate">
            · {baseName(from)} → {baseName(to)}
          </span>
        ) : null}
      </div>
    );
  }

  if (toolName === "delete_file") {
    const path = typeof o.path === "string" ? o.path : "";
    return (
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
        <span className="text-diff-added shrink-0">✓</span>
        <span className="text-foreground shrink-0">deleted</span>
        {path ? <span className="text-muted-foreground truncate">· {path}</span> : null}
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

  if (toolName === "browser_screenshot") {
    const image = typeof o.image === "string" ? o.image : null;
    if (image) {
      return (
        <img
          src={`data:image/jpeg;base64,${image}`}
          alt="Browser pane screenshot"
          className="border-border/60 max-h-96 w-full rounded-md border object-contain"
        />
      );
    }
  }

  if (toolName === "bash_background") {
    const handle = typeof o.handle === "string" ? o.handle : null;
    const cmd = typeof o.command === "string" ? o.command : "";
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="flex items-center gap-1.5">
          <span className="bg-diff-added size-1.5 animate-pulse rounded-full" />
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
                ? "bg-diff-added/15 text-diff-added"
                : "bg-destructive/15 text-destructive",
            )}
          >
            exit {exit}
          </span>
        ) : null}
        {timedOut ? (
          <span className="bg-icon-working/15 text-icon-working rounded px-1.5 py-0.5 font-mono text-[10px]">
            timed out
          </span>
        ) : null}
        {truncated ? (
          <span className="bg-icon-working/15 text-icon-working rounded px-1.5 py-0.5 font-mono text-[10px]">
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
      <mark key={i} className="text-foreground bg-icon-working/30 rounded px-0.5">
        {p}
      </mark>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

// Last path segment of a (possibly Windows) path, used to keep move/delete
// summaries compact in the tool header.
function baseName(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  return i === -1 ? norm : norm.slice(i + 1);
}

// Fallback label for tools missing from TOOL_META: turn a raw `snake_case`
// tool name into "Title Case" so the UI never shows bare identifiers.
function toTitleCase(name: string): string {
  return name
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
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
