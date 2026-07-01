import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

import { corsFallbackFetch } from "@/modules/ai/lib/httpProxy";
import { useExtensionsStore } from "@/modules/extensions";
import type { InstalledExtension } from "@/modules/extensions";
import { safeParseManifest } from "@/modules/extensions/manifest";

import { Label } from "../components/Label";
import { SectionHeader } from "../components/SectionHeader";
import { SettingsAccordion } from "../components/SettingsAccordion";
import { UploadButton } from "../components/UploadButton";
import { ExtensionCard } from "./components/ExtensionCard";
import { checkSingleUpdate, updateOne } from "./components/extensionUpdate";
import {
  InstallReviewDialog,
  type Pending,
  type PendingSource,
} from "./components/InstallReviewDialog";
import {
  MarketplacePanel,
  type MarketplaceItem,
  type MarketplaceState,
} from "./components/MarketplacePanel";

type InstallTab = "zip" | "github" | "marketplace";

/** Public catalog endpoint. Owner-controlled. Payload is a JSON object with
 *  `official` and (optional) `unofficial` arrays of {@link MarketplaceItem}.
 *  Fired lazily the first time the Marketplace tab is selected, never at
 *  section mount, so users who never visit the tab pay zero network cost. */
const MARKETPLACE_URL = "https://tedi.ilhamriski.com/extensions/";

/** Extract `owner/repo` from any of: full GitHub URL, `github.com/owner/repo`,
 *  or already-normalized `owner/repo`. Trailing slashes and `.git` are
 *  stripped. Returns null if no slug can be derived. Mirrors the backend's
 *  `normalize_owner_repo` so the dedup key here matches what Rust stores. */
function extractOwnerRepo(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let rest = trimmed;
  for (const prefix of [
    "https://github.com/",
    "http://github.com/",
    "https://www.github.com/",
    "http://www.github.com/",
    "github.com/",
  ]) {
    if (rest.toLowerCase().startsWith(prefix)) {
      rest = rest.slice(prefix.length);
      break;
    }
  }
  // Drop trailing `.git`, trailing slash, and any path after `owner/repo`.
  rest = rest.replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = rest.split("/");
  if (parts.length < 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  // Backend's `safe()` rejects spaces and a few specials; rough mirror.
  if (/\s/.test(owner) || /\s/.test(repo)) return null;
  return `${owner}/${repo}`;
}

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
  const [marketplace, setMarketplace] = useState<MarketplaceState>({ status: "idle" });
  /** Cancels an in-flight marketplace fetch on tab-switch/unmount/refresh. */
  const marketplaceAbortRef = useRef<AbortController | null>(null);

  const hasGithubExt = list.some((e) => e.source.startsWith("github:"));
  const updatesAvailable = list.filter(
    (e) =>
      e.latest_version !== null && e.latest_version !== undefined && e.latest_version !== e.version,
  ).length;

  useEffect(() => {
    void init();
  }, [init]);

  // Lazy: fire the network request only when the user actually opens the
  // Marketplace tab. A successful (`ready`) or in-flight (`loading`) result is
  // reused, but a prior `error` is retried on every tab re-open - otherwise a
  // failure while the catalog host was still coming up would stick until a
  // manual Refresh, which reads as "broken" even after the endpoint is live.
  const fetchMarketplace = useCallback(async (force: boolean) => {
    if (!force) {
      // Snapshot the current state via the setter callback so this callback
      // doesn't need `marketplace` in its dep list (which would cause a
      // re-fetch every time state ticks during loading). Skip only when we
      // already have a good result or a request is in flight; `error`/`idle`
      // fall through and re-fetch.
      let skip = false;
      setMarketplace((prev) => {
        if (prev.status === "ready" || prev.status === "loading") skip = true;
        return prev;
      });
      if (skip) return;
    }
    marketplaceAbortRef.current?.abort();
    const ctrl = new AbortController();
    marketplaceAbortRef.current = ctrl;
    setMarketplace({ status: "loading" });
    try {
      // `corsFallbackFetch` tries the WebView's native fetch first, then routes
      // through the Rust HTTP stack when the WebView blocks the request (CORS,
      // or a stale negative-DNS entry from an attempt made before the catalog
      // host was live) - the same fallback the AI provider calls use. Retry
      // once on a transient network throw so a momentary blip self-heals
      // instead of parking the panel in an error the user must clear by hand.
      const fetchCatalog = async (): Promise<Response> => {
        let lastErr: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (ctrl.signal.aborted) throw new DOMException("Aborted", "AbortError");
          try {
            return await corsFallbackFetch(MARKETPLACE_URL, {
              signal: ctrl.signal,
              cache: "default",
              headers: { accept: "application/json" },
              // Avoid leaking the desktop app's referrer header to the catalog host.
              referrerPolicy: "no-referrer",
            });
          } catch (e) {
            if ((e as { name?: string })?.name === "AbortError") throw e;
            lastErr = e;
            await new Promise((r) => setTimeout(r, 600));
          }
        }
        throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
      };
      const resp = await fetchCatalog();
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const raw: unknown = await resp.json();
      if (!raw || typeof raw !== "object") {
        throw new Error("Catalog did not return an object");
      }
      const rec = raw as Record<string, unknown>;
      const parseList = (list: unknown, channel: "official" | "unofficial"): MarketplaceItem[] => {
        if (!Array.isArray(list)) return [];
        const out: MarketplaceItem[] = [];
        for (const entry of list) {
          if (!entry || typeof entry !== "object") continue;
          const e = entry as Record<string, unknown>;
          if (typeof e.id !== "string" || typeof e.name !== "string") continue;
          // Catalog uses `repository` (URL); fall back to `repo` for
          // forward-compat with the simpler array shape.
          const repoField =
            typeof e.repository === "string"
              ? e.repository
              : typeof e.repo === "string"
                ? e.repo
                : null;
          if (!repoField) continue;
          const slug = extractOwnerRepo(repoField);
          if (!slug) continue;
          out.push({
            id: e.id,
            name: e.name,
            repoSlug: slug,
            repository: repoField,
            description: typeof e.description === "string" ? e.description : undefined,
            icon: typeof e.icon === "string" ? e.icon : undefined,
            // Accept either `publisher` (current catalog) or `author` (legacy).
            publisher:
              typeof e.publisher === "string"
                ? e.publisher
                : typeof e.author === "string"
                  ? e.author
                  : undefined,
            version: typeof e.version === "string" ? e.version : undefined,
            license: typeof e.license === "string" ? e.license : undefined,
            channel,
          });
        }
        return out;
      };
      const items = [
        ...parseList(rec.official, "official"),
        ...parseList(rec.unofficial, "unofficial"),
      ];
      if (ctrl.signal.aborted) return;
      setMarketplace({ status: "ready", items });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setMarketplace({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    if (tab === "marketplace") void fetchMarketplace(false);
  }, [tab, fetchMarketplace]);

  // Abort any in-flight fetch when the settings panel unmounts so a slow
  // request can't write to a torn-down component.
  useEffect(() => () => marketplaceAbortRef.current?.abort(), []);

  /** Dedup against installed by GitHub repo slug, lowercased - the catalog
   *  `id` (`discord-rich-presence`) doesn't match the installed manifest id
   *  (`tedi.discord-rich-presence`), but the repo slug both sides reference
   *  is the same. `source` is `github:owner/repo` for github installs, `zip:`
   *  for local zips (which we ignore for dedup since they could be unrelated
   *  forks). Set lookup keeps the filter O(n_market). */
  const installedSlugs = useMemo(() => {
    const set = new Set<string>();
    for (const e of list) {
      if (e.source.startsWith("github:")) {
        set.add(e.source.slice("github:".length).toLowerCase());
      }
    }
    return set;
  }, [list]);
  const availableItems = useMemo(
    () =>
      marketplace.status === "ready"
        ? marketplace.items.filter((item) => !installedSlugs.has(item.repoSlug.toLowerCase()))
        : [],
    [marketplace, installedSlugs],
  );

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

      // If this id is already installed, this is an update / re-install:
      // pass the previously-approved permissions so the dialog can highlight
      // what's NEW and the user re-approves any escalation.
      const installed = list.find((e) => e.id === parsed.manifest.id);
      setPending({
        source,
        preview: {
          status: "ready",
          sourceLabel,
          manifest: parsed.manifest,
          iconUrl,
          priorApproved: installed ? installed.approved_permissions : null,
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
      // Pass the exact permission set the user just approved so Rust can refuse
      // a package that requests more than the dialog showed (the GitHub peek
      // reads the manifest from raw content, not the release zip).
      const approvedPermissions =
        pending.preview.status === "ready" ? pending.preview.manifest.permissions : undefined;
      const ext = await install(pending.source, expectedId, approvedPermissions);
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

  // Per-card "Update". Peeks the latest release first: if it requests
  // permissions the user hasn't already approved, route through the review
  // dialog (which highlights the new permissions) so the user re-approves the
  // escalation. Otherwise update directly - routine updates stay one-click.
  const handleCardUpdate = async (ext: InstalledExtension) => {
    const repo = ext.source.startsWith("github:") ? ext.source.slice("github:".length) : null;
    if (!repo) {
      // Local-zip installs can't auto-update; updateOne surfaces the guidance toast.
      await updateOne(ext, updateExtension);
      return;
    }
    try {
      const raw = await invoke<RawPeek>("ext_peek_github", { repo });
      const parsed = safeParseManifest(raw.manifest);
      const requested = parsed.ok ? parsed.manifest.permissions : [];
      const newPerms = requested.filter((p) => !ext.approved_permissions.includes(p));
      if (newPerms.length > 0) {
        await startReview({ kind: "github", repo }, `${ext.manifest.name} · ${repo} (update)`);
        return;
      }
    } catch {
      // Peek failed (network/repo). Fall through to the direct update, which
      // surfaces the same error through its own toast.
    }
    await updateOne(ext, updateExtension);
  };

  const onCheckAll = async () => {
    setCheckingAll(true);
    try {
      const { failed } = await checkAllUpdates();
      const updated = useExtensionsStore.getState().list;
      const ready = updated.filter((e) => e.latest_version && e.latest_version !== e.version);
      if (ready.length > 0) {
        toast(`${ready.length} update${ready.length === 1 ? "" : "s"} available`, {
          variant: "info",
        });
      } else if (failed > 0) {
        // Don't claim "up to date" when checks actually failed (network or the
        // GitHub 60-req/h anonymous rate limit) - that reads as "nothing to do"
        // when the truth is "couldn't tell".
        toast(
          `Couldn't check ${failed} extension${failed === 1 ? "" : "s"} for updates ` +
            `(network error or GitHub rate limit). Set TEDI_GITHUB_TOKEN to raise the limit.`,
          { variant: "warning" },
        );
      } else {
        toast("All extensions are up to date", { variant: "success" });
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

      <SettingsAccordion
        title="Install extension"
        description="Add an extension from a packaged file, a GitHub release, or the marketplace."
        summary="From file · GitHub · Marketplace"
      >
        <div className="flex flex-col gap-3">
          <div className="flex gap-1">
            {(["zip", "github", "marketplace"] as InstallTab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={cn(
                  "h-7 rounded-md px-2.5 text-[11.5px] font-medium transition",
                  tab === t
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50",
                )}
                type="button"
              >
                {t === "zip" ? "From file" : t === "github" ? "From GitHub" : "Marketplace"}
              </button>
            ))}
          </div>

          {tab === "zip" ? (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground flex-1 text-[11px]">
                Pick a packaged extension `.zip`. Re-installing the same id replaces the existing
                copy (so this is also how local zips upgrade).
              </span>
              <UploadButton onClick={() => void pickZip()}>Choose .zip…</UploadButton>
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
                className="h-8 px-2 text-[11px]"
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

          {tab === "marketplace" ? (
            <MarketplacePanel
              state={marketplace}
              items={availableItems}
              onRefresh={() => void fetchMarketplace(true)}
              onInstall={(item) =>
                void startReview(
                  { kind: "github", repo: item.repoSlug },
                  `${item.name} · ${item.repoSlug} (marketplace)`,
                )
              }
            />
          ) : null}

          {installError ? <div className="text-destructive text-[11px]">{installError}</div> : null}
          {lastError && !installError ? (
            <div className="text-destructive text-[11px]">{lastError}</div>
          ) : null}
        </div>
      </SettingsAccordion>

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
              className="h-8 px-2 text-[11px]"
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
          <span className="text-muted-foreground text-[11px]">No extensions installed yet.</span>
        ) : (
          sorted.map((ext) => (
            <ExtensionCard
              key={ext.id}
              ext={ext}
              updating={updatingIds.has(ext.id)}
              onToggle={(next) => void setEnabled(ext.id, next)}
              onUninstall={() =>
                void uninstall(ext.id).then(() => toast(`Uninstalled ${ext.manifest.name}`))
              }
              onCheckUpdate={() => void checkSingleUpdate(ext, checkUpdate)}
              onUpdate={() => void handleCardUpdate(ext)}
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
