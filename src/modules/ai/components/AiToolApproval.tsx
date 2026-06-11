import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Cancel01Icon,
  Copy01Icon,
  Delete02Icon,
  Edit02Icon,
  EyeIcon,
  FileEditIcon,
  FilePlusIcon,
  Folder01Icon,
  FolderAddIcon,
  GlobalSearchIcon,
  Move01Icon,
  SearchReplaceIcon,
  TerminalIcon,
  Tick02Icon,
  ToolsIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ToolUIPart } from "ai";
import { memo } from "react";
import { applyShellTransformers } from "../tools/shell";

type Props = {
  part: Extract<ToolUIPart, { state: "approval-requested" }>;
  toolName: string;
  onRespond: (approved: boolean) => void;
};

const TOOL_META: Record<string, { label: string; icon: typeof FilePlusIcon }> = {
  write_file: { label: "Write file", icon: FilePlusIcon },
  edit: { label: "Edit file", icon: FileEditIcon },
  multi_edit: { label: "Edit file (batch)", icon: Edit02Icon },
  create_directory: { label: "Create directory", icon: FolderAddIcon },
  move_file: { label: "Move / rename", icon: Move01Icon },
  copy_file: { label: "Copy", icon: Copy01Icon },
  delete_file: { label: "Delete", icon: Delete02Icon },
  bash_run: { label: "Run shell command", icon: TerminalIcon },
  bash_background: { label: "Spawn background process", icon: TerminalIcon },
  replace_in_files: { label: "Replace across files", icon: SearchReplaceIcon },
  read_file: { label: "Read file (outside workspace)", icon: EyeIcon },
  list_directory: { label: "List directory (outside workspace)", icon: Folder01Icon },
  grep: { label: "Search (outside workspace)", icon: GlobalSearchIcon },
  glob: { label: "Find files (outside workspace)", icon: GlobalSearchIcon },
};

function AiToolApprovalImpl({ part, toolName, onRespond }: Props) {
  const meta = TOOL_META[toolName];
  const label = meta?.label ?? toolName;
  const Icon = meta?.icon ?? ToolsIcon;
  const input = part.input as Record<string, unknown>;

  return (
    <div className="border-border bg-card rounded-lg border shadow-sm">
      <div className="border-border/60 flex items-center gap-2 border-b px-3 py-2">
        <span className="bg-icon-working size-1.5 shrink-0 animate-pulse rounded-full" />
        <HugeiconsIcon
          icon={Icon}
          size={13}
          strokeWidth={1.75}
          className="text-muted-foreground shrink-0"
        />
        <span className="text-foreground text-[12px] font-medium">{label}</span>
        <span className="text-muted-foreground ml-auto text-[10px]">needs approval</span>
      </div>

      <div className="px-3 py-2.5">
        <PreviewBlock toolName={toolName} input={input} />
      </div>

      <div className="border-border/60 flex items-center justify-end gap-1.5 border-t px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onRespond(false)}
          className="hover:bg-destructive/10 hover:text-destructive h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={2} />
          Deny
        </Button>
        <Button
          size="sm"
          variant="default"
          onClick={() => onRespond(true)}
          className="h-7 gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
          Approve
        </Button>
      </div>
    </div>
  );
}

export const AiToolApproval = memo(AiToolApprovalImpl, (a, b) => {
  // Approval card content is fixed once approvalId is set; skip re-renders
  // on downstream tokens.
  return (
    a.toolName === b.toolName &&
    a.part.approval.id === b.part.approval.id &&
    a.onRespond === b.onRespond
  );
});

function PreviewBlock({ toolName, input }: { toolName: string; input: Record<string, unknown> }) {
  if (toolName === "bash_run" || toolName === "bash_background") {
    const cwd = typeof input.cwd === "string" ? input.cwd : null;
    const raw = String(input.command ?? "");
    // Show what actually runs: a shell transformer (e.g. an RTK-style bridge)
    // can rewrite the command, so approving the raw text alone wouldn't reflect
    // the executed command. Only surface the rewrite when it differs.
    const effective = applyShellTransformers(raw, "bash");
    return (
      <div className="space-y-1.5">
        {cwd && <div className="text-muted-foreground font-mono text-[10.5px]">{cwd}</div>}
        <pre
          className={cn(
            "bg-muted/60 max-h-40 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed",
          )}
        >
          {raw}
        </pre>
        {effective !== raw && (
          <div className="space-y-0.5">
            <div className="text-muted-foreground/80 text-[10px]">Runs as (after extensions):</div>
            <pre
              className={cn(
                "bg-muted/60 max-h-40 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed",
              )}
            >
              {effective}
            </pre>
          </div>
        )}
      </div>
    );
  }
  // Skip content preview for file mutations; streaming thrashes the UI and the
  // diff tab is where users review changes. Show path and a one-line size hint.
  if (toolName === "write_file") {
    const content = typeof input.content === "string" ? input.content : "";
    const lines = content ? content.split("\n").length : 0;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground">{String(input.path ?? "")}</div>
        <div className="text-muted-foreground/80 text-[10.5px]">
          {lines} line{lines === 1 ? "" : "s"} · review in the diff tab
        </div>
      </div>
    );
  }
  if (toolName === "edit") {
    const oldStr = typeof input.old_string === "string" ? input.old_string : "";
    const newStr = typeof input.new_string === "string" ? input.new_string : "";
    const removed = oldStr ? oldStr.split("\n").length : 0;
    const added = newStr ? newStr.split("\n").length : 0;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground">
          {String(input.path ?? "")}
          {input.replace_all ? " · replace all" : ""}
        </div>
        <div className="text-muted-foreground/80 text-[10.5px]">
          −{removed} / +{added} line{added === 1 && removed === 1 ? "" : "s"} · review in the diff
          tab
        </div>
      </div>
    );
  }
  if (toolName === "multi_edit") {
    const edits = Array.isArray(input.edits)
      ? (input.edits as Array<{ old_string?: string; new_string?: string }>)
      : [];
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground">{String(input.path ?? "")}</div>
        <div className="text-muted-foreground/80 text-[10.5px]">
          {edits.length} edit{edits.length === 1 ? "" : "s"} · review in the diff tab
        </div>
      </div>
    );
  }
  if (toolName === "create_directory") {
    return (
      <div className="text-muted-foreground font-mono text-[11px]">{String(input.path ?? "")}</div>
    );
  }
  if (toolName === "move_file" || toolName === "copy_file") {
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground break-all">{String(input.from ?? "")}</div>
        <div className="text-foreground break-all">→ {String(input.to ?? "")}</div>
      </div>
    );
  }
  if (toolName === "delete_file") {
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-destructive break-all">{String(input.path ?? "")}</div>
        <div className="text-muted-foreground/80 text-[10.5px]">
          deleted recursively · restorable via checkpoint
        </div>
      </div>
    );
  }
  if (toolName === "replace_in_files") {
    const glob = Array.isArray(input.glob) ? (input.glob as string[]).join(", ") : null;
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-foreground break-all">{String(input.pattern ?? "")}</div>
        <div className="text-muted-foreground break-all">→ {String(input.replacement ?? "")}</div>
        <div className="text-muted-foreground/80 text-[10.5px] break-all">
          root: {String(input.root ?? "(workspace)")}
          {glob ? ` · ${glob}` : ""} · writes all matches, not checkpointed
        </div>
      </div>
    );
  }
  if (toolName === "read_file" || toolName === "list_directory") {
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground break-all">{String(input.path ?? "")}</div>
        <div className="text-muted-foreground/80 text-[10.5px]">outside the workspace root</div>
      </div>
    );
  }
  if (toolName === "grep" || toolName === "glob") {
    return (
      <div className="space-y-0.5 font-mono text-[11px]">
        <div className="text-muted-foreground break-all">{String(input.pattern ?? "")}</div>
        <div className="text-muted-foreground/80 text-[10.5px] break-all">
          root: {String(input.root ?? "(default)")} · outside the workspace root
        </div>
      </div>
    );
  }
  return (
    <pre className="bg-muted/60 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}
