import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { basename, toForwardSlash } from "@/lib/path";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon, Folder01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { segmentsFromCwd, type Segment } from "./lib/pathUtils";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
};

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  if (i <= 0) return "/";
  return path.slice(0, i);
}

// Pill/badge styles for the breadcrumb segments. Clickable segments use the
// outline-style badge (muted text, fills on hover); the current folder uses
// the filled secondary badge so it visually anchors the trail.
const SEGMENT_BADGE_LINK =
  "inline-flex h-5 cursor-pointer items-center rounded-full border border-border bg-transparent px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
const SEGMENT_BADGE_ACTIVE =
  "inline-flex h-5 cursor-pointer items-center rounded-full bg-secondary px-2 text-[11px] font-medium text-secondary-foreground transition-colors hover:bg-secondary/80";

function joinPath(parent: string, name: string): string {
  // Normalize Windows backslashes from the backend so the resulting path
  // matches the forward-slash convention used by segmentsFromCwd.
  const norm = toForwardSlash(parent);
  return norm.endsWith("/") ? `${norm}${name}` : `${norm}/${name}`;
}

export function CwdBreadcrumb({ cwd, filePath, home, onCd }: Props) {
  if (!cwd && !filePath) {
    return <span className="text-muted-foreground/70 text-xs">no directory</span>;
  }

  const dirPath = filePath ? dirname(filePath) : (cwd as string);
  const segments = segmentsFromCwd(dirPath, home);
  const leafLabel = filePath ? basename(filePath) : segments[segments.length - 1].label;
  // When showing a file, every directory segment is a navigable link.
  // When showing a directory, the last segment is the current cwd
  // (rendered with a dropdown but no link).
  const linkSegments = filePath ? segments : segments.slice(0, -1);
  const currentDirSegment = filePath ? null : segments[segments.length - 1];

  return (
    <Breadcrumb>
      <BreadcrumbList className="gap-1 text-xs sm:gap-1.5">
        {linkSegments.map((s) => (
          <BreadcrumbSegment key={s.fullPath} segment={s} onCd={onCd} />
        ))}
        {currentDirSegment ? (
          <BreadcrumbItem>
            <SubfolderDropdown path={currentDirSegment.fullPath} onCd={onCd}>
              <BreadcrumbPage className={SEGMENT_BADGE_ACTIVE}>
                {currentDirSegment.isHome ? "~" : leafLabel}
              </BreadcrumbPage>
            </SubfolderDropdown>
          </BreadcrumbItem>
        ) : (
          <BreadcrumbItem>
            <BreadcrumbPage className={SEGMENT_BADGE_ACTIVE}>{leafLabel}</BreadcrumbPage>
          </BreadcrumbItem>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function BreadcrumbSegment({ segment, onCd }: { segment: Segment; onCd: (path: string) => void }) {
  return (
    <span className="contents">
      <BreadcrumbItem>
        <BreadcrumbLink asChild>
          <button
            type="button"
            onClick={() => onCd(segment.fullPath)}
            className={SEGMENT_BADGE_LINK}
          >
            {segment.isHome ? "~" : segment.label}
          </button>
        </BreadcrumbLink>
      </BreadcrumbItem>
      <SubfolderDropdown path={segment.fullPath} onCd={onCd}>
        <button
          type="button"
          aria-label={`Browse subfolders of ${segment.label}`}
          className="text-muted-foreground/70 hover:bg-accent/60 hover:text-accent-foreground inline-flex size-4 cursor-pointer items-center justify-center rounded"
        >
          <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={2} />
        </button>
      </SubfolderDropdown>
    </span>
  );
}

function SubfolderDropdown({
  path,
  onCd,
  children,
}: {
  path: string;
  onCd: (path: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    | { status: "idle" }
    | { status: "loading" }
    | { status: "loaded"; dirs: string[] }
    | { status: "error"; message: string }
  >({ status: "idle" });
  // While loading is slow, the click that opened the menu may still be
  // in-flight when items finally render - landing the pointer-up on the
  // freshly-mounted first item and auto-activating it. We gate
  // interactivity until a short cooldown after items appear, which
  // absorbs any stale pointer events.
  const [interactive, setInteractive] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Refetch every time the dropdown opens so the listing reflects the
  // current filesystem (folders may have been added/renamed/deleted via
  // the explorer, AI tools, or external programs between opens).
  useEffect(() => {
    if (!open) {
      setInteractive(false);
      setQuery("");
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    invoke<string[]>("list_subdirs", { path })
      .then((dirs) => {
        if (cancelled) return;
        setState({ status: "loaded", dirs });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({ status: "error", message: String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [open, path]);

  // Arm items ~200ms after the list lands. Long enough to outlast any
  // pointer-up still in flight from the opening click; short enough that
  // an intentional follow-up click feels instant.
  useEffect(() => {
    if (state.status !== "loaded") {
      setInteractive(false);
      return;
    }
    const t = window.setTimeout(() => setInteractive(true), 200);
    return () => window.clearTimeout(t);
  }, [state.status]);

  const allDirs = state.status === "loaded" ? state.dirs : null;
  const showSearch = (allDirs?.length ?? 0) > 5;
  const visibleDirs = useMemo(() => {
    if (!allDirs) return [];
    if (!query) return allDirs;
    const q = query.toLowerCase();
    return allDirs.filter((n) => n.toLowerCase().includes(q));
  }, [allDirs, query]);

  // Focus the search input once items are interactive and the search is
  // visible. Done manually because onOpenAutoFocus is prevented to avoid
  // auto-activating the first menu item.
  useEffect(() => {
    if (interactive && showSearch) {
      searchInputRef.current?.focus();
    }
  }, [interactive, showSearch]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={6}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className="flex max-h-72 w-56 min-w-56 flex-col overflow-hidden p-0"
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {state.status === "error" ? (
            <DropdownMenuItem disabled className="text-destructive text-xs">
              {state.message}
            </DropdownMenuItem>
          ) : state.status !== "loaded" || !interactive ? (
            <DropdownMenuItem disabled className="text-muted-foreground text-xs">
              Loading…
            </DropdownMenuItem>
          ) : state.dirs.length === 0 ? (
            <DropdownMenuItem disabled className="text-muted-foreground text-xs">
              No subfolders
            </DropdownMenuItem>
          ) : visibleDirs.length === 0 ? (
            <DropdownMenuItem disabled className="text-muted-foreground text-xs">
              No matches
            </DropdownMenuItem>
          ) : (
            visibleDirs.map((name) => (
              <DropdownMenuItem
                key={name}
                className="text-xs"
                onSelect={() => {
                  onCd(joinPath(path, name));
                  setOpen(false);
                }}
              >
                <HugeiconsIcon
                  icon={Folder01Icon}
                  size={14}
                  strokeWidth={1.75}
                  className="text-muted-foreground shrink-0"
                />
                <span className="truncate">{name}</span>
              </DropdownMenuItem>
            ))
          )}
        </div>
        {showSearch ? (
          <div className="border-border/60 bg-popover shrink-0 border-t p-1.5">
            <div className="border-border/60 bg-muted/40 flex items-center gap-1.5 rounded-md border px-2 py-1">
              <HugeiconsIcon
                icon={Search01Icon}
                size={12}
                strokeWidth={1.75}
                className="text-muted-foreground shrink-0"
              />
              <input
                ref={searchInputRef}
                type="text"
                value={query}
                aria-label="Search subfolders"
                onChange={(e) => setQuery(e.target.value)}
                // Stop Radix's menu typeahead from intercepting letters
                // and prevent Enter from bubbling to a focused item.
                onKeyDown={(e) => {
                  if (e.key === "Escape") return;
                  e.stopPropagation();
                }}
                placeholder="Search folders…"
                className="placeholder:text-muted-foreground w-full bg-transparent text-xs outline-none"
              />
            </div>
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
