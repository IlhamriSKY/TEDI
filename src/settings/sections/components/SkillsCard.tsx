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
import { Add01Icon, ArrowRight01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  installSkillsFromGithub,
  loadInstalledSkills,
  loadProjectSkills,
  removeSkill,
  skillGroupDir,
  type SkillMeta,
} from "@/modules/ai/lib/skills";

type PendingDelete = { label: string; dir: string };

const folderName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** Live workspace root the agent scans (the open project), shared across
 *  webviews via localStorage. Null when nothing is open. */
function readLiveRoot(): string | null {
  try {
    return (
      localStorage.getItem("tedi.liveWorkspaceRoot") ||
      localStorage.getItem("tedi.workspaceRoot") ||
      null
    );
  } catch {
    return null;
  }
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

function SkillRow({ s, onDelete }: { s: SkillMeta; onDelete: () => void }) {
  return (
    <li className="border-border/60 bg-card/60 flex items-center gap-2 rounded-lg border px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] font-medium">{s.name}</span>
        <span className="text-muted-foreground line-clamp-2 text-[10.5px] leading-relaxed">
          {s.description}
        </span>
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

  // Open folder, kept reactive via the cross-window `storage` event.
  const [openRoot, setOpenRoot] = useState<string | null>(() => readLiveRoot());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === "tedi.liveWorkspaceRoot" || e.key === "tedi.workspaceRoot") {
        setOpenRoot(readLiveRoot());
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

  const install = async () => {
    const value = ref.trim();
    if (!value || busy) return;
    setBusy(true);
    setStatus(null);
    try {
      const { installed, group } = await installSkillsFromGithub(value, installRoot);
      const where = installRoot ? `${installRoot.replace(/\\/g, "/")}/.tedi/skills` : "~/.tedi/skills";
      setStatus({
        kind: "ok",
        msg: `Installed ${installed.length} skill${installed.length === 1 ? "" : "s"} into "${group}" at ${where}: ${installed.join(", ")}`,
      });
      setRef("");
      refresh();
    } catch (e) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const renderSection = (title: string, list: SkillMeta[]) => {
    const filtered = list.filter(matchesQuery);
    if (filtered.length === 0) return null;
    return (
      <div className="flex flex-col gap-1.5">
        <div className="text-muted-foreground/70 text-[10px] font-semibold tracking-wide uppercase">
          {title}
        </div>
        {groupByRepo(filtered).map(([group, items]) => {
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
          const key = skillGroupDir(items[0]) ?? group;
          return (
            <Collapsible
              key={key}
              open={q !== "" || openGroups.has(key)}
              onOpenChange={(o) => toggleGroup(key, o)}
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
                </CollapsibleTrigger>
                <button
                  type="button"
                  onClick={() =>
                    setPendingDelete({
                      label: `the "${group}" group (${items.length} skill${items.length === 1 ? "" : "s"})`,
                      dir: key,
                    })
                  }
                  className="text-muted-foreground/70 hover:text-destructive shrink-0 px-2.5 text-[10px] underline-offset-2 hover:underline"
                >
                  Remove all
                </button>
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
    <section className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/30 px-4 py-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-[12.5px] font-medium">Skills</span>
        <span className="text-muted-foreground text-[11px] leading-relaxed">
          Expert playbooks the AI loads on demand or you invoke with a slash command. Install any
          GitHub repo with SKILL.md files, globally or into the open project.
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void install();
          }}
          placeholder="owner/repo or GitHub URL (any repo with SKILL.md files)"
          className="h-8 flex-1 text-[12px]"
          spellCheck={false}
          disabled={busy}
        />
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
      </div>

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
              No skills match “{query}”.
            </div>
          ) : null}
        </div>
      )}

      <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove skill?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete ? `${pendingDelete.label} will be permanently deleted.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingDelete) void removeSkill(pendingDelete.dir).then(refresh);
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
