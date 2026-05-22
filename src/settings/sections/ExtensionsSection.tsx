import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import {
  loadExtensionIcon,
  permissionRiskTier,
  settingsRegistry,
  useExtensionsStore,
  type InstalledExtension,
} from "@/modules/extensions";
import { useExtSetting } from "@/modules/extensions/extSettings";
import { useRegistry } from "@/modules/extensions/useRegistry";
import type { ContributedSetting, Manifest } from "@/modules/extensions/manifest";
import { safeParseManifest } from "@/modules/extensions/manifest";

import { SectionHeader } from "../components/SectionHeader";

type InstallTab = "zip" | "github";

type PendingSource =
  | { kind: "zip"; path: string }
  | { kind: "github"; repo: string };

type PendingPreview =
  | { status: "loading"; sourceLabel: string }
  | { status: "error"; sourceLabel: string; message: string }
  | {
      status: "ready";
      sourceLabel: string;
      manifest: Manifest;
      iconUrl: string | null;
    };

type Pending = {
  source: PendingSource;
  preview: PendingPreview;
};

/** MIME type for the manifest icon path. Mirrors `icon.ts`; duplicated to keep the preview dialog standalone. */
function mimeForIconPath(rel: string): string {
  const lower = rel.toLowerCase();
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

type RawPeek = {
  manifest: unknown;
  icon_base64: string | null;
  icon_rel_path: string | null;
  source: string;
};

export function ExtensionsSection() {
  const init = useExtensionsStore((s) => s.init);
  const hydrated = useExtensionsStore((s) => s.hydrated);
  const list = useExtensionsStore((s) => s.list);
  const lastError = useExtensionsStore((s) => s.lastError);
  const install = useExtensionsStore((s) => s.install);
  const setEnabled = useExtensionsStore((s) => s.setEnabled);
  const uninstall = useExtensionsStore((s) => s.uninstall);
  const checkAllUpdates = useExtensionsStore((s) => s.checkAllUpdates);
  const checkUpdate = useExtensionsStore((s) => s.checkUpdate);
  const updateExtension = useExtensionsStore((s) => s.updateExtension);
  const updatingIds = useExtensionsStore((s) => s.updatingIds);

  const [tab, setTab] = useState<InstallTab>("zip");
  const [repoInput, setRepoInput] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [checkingAll, setCheckingAll] = useState(false);

  const hasGithubExt = list.some((e) => e.source.startsWith("github:"));
  const updatesAvailable = list.filter(
    (e) =>
      e.latest_version !== null &&
      e.latest_version !== undefined &&
      e.latest_version !== e.version,
  ).length;

  useEffect(() => {
    void init();
  }, [init]);

  const startReview = async (source: PendingSource, sourceLabel: string) => {
    // Open the dialog immediately in a loading state. The peek call reads
    // the package manifest and icon with no install side effects; failures
    // surface as an error preview rather than hiding the dialog.
    setInstallError(null);
    setPending({ source, preview: { status: "loading", sourceLabel } });
    try {
      const raw =
        source.kind === "zip"
          ? await invoke<RawPeek>("ext_peek_zip", { zipPath: source.path })
          : await invoke<RawPeek>("ext_peek_github", { repo: source.repo });

      const parsed = safeParseManifest(raw.manifest);
      if (!parsed.ok) {
        setPending({
          source,
          preview: {
            status: "error",
            sourceLabel,
            message: `Invalid manifest: ${parsed.error}`,
          },
        });
        return;
      }

      let iconUrl: string | null = null;
      if (raw.icon_base64 && raw.icon_rel_path) {
        iconUrl = `data:${mimeForIconPath(raw.icon_rel_path)};base64,${raw.icon_base64}`;
      }

      setPending({
        source,
        preview: {
          status: "ready",
          sourceLabel,
          manifest: parsed.manifest,
          iconUrl,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPending({ source, preview: { status: "error", sourceLabel, message } });
    }
  };

  const pickZip = async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        filters: [{ name: "Extension package", extensions: ["zip"] }],
      });
      const path = typeof selected === "string" ? selected : null;
      if (!path) return;
      await startReview({ kind: "zip", path }, path);
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    }
  };

  const onConfirmInstall = async () => {
    if (!pending) return;
    setBusy(true);
    setInstallError(null);
    try {
      // Pass the id from peek so the store can deactivate the prior install
      // before Rust replaces the folder. Avoids Windows file lock errors.
      const expectedId =
        pending.preview.status === "ready" ? pending.preview.manifest.id : undefined;
      const ext = await install(pending.source, expectedId);
      toast(`Installed "${ext.manifest.name}" v${ext.manifest.version}`, {
        variant: "success",
      });
      setPending(null);
      setRepoInput("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setInstallError(msg);
    } finally {
      setBusy(false);
    }
  };

  const onCheckAll = async () => {
    setCheckingAll(true);
    try {
      await checkAllUpdates();
      const updated = useExtensionsStore.getState().list;
      const ready = updated.filter(
        (e) => e.latest_version && e.latest_version !== e.version,
      );
      if (ready.length === 0) {
        toast("All extensions are up to date", { variant: "success" });
      } else {
        toast(
          `${ready.length} update${ready.length === 1 ? "" : "s"} available`,
          { variant: "info" },
        );
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { variant: "error" });
    } finally {
      setCheckingAll(false);
    }
  };

  const sorted = useMemo(
    () => [...list].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)),
    [list],
  );

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="Extensions"
        description="Install extensions to add themes, slash commands, AI tools, or custom integrations. Extensions run inside the app and can request permissions like settings access or Rust command invocation. Review the manifest before installing."
      />

      <div className="flex flex-col gap-3">
        <Label>Install</Label>
        <div className="border-border/60 bg-card/40 flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex gap-1">
            {(["zip", "github"] as InstallTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "h-7 rounded-md px-2.5 text-[11.5px] font-medium transition",
                  tab === t
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
                type="button"
              >
                {t === "zip" ? "From file" : "From GitHub"}
              </button>
            ))}
          </div>

          {tab === "zip" ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground flex-1 text-[11px]">
                Pick a packaged extension `.zip`. Re-installing the same id replaces the
                existing copy (so this is also how local zips upgrade).
              </span>
              <Button size="sm" variant="outline" onClick={() => void pickZip()}>
                Choose .zip…
              </Button>
            </div>
          ) : null}

          {tab === "github" ? (
            <div className="flex items-center gap-2">
              <Input
                placeholder="owner/repo or https://github.com/owner/repo"
                value={repoInput}
                onChange={(e) => setRepoInput(e.target.value)}
                className="h-8 text-[11.5px]"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!repoInput.includes("/")}
                onClick={() =>
                  void startReview(
                    { kind: "github", repo: repoInput.trim() },
                    `${repoInput.trim()} (latest release)`,
                  )
                }
              >
                Review
              </Button>
            </div>
          ) : null}

          {installError ? (
            <div className="text-destructive text-[11px]">{installError}</div>
          ) : null}
          {lastError && !installError ? (
            <div className="text-destructive text-[11px]">{lastError}</div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label>
            {updatesAvailable > 0
              ? `Installed · ${updatesAvailable} update${updatesAvailable === 1 ? "" : "s"} available`
              : "Installed"}
          </Label>
          {hasGithubExt ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-[11px]"
              disabled={checkingAll}
              onClick={() => void onCheckAll()}
            >
              {checkingAll ? "Checking…" : "Check updates"}
            </Button>
          ) : null}
        </div>
        {!hydrated ? (
          <span className="text-muted-foreground text-[11px]">Loading…</span>
        ) : sorted.length === 0 ? (
          <span className="text-muted-foreground text-[11px]">
            No extensions installed yet.
          </span>
        ) : (
          sorted.map((ext) => (
            <ExtensionCard
              key={ext.id}
              ext={ext}
              updating={updatingIds.has(ext.id)}
              onToggle={(next) => void setEnabled(ext.id, next)}
              onUninstall={() =>
                void uninstall(ext.id).then(() =>
                  toast(`Uninstalled ${ext.manifest.name}`),
                )
              }
              onCheckUpdate={() => void checkSingleUpdate(ext, checkUpdate)}
              onUpdate={() => void updateOne(ext, updateExtension)}
            />
          ))
        )}
      </div>

      <InstallReviewDialog
        pending={pending}
        busy={busy}
        installError={installError}
        onCancel={() => {
          setPending(null);
          setInstallError(null);
        }}
        onConfirm={onConfirmInstall}
      />
    </div>
  );
}

function ExtensionCard({
  ext,
  updating,
  onToggle,
  onUninstall,
  onCheckUpdate,
  onUpdate,
}: {
  ext: InstalledExtension;
  updating: boolean;
  onToggle: (next: boolean) => void;
  onUninstall: () => void;
  onCheckUpdate: () => void;
  onUpdate: () => void;
}) {
  // Live view of contributed settings. Updates when the extension calls `tedi.contribute.settings`.
  const all = useRegistry(settingsRegistry);
  const contributed = all
    .filter((entry) => entry.extensionId === ext.id)
    .map((entry) => entry.item);

  const isGithub = ext.source.startsWith("github:");
  const updateAvailable =
    ext.latest_version !== null &&
    ext.latest_version !== undefined &&
    ext.latest_version !== ext.version;

  return (
    <div
      className={cn(
        "border-border/60 bg-card/60 relative flex flex-col gap-2 overflow-hidden rounded-lg border px-3 py-2.5 transition-opacity",
        updating && "opacity-70",
      )}
      aria-busy={updating || undefined}
    >
      {/* Animated stripe across the top while updating. */}
      {updating ? (
        <span
          aria-hidden
          className="from-primary/0 via-primary/70 to-primary/0 absolute inset-x-0 top-0 h-0.5 animate-pulse bg-gradient-to-r"
        />
      ) : null}
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <ExtensionIcon
            extId={ext.id}
            iconPath={ext.manifest.icon}
            fallbackLabel={ext.manifest.name}
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] font-medium">{ext.manifest.name}</span>
              <Badge variant="secondary" className="h-4 px-1.5 font-mono text-[9.5px]">
                v{ext.manifest.version}
              </Badge>
              {updateAvailable ? (
                <Badge
                  variant="outline"
                  className="h-4 border-emerald-500/50 bg-emerald-500/10 px-1.5 font-mono text-[9.5px] uppercase tracking-wide text-emerald-700 dark:text-emerald-300"
                >
                  v{ext.latest_version} available
                </Badge>
              ) : null}
            </div>
            <span className="text-muted-foreground text-[10.5px] leading-relaxed">
              {ext.manifest.description ??
                `Source: ${ext.source}${ext.manifest.author ? ` · ${ext.manifest.author}` : ""}`}
            </span>
            <span className="text-muted-foreground/70 text-[10px]">
              Source: {ext.source}
              {ext.last_checked_at_ms
                ? ` · checked ${formatRelative(ext.last_checked_at_ms)}`
                : ""}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {updateAvailable && isGithub ? (
            <Button
              size="sm"
              className="h-7 gap-1.5 px-2.5 text-[11px]"
              onClick={onUpdate}
              disabled={updating}
            >
              {updating ? (
                <>
                  <Spinner className="size-3" />
                  Updating…
                </>
              ) : (
                "Update"
              )}
            </Button>
          ) : isGithub ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 text-[11px]"
              onClick={onCheckUpdate}
              disabled={updating}
            >
              Check
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive h-7 px-2 text-[11px]"
            onClick={onUninstall}
            disabled={updating}
          >
            Remove
          </Button>
          {/* Enable toggle stays rightmost across all cards. */}
          <Switch checked={ext.enabled} onCheckedChange={onToggle} disabled={updating} />
        </div>
      </div>
      {ext.enabled && contributed.length > 0 ? (
        <div className="flex flex-col gap-1.5 pt-1">
          {contributed.map((setting) => (
            <ContributedSettingRow key={setting.id} extId={ext.id} setting={setting} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

async function checkSingleUpdate(
  ext: InstalledExtension,
  checkUpdate: (id: string) => Promise<{ has_update: boolean; latest_version: string | null }>,
): Promise<void> {
  if (!ext.source.startsWith("github:")) {
    toast(
      `${ext.manifest.name}: installed from a local .zip, so auto-update isn't available.`,
      { variant: "warning" },
    );
    return;
  }
  try {
    const result = await checkUpdate(ext.id);
    if (result.has_update) {
      toast(`${ext.manifest.name}: v${result.latest_version} available`, {
        variant: "info",
      });
    } else {
      toast(`${ext.manifest.name} is up to date`, { variant: "success" });
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), { variant: "error" });
  }
}

async function updateOne(
  ext: InstalledExtension,
  updateExtension: (id: string) => Promise<InstalledExtension>,
): Promise<void> {
  try {
    const next = await updateExtension(ext.id);
    toast(`${next.manifest.name} updated to v${next.manifest.version}`, {
      variant: "success",
    });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), { variant: "error" });
  }
}

/** Format a unix-ms timestamp as "X ago". */
function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Manifest icon for an extension. Falls back to a single-letter avatar when missing or still loading. */
function ExtensionIcon({
  extId,
  iconPath,
  fallbackLabel,
}: {
  extId: string;
  // null and undefined both fall back to the letter avatar.
  iconPath: string | null | undefined;
  fallbackLabel: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!iconPath) {
      setUrl(null);
      return;
    }
    void loadExtensionIcon(extId, iconPath).then((next) => {
      if (alive) setUrl(next);
    });
    return () => {
      alive = false;
    };
  }, [extId, iconPath]);

  if (url) {
    return (
      <img
        src={url}
        alt=""
        className="border-border/40 size-9 shrink-0 rounded-md border object-cover"
        loading="lazy"
        draggable={false}
      />
    );
  }
  const letter = fallbackLabel.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      aria-hidden
      className="bg-muted text-muted-foreground border-border/40 flex size-9 shrink-0 items-center justify-center rounded-md border text-[13px] font-semibold"
    >
      {letter}
    </div>
  );
}

function ContributedSettingRow({
  extId,
  setting,
}: {
  extId: string;
  setting: ContributedSetting;
}) {
  const [value, write] = useExtSetting<unknown>(extId, setting);
  let control: React.ReactNode = null;
  if (setting.type === "boolean") {
    control = (
      <Switch
        checked={Boolean(value)}
        onCheckedChange={(next) => void write(next)}
      />
    );
  } else if (setting.type === "string") {
    control = (
      <Input
        className="h-7 w-44 text-[11px]"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => void write(e.target.value)}
        type={setting.secret ? "password" : "text"}
      />
    );
  } else if (setting.type === "number") {
    control = (
      <Input
        className="h-7 w-20 text-[11px]"
        type="number"
        value={typeof value === "number" ? String(value) : ""}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          void write(n);
        }}
      />
    );
  } else if (setting.type === "select" && setting.options) {
    control = (
      <select
        className="border-border/60 bg-background h-7 rounded-md border px-2 text-[11px]"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => void write(e.target.value)}
      >
        {setting.options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="bg-background/40 border-border/40 flex items-center justify-between gap-3 rounded-md border px-2.5 py-1.5">
      <div className="flex min-w-0 flex-col">
        <span className="text-[11.5px] font-medium">{setting.label}</span>
        {setting.description ? (
          <span className="text-muted-foreground text-[10px] leading-snug">
            {setting.description}
          </span>
        ) : null}
      </div>
      {control}
    </div>
  );
}

function InstallReviewDialog({
  pending,
  busy,
  installError,
  onCancel,
  onConfirm,
}: {
  pending: Pending | null;
  busy: boolean;
  installError: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const open = pending !== null;
  const preview = pending?.preview;
  // Disable Install while peek is loading/errored or install is in flight.
  const canInstall = preview?.status === "ready" && !busy;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Install extension?</DialogTitle>
          <DialogDescription>
            Extensions run JavaScript inside the app. Review the manifest below and only
            install from sources you trust.
          </DialogDescription>
        </DialogHeader>

        {preview ? (
          <div className="flex items-start gap-3">
            <PreviewIconSlot preview={preview} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {preview.status === "ready" ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold leading-tight">
                      {preview.manifest.name}
                    </span>
                    <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-mono">
                      v{preview.manifest.version}
                    </Badge>
                  </div>
                  {preview.manifest.description ? (
                    <p className="text-muted-foreground text-[11.5px] leading-relaxed">
                      {preview.manifest.description}
                    </p>
                  ) : null}
                  <div className="text-muted-foreground/80 mt-1 break-all text-[10.5px]">
                    {preview.manifest.author ? <>by {preview.manifest.author} · </> : null}
                    Source: {preview.sourceLabel}
                  </div>
                </>
              ) : preview.status === "loading" ? (
                <>
                  <div className="bg-muted h-3.5 w-32 animate-pulse rounded" />
                  <div className="bg-muted h-2.5 w-48 animate-pulse rounded" />
                  <div className="text-muted-foreground/80 mt-1 break-all text-[10.5px]">
                    Reading {preview.sourceLabel}…
                  </div>
                </>
              ) : (
                <>
                  <span className="text-destructive text-[12.5px] font-medium leading-tight">
                    Could not read this package
                  </span>
                  <p className="text-muted-foreground text-[11px] leading-relaxed">
                    {preview.message}
                  </p>
                  <div className="text-muted-foreground/80 mt-1 break-all text-[10.5px]">
                    {preview.sourceLabel}
                  </div>
                </>
              )}
            </div>
          </div>
        ) : null}

        {preview?.status === "ready" && preview.manifest.permissions.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[10.5px] font-medium tracking-tight uppercase">
              Permissions requested
            </span>
            <div className="flex flex-wrap gap-1">
              {preview.manifest.permissions.map((p) => (
                <PermissionBadge key={p} permission={p} />
              ))}
            </div>
          </div>
        ) : null}

        {installError ? (
          <div className="bg-destructive/10 text-destructive rounded-md px-3 py-2 text-[11px]">
            {installError}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={!canInstall}>
            {busy
              ? "Installing…"
              : preview?.status === "loading"
                ? "Loading…"
                : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Color-coded permission badge. Low = neutral, medium = amber, high = red. */
function PermissionBadge({ permission }: { permission: string }) {
  const tier = permissionRiskTier(permission);
  const tone =
    tier === "high"
      ? "border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-300"
      : tier === "medium"
        ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-border/60 bg-muted/40 text-foreground/80";
  return (
    <Badge
      variant="outline"
      title={`risk: ${tier}`}
      className={cn("h-4 px-1.5 font-mono text-[9.5px]", tone)}
    >
      {permission}
    </Badge>
  );
}

/** Icon slot in the install dialog. Preview image, loading shimmer, or letter-avatar fallback. */
function PreviewIconSlot({ preview }: { preview: PendingPreview }) {
  if (preview.status === "ready" && preview.iconUrl) {
    return (
      <img
        src={preview.iconUrl}
        alt=""
        className="border-border/40 size-14 shrink-0 rounded-md border object-cover"
        loading="lazy"
        draggable={false}
      />
    );
  }
  if (preview.status === "loading") {
    return (
      <div
        aria-hidden
        className="border-border/40 bg-muted size-14 shrink-0 animate-pulse rounded-md border"
      />
    );
  }
  const letter =
    (preview.status === "ready"
      ? preview.manifest.name.trim().charAt(0)
      : preview.sourceLabel.trim().charAt(0)
    ).toUpperCase() || "?";
  return (
    <div
      aria-hidden
      className="bg-muted text-muted-foreground border-border/40 flex size-14 shrink-0 items-center justify-center rounded-md border text-[18px] font-semibold"
    >
      {letter}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground text-[11px] font-medium tracking-tight">
      {children}
    </span>
  );
}
