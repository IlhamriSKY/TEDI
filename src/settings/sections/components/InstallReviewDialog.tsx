import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { permissionRiskTier } from "@/modules/extensions";
import type { Manifest } from "@/modules/extensions/manifest";

export type PendingSource = { kind: "zip"; path: string } | { kind: "github"; repo: string };

export type PendingPreview =
  | { status: "loading"; sourceLabel: string }
  | { status: "error"; sourceLabel: string; message: string }
  | {
      status: "ready";
      sourceLabel: string;
      manifest: Manifest;
      iconUrl: string | null;
    };

export type Pending = {
  source: PendingSource;
  preview: PendingPreview;
};

export function InstallReviewDialog({
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
            Extensions run JavaScript inside the app. Review the manifest below and only install
            from sources you trust.
          </DialogDescription>
        </DialogHeader>

        {preview ? (
          <div className="flex items-start gap-3">
            <PreviewIconSlot preview={preview} />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {preview.status === "ready" ? (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] leading-tight font-semibold">
                      {preview.manifest.name}
                    </span>
                    <Badge variant="secondary" className="h-4 px-1.5 font-mono text-[10px]">
                      v{preview.manifest.version}
                    </Badge>
                  </div>
                  {preview.manifest.description ? (
                    <p className="text-muted-foreground text-[11.5px] leading-relaxed">
                      {preview.manifest.description}
                    </p>
                  ) : null}
                  <div className="text-muted-foreground/80 mt-1 text-[10.5px] break-all">
                    {preview.manifest.author ? <>by {preview.manifest.author} · </> : null}
                    Source: {preview.sourceLabel}
                  </div>
                </>
              ) : preview.status === "loading" ? (
                <>
                  <div className="bg-muted h-3.5 w-32 animate-pulse rounded" />
                  <div className="bg-muted h-2.5 w-48 animate-pulse rounded" />
                  <div className="text-muted-foreground/80 mt-1 text-[10.5px] break-all">
                    Reading {preview.sourceLabel}…
                  </div>
                </>
              ) : (
                <>
                  <span className="text-destructive text-[12.5px] leading-tight font-medium">
                    Could not read this package
                  </span>
                  <p className="text-muted-foreground text-[11px] leading-relaxed">
                    {preview.message}
                  </p>
                  <div className="text-muted-foreground/80 mt-1 text-[10.5px] break-all">
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
            {busy ? "Installing…" : preview?.status === "loading" ? "Loading…" : "Install"}
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
      ? "border-destructive/50 bg-destructive/10 text-destructive"
      : tier === "medium"
        ? "border-icon-working/50 bg-icon-working/10 text-icon-working"
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
