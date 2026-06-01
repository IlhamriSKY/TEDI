import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

import { loadExtensionIcon, settingsRegistry, type InstalledExtension } from "@/modules/extensions";
import { useExtSetting } from "@/modules/extensions/extSettings";
import { useRegistry } from "@/modules/extensions/useRegistry";
import type { ContributedSetting } from "@/modules/extensions/manifest";

export function ExtensionCard({
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
  const contributed = all.flatMap((entry) => (entry.extensionId === ext.id ? [entry.item] : []));

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
                  className="border-diff-added/50 bg-diff-added/10 text-diff-added h-4 px-1.5 font-mono text-[9.5px] tracking-wide uppercase"
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
              {ext.last_checked_at_ms ? ` · checked ${formatRelative(ext.last_checked_at_ms)}` : ""}
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

export async function checkSingleUpdate(
  ext: InstalledExtension,
  checkUpdate: (id: string) => Promise<{ has_update: boolean; latest_version: string | null }>,
): Promise<void> {
  if (!ext.source.startsWith("github:")) {
    toast(`${ext.manifest.name}: installed from a local .zip, so auto-update isn't available.`, {
      variant: "warning",
    });
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

export async function updateOne(
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

function ContributedSettingRow({ extId, setting }: { extId: string; setting: ContributedSetting }) {
  const [value, write] = useExtSetting<unknown>(extId, setting);
  let control: React.ReactNode = null;
  if (setting.type === "boolean") {
    control = <Switch checked={Boolean(value)} onCheckedChange={(next) => void write(next)} />;
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
