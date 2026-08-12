import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { invalidBranchName } from "../api";
import type { GitBranch, GitStash } from "../types";
import { BranchCombobox, Field } from "./FormControls";
import { Archive, CloudUpload, CornerUpLeft, Play, Tag, Trash2 } from "lucide-react";

/** Shared shell so every repo dialog opens at the same width and spacing. */
function Shell({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>
          {footer ?? (
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One row of a managed list (a stash, a tag) with its actions on the right. */
function ListRow({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="group/row hover:bg-muted/50 flex min-h-8 items-center gap-2 rounded-xl px-2 py-1">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px]">{label}</span>
        {sub ? (
          <span className="text-muted-foreground truncate font-mono text-[10px]">{sub}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
        {children}
      </span>
    </div>
  );
}

type StashProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rows currently in the working tree; zero means there is nothing to stash. */
  changeCount: number;
  stagedCount: number;
  load: () => Promise<GitStash[]>;
  onStash: (message: string, staged: boolean) => Promise<void>;
  onApply: (ref: string, pop: boolean) => Promise<void>;
  onDrop: (ref: string) => Promise<void>;
};

/**
 * Create and manage stashes in one place. A separate "stash" menu item and
 * "stashes" list would be two entries for one idea, and the list is where you
 * end up either way.
 */
export function StashDialog({
  open,
  onOpenChange,
  changeCount,
  stagedCount,
  load,
  onStash,
  onApply,
  onDrop,
}: StashProps) {
  const [message, setMessage] = useState("");
  const [stagedOnly, setStagedOnly] = useState(false);
  const [list, setList] = useState<GitStash[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void load().then(setList, () => setList([]));
  }, [load]);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setStagedOnly(false);
    setList(null);
    refresh();
  }, [open, refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      setMessage("");
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title="Stashes"
      description="Park work in progress without committing it, then bring it back later."
    >
      <Field label="Stash the current changes">
        <Input
          placeholder="Message (optional)"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && changeCount > 0 && !busy) {
              e.preventDefault();
              void run(() => onStash(message, stagedOnly));
            }
          }}
        />
      </Field>
      <label className="flex items-center justify-between gap-3">
        <span className="text-[12px]">
          Staged changes only
          <span className="text-muted-foreground ml-1.5">
            {stagedOnly ? `(${stagedCount})` : `(${changeCount} total, untracked included)`}
          </span>
        </span>
        <Switch checked={stagedOnly} onCheckedChange={setStagedOnly} disabled={stagedCount === 0} />
      </label>
      <Button
        size="sm"
        disabled={busy || changeCount === 0 || (stagedOnly && stagedCount === 0)}
        onClick={() => void run(() => onStash(message, stagedOnly))}
      >
        <Archive size={12} strokeWidth={2} />
        {changeCount === 0 ? "Nothing to stash" : "Stash changes"}
      </Button>

      <Field label={`Saved stashes${list ? ` (${list.length})` : ""}`}>
        {list === null ? (
          <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-[11.5px]">
            <Spinner className="size-3" /> Loading…
          </div>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-[11.5px]">No stashes yet.</p>
        ) : (
          <ScrollArea className="max-h-48">
            {list.map((s) => (
              <ListRow key={s.ref} label={s.subject} sub={s.ref}>
                <IconTooltip label="Apply and keep the stash" side="top">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    disabled={busy}
                    onClick={() => void run(() => onApply(s.ref, false))}
                    aria-label={`Apply ${s.ref}`}
                  >
                    <CornerUpLeft size={11} strokeWidth={2} />
                  </Button>
                </IconTooltip>
                <IconTooltip label="Apply and remove the stash" side="top">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    disabled={busy}
                    onClick={() => void run(() => onApply(s.ref, true))}
                    aria-label={`Pop ${s.ref}`}
                  >
                    <Play size={11} strokeWidth={2} />
                  </Button>
                </IconTooltip>
                <IconTooltip label="Delete the stash" side="top">
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(DESTRUCTIVE_ACTION, "size-6")}
                    disabled={busy}
                    onClick={() => void run(() => onDrop(s.ref))}
                    aria-label={`Drop ${s.ref}`}
                  >
                    <Trash2 size={11} strokeWidth={2} />
                  </Button>
                </IconTooltip>
              </ListRow>
            ))}
          </ScrollArea>
        )}
      </Field>
    </Shell>
  );
}

type TagProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branch: string | null;
  load: () => Promise<string[]>;
  onCreate: (name: string, message: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onPush: (name: string) => Promise<void>;
};

/** Create, delete, and push tags. Same create-plus-list shape as stashes. */
export function TagDialog({
  open,
  onOpenChange,
  branch,
  load,
  onCreate,
  onDelete,
  onPush,
}: TagProps) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [list, setList] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    void load().then(setList, () => setList([]));
  }, [load]);

  useEffect(() => {
    if (!open) return;
    setName("");
    setMessage("");
    setList(null);
    refresh();
  }, [open, refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      refresh();
    } finally {
      setBusy(false);
    }
  };

  // A tag is a ref, so the branch-name rules apply verbatim.
  const bad = name.trim() ? invalidBranchName(name) : null;
  const create = () => {
    if (!name.trim() || bad) return;
    void run(async () => {
      await onCreate(name.trim(), message);
      setName("");
      setMessage("");
    });
  };

  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title="Tags"
      description={`Names a commit for good. A new tag points at ${branch ?? "HEAD"}.`}
    >
      <Field label="New tag">
        <Input
          autoFocus
          placeholder="v1.0.0"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              create();
            }
          }}
        />
      </Field>
      {bad ? <p className="text-destructive text-[11px]">{bad}</p> : null}
      <Field label="Message (optional, makes it an annotated tag)">
        <Input
          placeholder="Release 1.0.0"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
      </Field>
      <Button size="sm" disabled={busy || !name.trim() || !!bad} onClick={create}>
        <Tag size={12} strokeWidth={2} />
        Create tag
      </Button>

      <Field label={`Existing tags${list ? ` (${list.length})` : ""}`}>
        {list === null ? (
          <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-[11.5px]">
            <Spinner className="size-3" /> Loading…
          </div>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground px-2 py-3 text-[11.5px]">No tags yet.</p>
        ) : (
          <ScrollArea className="max-h-48">
            {list.map((t) => (
              <ListRow key={t} label={t}>
                <IconTooltip label="Push this tag to origin" side="top">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    disabled={busy}
                    onClick={() => void run(() => onPush(t))}
                    aria-label={`Push tag ${t}`}
                  >
                    <CloudUpload size={11} strokeWidth={2} />
                  </Button>
                </IconTooltip>
                <IconTooltip label="Delete the local tag" side="top">
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn(DESTRUCTIVE_ACTION, "size-6")}
                    disabled={busy}
                    onClick={() => void run(() => onDelete(t))}
                    aria-label={`Delete tag ${t}`}
                  >
                    <Trash2 size={11} strokeWidth={2} />
                  </Button>
                </IconTooltip>
              </ListRow>
            ))}
          </ScrollArea>
        )}
      </Field>
    </Shell>
  );
}

type BranchOpProps = {
  /** null keeps it closed; the mode picks which git verb runs. */
  mode: "merge" | "rebase" | null;
  onOpenChange: (open: boolean) => void;
  branch: string | null;
  loadBranches: () => Promise<GitBranch[]>;
  onSubmit: (name: string) => void;
};

/** Pick the other side of a merge or a rebase. */
export function BranchOpDialog({
  mode,
  onOpenChange,
  branch,
  loadBranches,
  onSubmit,
}: BranchOpProps) {
  const [target, setTarget] = useState("");
  const [branches, setBranches] = useState<GitBranch[]>([]);

  useEffect(() => {
    if (!mode) return;
    setTarget("");
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
  }, [mode, loadBranches]);

  const merging = mode === "merge";
  return (
    <Shell
      open={mode !== null}
      onOpenChange={onOpenChange}
      title={merging ? "Merge a branch" : "Rebase onto a branch"}
      description={
        merging
          ? `Brings another branch's commits into ${branch ?? "HEAD"}, keeping both histories.`
          : `Replays ${branch ?? "HEAD"}'s commits on top of another branch, rewriting them. Local only until you push.`
      }
      footer={
        <>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={!target} onClick={() => onSubmit(target)}>
            {merging ? "Merge" : "Rebase"}
          </Button>
        </>
      }
    >
      <Field label={merging ? "Branch to merge in" : "Branch to rebase onto"}>
        <BranchCombobox
          branches={branches}
          value={target}
          onChange={setTarget}
          exclude={branch}
          placeholder="Select a branch"
        />
      </Field>
    </Shell>
  );
}

type CommitRefProps = {
  /** null keeps it closed. Carries the commit the new ref will point at. */
  prompt: { kind: "branch" | "tag"; sha: string; shortSha: string } | null;
  name: string;
  setName: (value: string) => void;
  onClose: () => void;
  onSubmit: (kind: "branch" | "tag", sha: string, shortSha: string, name: string) => void;
};

/** Name a new branch or tag that will point at a commit from the history. */
export function CommitRefDialog({ prompt, name, setName, onClose, onSubmit }: CommitRefProps) {
  const bad = name.trim() ? invalidBranchName(name) : null;
  const submit = () => {
    if (!prompt || !name.trim() || bad) return;
    onSubmit(prompt.kind, prompt.sha, prompt.shortSha, name.trim());
  };
  const branching = prompt?.kind === "branch";

  return (
    <Shell
      open={prompt !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={branching ? "Branch from this commit" : "Tag this commit"}
      description={
        branching
          ? `Creates a branch at ${prompt?.shortSha} and switches to it.`
          : `Names ${prompt?.shortSha} for good.`
      }
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!name.trim() || !!bad} onClick={submit}>
            {branching ? "Create branch" : "Create tag"}
          </Button>
        </>
      }
    >
      <Field label={branching ? "Branch name" : "Tag name"}>
        <Input
          autoFocus
          placeholder={branching ? "fix/the-thing" : "v1.0.0"}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      </Field>
      {bad ? <p className="text-destructive text-[11px]">{bad}</p> : null}
    </Shell>
  );
}

type PublishProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Folder name, the default repository name. */
  suggestedName: string;
  /** Resolves with the repo this tree already points at, or null. */
  loadExisting: () => Promise<{ nameWithOwner: string; url: string } | null>;
  onPublish: (name: string, isPrivate: boolean, description: string) => void;
  onOpenExisting: (url: string) => void;
};

/**
 * Create the GitHub repository for this working tree.
 *
 * Checks first rather than trusting the menu: a repo can already be on GitHub
 * while the current branch has no upstream, and `gh repo create` would fail
 * with a raw error where the honest answer is "it is already published".
 */
export function PublishGithubDialog({
  open,
  onOpenChange,
  suggestedName,
  loadExisting,
  onPublish,
  onOpenExisting,
}: PublishProps) {
  const [name, setName] = useState(suggestedName);
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [existing, setExisting] = useState<{ nameWithOwner: string; url: string } | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!open) return;
    setName(suggestedName);
    setDescription("");
    setIsPrivate(true);
    setChecking(true);
    let live = true;
    void loadExisting().then(
      (r) => {
        if (!live) return;
        setExisting(r);
        setChecking(false);
      },
      () => {
        if (!live) return;
        setExisting(null);
        setChecking(false);
      },
    );
    return () => {
      live = false;
    };
  }, [open, suggestedName, loadExisting]);

  // A repository name is not a ref, but it is close enough that the ref rules
  // catch every character GitHub also refuses, and nothing it allows.
  const bad = name.trim() ? invalidBranchName(name) : null;

  if (checking || existing) {
    return (
      <Shell
        open={open}
        onOpenChange={onOpenChange}
        title="Publish to GitHub"
        description={
          checking
            ? "Checking whether this repository is already on GitHub…"
            : `Already published as ${existing?.nameWithOwner}.`
        }
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            {existing ? (
              <Button size="sm" onClick={() => onOpenExisting(existing.url)}>
                Open on GitHub
              </Button>
            ) : null}
          </>
        }
      >
        {checking ? (
          <div className="text-muted-foreground flex items-center gap-2 px-2 py-3 text-[11.5px]">
            <Spinner className="size-3" /> Asking gh…
          </div>
        ) : null}
      </Shell>
    );
  }

  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title="Publish to GitHub"
      description="Creates the repository on GitHub, adds it as origin, and pushes this branch."
      footer={
        <>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!name.trim() || !!bad}
            onClick={() => onPublish(name.trim(), isPrivate, description)}
          >
            Create and push
          </Button>
        </>
      }
    >
      <Field label="Repository name">
        <Input
          autoFocus
          placeholder="my-project"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      {bad ? <p className="text-destructive text-[11px]">{bad}</p> : null}
      <Field label="Description (optional)">
        <Input
          placeholder="What this project does"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <label className="flex items-center justify-between gap-3">
        <span className="text-[12px]">
          Private repository
          <span className="text-muted-foreground ml-1.5">
            {isPrivate ? "only you can see it" : "anyone can see it"}
          </span>
        </span>
        <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
      </label>
    </Shell>
  );
}
