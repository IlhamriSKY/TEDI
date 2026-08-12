import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { invalidBranchName } from "../api";
import type { CreatePrInput } from "../gh";
import type { GitBranch } from "../types";
import { BranchCombobox, Field } from "./FormControls";

type CreateProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Branch the PR is opened FROM. Empty on a detached HEAD, which disables it. */
  head: string;
  /** Pre-selected target: the layer below inside a stack, else the trunk. */
  defaultBase: string;
  loadBranches: () => Promise<GitBranch[]>;
  onCreate: (input: CreatePrInput) => void;
};

/**
 * Open one pull request. The base picker is the whole stacked-PR story for a
 * repository not using `gh stack`: targeting another feature branch instead of
 * the trunk is what puts the PR in a stack, because GitHub derives the stack
 * from that chain.
 */
export function CreatePrDialog({
  open,
  onOpenChange,
  head,
  defaultBase,
  loadBranches,
  onCreate,
}: CreateProps) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState(defaultBase);
  const [draft, setDraft] = useState(false);
  const [branches, setBranches] = useState<GitBranch[]>([]);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setBase(defaultBase);
    setDraft(false);
    let live = true;
    void loadBranches().then(
      (list) => {
        if (live) setBranches(list);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, defaultBase, loadBranches]);

  /** Every branch that can be a target, once. A remote-only branch is offered
   *  under its short name, which is what `--base` takes. `head` is never in
   *  the list: a branch cannot be merged into itself. */
  const bases = useMemo(() => {
    const seen = new Set<string>();
    const out: GitBranch[] = [];
    // `--base` takes a plain branch name, so a remote-only branch is offered
    // under its short name and de-duplicated against the local list.
    for (const b of branches) {
      const name = b.remote ? b.name.replace(/^[^/]+\//, "") : b.name;
      if (!name || name === head || seen.has(name)) continue;
      seen.add(name);
      out.push({ ...b, name, remote: false, upstream: null });
    }
    if (defaultBase !== head && !seen.has(defaultBase)) {
      out.unshift({ name: defaultBase, current: false, remote: false, upstream: null });
    }
    return out;
  }, [branches, defaultBase, head]);

  // The branch list arrives after the dialog opens, so the shown value is
  // derived rather than trusted: a base that is not on offer would otherwise
  // sit in the field and fail at `gh pr create`.
  const value = bases.some((b) => b.name === base) ? base : (bases[0]?.name ?? "");
  const ready = title.trim().length > 0 && value.length > 0 && head.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New pull request</DialogTitle>
          <DialogDescription>
            Merges {head || "HEAD"} into {value || "…"}. Pick another feature branch as the base to
            stack this pull request on top of it.
          </DialogDescription>
        </DialogHeader>
        <Field label="Title">
          <Input
            autoFocus
            placeholder="Add the API layer"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Description (optional)">
          <Textarea
            placeholder="What changed, and why"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="min-h-24 text-sm"
          />
        </Field>
        <Field label="Base branch">
          <BranchCombobox branches={bases} value={value} onChange={setBase} exclude={head} />
        </Field>
        {/* `htmlFor` rather than wrapping: Radix renders the Switch as a
            button, which a wrapping <label> does not associate with. */}
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="pr-draft" className="text-[12px]">
            Create as a draft
          </label>
          <Switch id="pr-draft" checked={draft} onCheckedChange={setDraft} />
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!ready}
            onClick={() => onCreate({ base: value, head, title: title.trim(), body, draft })}
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type StackProps = {
  /** null keeps the dialog closed; the mode picks which gh verb runs. */
  mode: "init" | "add" | null;
  onOpenChange: (open: boolean) => void;
  trunk: string;
  /** Branch a new layer would sit on. Null on a detached HEAD. */
  top: string | null;
  onSubmit: (name: string) => void;
};

/** Name the branch for a new stack, or for a new layer on top of one. */
export function StackBranchDialog({ mode, onOpenChange, trunk, top, onSubmit }: StackProps) {
  const [name, setName] = useState("");
  useEffect(() => {
    if (mode) setName("");
  }, [mode]);

  const bad = name.trim() ? invalidBranchName(name) : null;
  const submit = () => {
    if (!name.trim() || bad) return;
    onSubmit(name.trim());
  };

  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add a branch on top" : "Start a stack"}</DialogTitle>
          <DialogDescription>
            {mode === "add"
              ? `Creates a branch on top of ${top ?? "the current layer"} and checks it out. Its pull request will target ${top ?? "the layer below"}.`
              : `Creates a branch based on ${trunk} and tracks it as the bottom of a new stack. An existing branch of this name is adopted instead.`}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder="branch-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        {bad ? <p className="text-destructive text-[11px]">{bad}</p> : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!name.trim() || !!bad} onClick={submit}>
            {mode === "add" ? "Add" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
