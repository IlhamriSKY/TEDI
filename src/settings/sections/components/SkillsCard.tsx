import { useEffect, useState } from "react";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import {
  Add01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  Download04Icon,
  Refresh01Icon,
  SparklesIcon,
  Link01Icon,
  Calendar01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  checkAllSkillUpdates,
  installSkillsFromGithub,
  loadInstalledSkills,
  loadProjectSkills,
  previewSkillsFromGithub,
  removeSkill,
  removeSkillGroup,
  skillGroupDir,
  updateAllSkillGroups,
  updateSkillGroup,
  type SkillMeta,
} from "@/modules/ai/lib/skills";

type PendingDelete = { label: string; dir: string; isGroup?: boolean };
type UpdateInfo = {
  hasUpdate: boolean;
  currentSha: string | null;
  latestSha: string | null;
  latestCommitMsg: string | null;
};

const folderName = (p: string) =>
  p
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .pop() || p;

/** Shorten a SHA to 7 chars. */
const shortSha = (sha: string | null) => (sha ? sha.slice(0, 7) : null);

/** Format a relative time from ISO string. */
function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/** Group a skill list by source folder; named groups first, ungrouped last. */
function groupByRepo(list: SkillMeta[]): Array<[string, SkillMeta[]]> {
  const map = new Map<string, SkillMeta[]>();
  for (const s of list) {
    const g = s.group || "";
    const arr = map.get(g);
    if (arr) arr.push(s);
    else map.set(g, [s]);
  }
  return [...map.entries()].sort((a, b) =>
    a[0] === "" ? 1 : b[0] === "" ? -1 : a[0].localeCompare(b[0]),
  );
}

function SkillRow({
  s,
  onUpdate,
  onDelete,
}: {
  s: SkillMeta;
  onUpdate?: () => void;
  onDelete: () => void;
}) {
  const ver = s.version ?? (s.state?.version ? s.state.version : null);
  const installDate = s.state?.installedAt;
  const requires = s.requires ?? s.state?.requires ?? [];

  return (
    <li className="border-border/60 bg-card/60 flex items-center gap-2 rounded-lg border px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium">{s.name}</span>
          {ver && (
            <span className="text-muted-foreground bg-accent/40 rounded px-1 py-0 font-mono text-[9.5px]">
              v{ver}
            </span>
          )}
          {onUpdate && (
            <button
              type="button"
              onClick={onUpdate}
              className="text-accent-foreground/70 hover:text-accent-foreground shrink-0 rounded p-0.5 transition-colors"
              title="Update this skill"
            >
              <HugeiconsIcon icon={Refresh01Icon} size={10} strokeWidth={2} />
            </button>
          )}
        </div>
        <span className="text-muted-foreground line-clamp-2 text-[10.5px] leading-relaxed">
          {s.description}
        </span>
        <div className="text-muted-foreground/60 mt-0.5 flex items-center gap-2 text-[9.5px]">
          {installDate && (
            <span
              className="flex items-center gap-0.5"
              title={`Installed ${relativeTime(installDate)}`}
            >
              <HugeiconsIcon icon={Calendar01Icon} size={9} />
              {relativeTime(installDate)}
            </span>
          )}
          {requires.length > 0 && (
            <span className="flex items-center gap-0.5">
              <HugeiconsIcon icon={Link01Icon} size={9} />
              deps: {requires.join(", ")}
            </span>
          )}
        </div>
      </div>
      <IconTooltip label="Remove" side="left">
        <Button
          size="icon"
          variant="ghost"
          className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive size-7"
          onClick={onDelete}
          aria-label="Remove"
        >
          <HugeiconsIcon icon={Delete02Icon} size={12} strokeWidth={1.75} />
        </Button>
      </IconTooltip>
    </li>
  );
}

/**
 * Install + manage file-based AI skills. Scanned live from `~/.tedi/skills`
 * (global) and the open project's `.tedi/skills`; grouped per source repo into
 * searchable, collapsible accordions. The agent reads each SKILL.md on demand.
 */
export function SkillsCard() {
  const [globalSkills, setGlobalSkills] = useState<SkillMeta[]>([]);
  const [projectSkills, setProjectSkills] = useState<SkillMeta[]>([]);
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [useLocal, setUseLocal] = useState(false);
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  // Preview state
  const [preview, setPreview] = useState<{
    count: number;
    skills: string[];
    group: string;
    repo: string;
  } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);

  // Update tracking
  const [updates, setUpdates] = useState<Map<string, UpdateInfo>>(new Map());
  const [checkFailed, setCheckFailed] = useState(0);
  const [updateBusy, setUpdateBusy] = useState<string | null>(null);

  // Open folder, kept reactive via the cross-window `storage` event.
  const [openRoot, setOpenRoot] = useState<string | null>(() => {
    try {
      return (
        localStorage.getItem("tedi.liveWorkspaceRoot") ||
        localStorage.getItem("tedi.workspaceRoot") ||
        null
      );
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "tedi.liveWorkspaceRoot" || e.key === "tedi.workspaceRoot") {
        try {
          setOpenRoot(
            localStorage.getItem("tedi.liveWorkspaceRoot") ||
              localStorage.getItem("tedi.workspaceRoot") ||
              null,
          );
        } catch {
          setOpenRoot(null);
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const installRoot = useLocal && openRoot ? openRoot : null;

  const refresh = () => {
    void loadInstalledSkills().then(setGlobalSkills);
    void loadProjectSkills(openRoot).then(setProjectSkills);
  };
  useEffect(() => {
    void loadInstalledSkills().then(setGlobalSkills);
    void loadProjectSkills(openRoot).then(setProjectSkills);
  }, [openRoot]);

  // Check for updates on load and refresh
  const checkUpdates = async () => {
    const { updates: result, failed } = await checkAllSkillUpdates();
    setUpdates(result);
    setCheckFailed(failed);
  };
  useEffect(() => {
    void checkUpdates();
  }, [globalSkills, projectSkills]);

  const total = globalSkills.length + projectSkills.length;
  const q = query.trim().toLowerCase();
  const matchesQuery = (s: SkillMeta) =>
    !q ||
    s.name.toLowerCase().includes(q) ||
    s.description.toLowerCase().includes(q) ||
    s.group.toLowerCase().includes(q);

  const toggleGroup = (key: string, open: boolean) =>
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });

  // Preview before install
  const handlePreview = async () => {
    const value = ref.trim();
    if (!value) return;
    setPreviewBusy(true);
    setPreview(null);
    try {
      const p = await previewSkillsFromGithub(value);
      setPreview({
        count: p.count,
        skills: [...p.skills.keys()],
        group: p.group,
        repo: `${p.owner}/${p.repo}`,
      });
    } catch (e) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
      setPreview(null);
    } finally {
      setPreviewBusy(false);
    }
  };

  // Install after preview
  const install = async () => {
    const value = ref.trim();
    if (!value || busy) return;
    setBusy(true);
    setStatus(null);
    setPreview(null);
    try {
      const { installed, failed, group, sha } = await installSkillsFromGithub(value, installRoot);
      const where = installRoot
        ? `${installRoot.replace(/\\/g, "/")}/.tedi/skills`
        : "~/.tedi/skills";
      const failNote =
        failed.length > 0
          ? ` (${failed.length} could not be downloaded: ${failed.join(", ")})`
          : "";
      setStatus({
        kind: failed.length > 0 ? "err" : "ok",
        msg: `Installed ${installed.length} skill${installed.length === 1 ? "" : "s"} into "${group}" at ${where}: ${installed.join(", ")}${sha ? ` (${shortSha(sha)})` : ""}${failNote}`,
      });
      setRef("");
      refresh();
    } catch (e) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  // Update a single group
  const handleUpdateGroup = async (group: string) => {
    setUpdateBusy(group);
    try {
      const result = await updateSkillGroup(group);
      if (result) {
        const failNote =
          result.failed.length > 0
            ? ` (${result.failed.length} failed: ${result.failed.join(", ")})`
            : "";
        setStatus({
          kind: result.failed.length > 0 ? "err" : "ok",
          msg: `Updated ${result.updated.length} skill(s) in "${group}"${result.sha ? ` (${shortSha(result.sha)})` : ""}${failNote}`,
        });
        refresh();
      }
    } catch (e) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setUpdateBusy(null);
    }
  };

  // Update all
  const handleUpdateAll = async () => {
    setUpdateBusy("all");
    try {
      const result = await updateAllSkillGroups();
      if (result) {
        setStatus({
          kind: "ok",
          msg: `Updated ${result.updated.length} skill(s) across ${result.groups.length} group(s): ${result.groups.join(", ")}`,
        });
        refresh();
      } else {
        setStatus({ kind: "ok", msg: "All skills are up to date." });
      }
    } catch (e) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setUpdateBusy(null);
    }
  };

  const pendingUpdatesCount = [...updates.values()].filter((u) => u.hasUpdate).length;

  const renderSection = (title: string, list: SkillMeta[]) => {
    const filtered = list.filter(matchesQuery);
    if (filtered.length === 0) return null;
    return (
      <div className="flex flex-col gap-1.5">
        <div className="text-muted-foreground/70 text-[10px] font-semibold tracking-wide uppercase">
          {title}
        </div>
        {groupByRepo(filtered).map(([group, items]) => {
          const groupKey = skillGroupDir(items[0]) ?? group;
          const updateInfo = group ? (updates.get(group) ?? null) : null;
          const hasUpdate = updateInfo?.hasUpdate ?? false;
          if (!group) {
            return (
              <ul key="(ungrouped)" className="flex flex-col gap-1.5">
                {items.map((s) => (
                  <SkillRow
                    key={s.dir}
                    s={s}
                    onDelete={() => setPendingDelete({ label: `"${s.name}"`, dir: s.dir })}
                  />
                ))}
              </ul>
            );
          }
          return (
            <Collapsible
              key={groupKey}
              open={q !== "" || openGroups.has(groupKey)}
              onOpenChange={(o) => toggleGroup(groupKey, o)}
              className="border-border/60 overflow-hidden rounded-lg border"
            >
              <div className="bg-card/40 flex items-center gap-1">
                <CollapsibleTrigger className="group hover:bg-muted/40 flex flex-1 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-[11.5px] transition-colors">
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    size={12}
                    strokeWidth={2}
                    className="text-muted-foreground shrink-0 transition-transform group-data-[state=open]:rotate-90"
                  />
                  <span className="font-medium">{group}</span>
                  <span className="text-muted-foreground text-[10px]">· {items.length}</span>
                  {hasUpdate && (
                    <span className="text-accent-foreground flex items-center gap-0.5 text-[9.5px] font-medium">
                      <HugeiconsIcon icon={Download04Icon} size={10} />
                      Update available
                    </span>
                  )}
                </CollapsibleTrigger>
                <div className="flex shrink-0 items-center gap-1">
                  {hasUpdate && (
                    <button
                      type="button"
                      onClick={() => handleUpdateGroup(group)}
                      disabled={updateBusy === group}
                      className={cn(
                        "text-accent-foreground/70 hover:text-accent-foreground flex shrink-0 items-center gap-1 px-2.5 text-[10px] underline-offset-2 transition-colors hover:underline",
                        updateBusy === group && "cursor-not-allowed opacity-50",
                      )}
                      title={`Update "${group}"`}
                    >
                      {updateBusy === group ? (
                        <Spinner className="size-3" />
                      ) : (
                        <>
                          <HugeiconsIcon icon={Refresh01Icon} size={9} />
                          Update
                        </>
                      )}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      setPendingDelete({
                        label: `the "${group}" group (${items.length} skill${items.length === 1 ? "" : "s"})`,
                        dir: groupKey!,
                        isGroup: true,
                      })
                    }
                    className="text-muted-foreground/70 hover:text-destructive shrink-0 px-2.5 text-[10px] underline-offset-2 hover:underline"
                  >
                    Remove all
                  </button>
                </div>
              </div>
              <CollapsibleContent>
                <ul className="flex flex-col gap-1.5 px-1.5 pt-1.5 pb-1.5">
                  {items.map((s) => (
                    <SkillRow
                      key={s.dir}
                      s={s}
                      onDelete={() => setPendingDelete({ label: `"${s.name}"`, dir: s.dir })}
                    />
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>
    );
  };

  return (
    <section className="border-border/60 bg-card/30 flex flex-col gap-2 rounded-lg border px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-medium">Skills</span>
          {pendingUpdatesCount > 0 && (
            <span className="text-accent-foreground bg-accent/30 flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[9.5px] font-medium">
              <HugeiconsIcon icon={Download04Icon} size={9} />
              {pendingUpdatesCount} update{pendingUpdatesCount > 1 ? "s" : ""} available
            </span>
          )}
        </div>
        <span className="text-muted-foreground text-[11px] leading-relaxed">
          Expert playbooks the AI loads on demand or you invoke with a slash command. Install any
          GitHub repo with SKILL.md files, globally or into the open project.
        </span>
      </div>

      {/* Install input + preview */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Input
            value={ref}
            onChange={(e) => {
              setRef(e.target.value);
              setPreview(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (!preview) void handlePreview();
                else void install();
              }
            }}
            placeholder="owner/repo or GitHub URL (any repo with SKILL.md files)"
            className="h-8 flex-1 text-[12px]"
            spellCheck={false}
            disabled={busy || previewBusy}
          />
          {!preview ? (
            <Button
              size="sm"
              variant="secondary"
              className="h-8 shrink-0 gap-1.5 px-2.5 text-[11px]"
              disabled={busy || previewBusy || !ref.trim()}
              onClick={() => void handlePreview()}
            >
              {previewBusy ? (
                <Spinner className="size-3.5" />
              ) : (
                <HugeiconsIcon icon={SparklesIcon} size={12} strokeWidth={1.75} />
              )}
              Preview
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-8 shrink-0 gap-1.5 px-2.5 text-[11px]"
              disabled={busy || !ref.trim()}
              onClick={() => void install()}
            >
              {busy ? (
                <Spinner className="size-3.5" />
              ) : (
                <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
              )}
              {busy ? "Installing…" : "Install"}
            </Button>
          )}
        </div>

        {/* Preview card */}
        {preview && (
          <div className="border-border/40 bg-accent/10 flex flex-col gap-1 rounded-lg border px-3 py-2">
            <div className="flex items-center gap-1.5 text-[11px] font-medium">
              <HugeiconsIcon icon={SparklesIcon} size={12} className="text-accent-foreground" />
              {preview.count} skill{preview.count !== 1 ? "s" : ""} found in{" "}
              <span className="font-mono text-[10.5px]">{preview.repo}</span>
            </div>
            <div className="text-muted-foreground flex flex-wrap gap-1 text-[10px]">
              {preview.skills.map((s) => (
                <span
                  key={s}
                  className="bg-background/60 rounded px-1.5 py-0.5 font-mono text-[9.5px]"
                >
                  /{s}
                </span>
              ))}
            </div>
            <div className="text-muted-foreground/70 mt-0.5 text-[9.5px]">
              Will install to:{" "}
              <strong>
                {installRoot ? `project ${folderName(installRoot)}` : "global (~/.tedi/skills)"}
              </strong>{" "}
              → {preview.group}/
            </div>
          </div>
        )}
      </div>

      {/* Install target toggle */}
      <div className="flex items-center gap-1.5 text-[10.5px]">
        <span className="text-muted-foreground">Install to:</span>
        <button
          type="button"
          onClick={() => setUseLocal(false)}
          className={cn(
            "cursor-pointer rounded px-1.5 py-0.5 transition-colors",
            !useLocal ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          Global (~/.tedi)
        </button>
        <IconTooltip label={openRoot ?? "Open a folder in TEDI first"} side="top">
          <button
            type="button"
            onClick={() => openRoot && setUseLocal(true)}
            disabled={!openRoot}
            className={cn(
              "max-w-[55%] cursor-pointer truncate rounded px-1.5 py-0.5 transition-colors",
              useLocal && openRoot
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
              !openRoot && "cursor-not-allowed opacity-50",
            )}
          >
            {openRoot ? `This project: ${folderName(openRoot)}` : "No folder open"}
          </button>
        </IconTooltip>
      </div>

      {/* Status message */}
      {status ? (
        <div
          className={cn(
            "text-[10.5px] leading-relaxed break-words",
            status.kind === "ok" ? "text-diff-added" : "text-destructive",
          )}
        >
          {status.msg}
        </div>
      ) : null}

      {/* Couldn't-check note: distinguishes a failed update check (offline /
          GitHub unreachable) from "all up to date" so a silent failure isn't misread. */}
      {checkFailed > 0 && (
        <div className="text-muted-foreground/70 text-[10px] leading-relaxed">
          Couldn&apos;t check {checkFailed} skill group{checkFailed > 1 ? "s" : ""} for updates
          (offline or GitHub unreachable). Try again later.
        </div>
      )}

      {/* Update all button */}
      {pendingUpdatesCount > 0 && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-[10.5px]"
            disabled={updateBusy === "all"}
            onClick={() => void handleUpdateAll()}
          >
            {updateBusy === "all" ? (
              <Spinner className="size-3" />
            ) : (
              <HugeiconsIcon icon={Refresh01Icon} size={11} />
            )}
            Update all ({pendingUpdatesCount})
          </Button>
          <span className="text-muted-foreground text-[9.5px]">
            {pendingUpdatesCount} group{pendingUpdatesCount > 1 ? "s" : ""} have updates
          </span>
        </div>
      )}

      {/* Skills list */}
      {total === 0 ? (
        <div className="text-muted-foreground/80 border-border/40 border-t pt-2 text-[10.5px] leading-relaxed">
          No skills installed yet. Paste a GitHub repo with SKILL.md files above to install one.
        </div>
      ) : (
        <div className="border-border/40 flex flex-col gap-3 border-t pt-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills…"
            className="h-7 text-[11.5px]"
            spellCheck={false}
          />
          {renderSection("Global (~/.tedi)", globalSkills)}
          {renderSection(
            openRoot ? `This project: ${folderName(openRoot)}` : "This project",
            projectSkills,
          )}
          {q && !globalSkills.some(matchesQuery) && !projectSkills.some(matchesQuery) ? (
            <div className="text-muted-foreground/80 text-[10.5px] italic">
              No skills match "{query}".
            </div>
          ) : null}
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingDelete?.isGroup ? "Remove skill group?" : "Remove skill?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? `${pendingDelete.label} will be permanently deleted.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) {
                  if (pendingDelete.isGroup) {
                    void removeSkillGroup(pendingDelete.dir).then(() => {
                      refresh();
                    });
                  } else {
                    void removeSkill(pendingDelete.dir).then(refresh);
                  }
                }
                setPendingDelete(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
