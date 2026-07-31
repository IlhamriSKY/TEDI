import { useCallback, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import {
  browserExtInstall,
  browserExtInstallFile,
  browserExtList,
  browserExtRemove,
  browserExtSetEnabled,
  extInstallLabel,
  extInstallPercent,
  type BrowserExt,
  type ExtInstallProgress,
} from "@/modules/browser/lib/extensions";

import { SettingsCard } from "../../components/SettingsCard";

/**
 * Install and manage Chrome / Edge extensions for the embedded browser pane.
 *
 * Generic by design: this card installs, enables, disables, updates and removes
 * *an extension*, and knows nothing about what any of them do or what category
 * they belong to.
 *
 * The browser toolbar's puzzle button does the same things closer to where they
 * are used, and can also open a store listing and an extension's own settings
 * page because it has a pane to open them in. This card is the version with room
 * to explain itself. Both drive the identical `browser_ext_*` commands.
 *
 * Windows only, because the pane is WebView2 there. Rust reports that verdict via
 * `supported` so this component never branches on the platform itself.
 */
export function BrowserExtensionsCard() {
  const [items, setItems] = useState<BrowserExt[]>([]);
  const [supported, setSupported] = useState(true);
  const [dir, setDir] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExtInstallProgress | null>(null);

  const refresh = useCallback(async () => {
    try {
      const info = await browserExtList();
      setSupported(info.supported);
      setDir(info.extensionsDir);
      setItems(info.items);
    } catch (e) {
      setError(String(e));
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Shared by the url field, the file picker and each row's Update, so all
   *  three report progress and failures the same way. */
  const runInstall = useCallback(
    async (install: () => Promise<BrowserExt>, verb: "Installed" | "Updated") => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const done = await install();
        await refresh();
        toast(`${verb} ${done.name} ${done.version}`);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [busy, refresh],
  );

  const onInstallSource = useCallback(async () => {
    const value = source.trim();
    if (!value) return;
    await runInstall(() => browserExtInstall(value, setProgress), "Installed");
    setSource("");
  }, [source, runInstall]);

  const onInstallFile = useCallback(async () => {
    const selected = await openFileDialog({
      multiple: false,
      filters: [{ name: "Browser extension", extensions: ["zip", "crx"] }],
    });
    const path = typeof selected === "string" ? selected : null;
    if (!path) return;
    await runInstall(() => browserExtInstallFile(path), "Installed");
  }, [runInstall]);

  if (hydrated && !supported) {
    return (
      <SettingsCard
        title="Browser extensions"
        description="Run Chrome or Edge extensions inside the browser pane."
      >
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          Only available on Windows, where the browser pane is Chromium (WebView2). macOS uses
          WKWebView, which cannot load extensions at all, and on Linux the equivalent setting
          expects compiled WebKitGTK plugins rather than Chrome extensions.
        </p>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard
      title="Browser extensions"
      description="Any unpacked Chrome or Edge extension can run in the browser pane. Blocking ads is the usual reason to add one, and the extension keeps its own lists up to date rather than TEDI doing it."
      badge={
        items.length > 0 ? (
          <span className="text-muted-foreground text-[11px]">{items.length}</span>
        ) : null
      }
      headerRight={
        dir ? (
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2 text-[11px]"
            onClick={() => void revealItemInDir(dir).catch(console.error)}
          >
            Open folder
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Input
            value={source}
            placeholder="Chrome / Edge store link, owner/repo, or an https:// link to a .zip / .crx"
            spellCheck={false}
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onInstallSource();
            }}
          />
          <Button
            size="sm"
            className="h-9 shrink-0 px-3 text-[11px]"
            disabled={busy || !source.trim()}
            onClick={() => void onInstallSource()}
          >
            {busy ? "Working…" : "Install"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-9 shrink-0 px-3 text-[11px]"
            disabled={busy}
            onClick={() => void onInstallFile()}
          >
            From file…
          </Button>
        </div>

        {/* Both phases are minutes long for a large package, and which one is
            running explains why: fetching, then writing several times as much. */}
        {busy ? (
          <div className="flex flex-col gap-1">
            <div className="text-muted-foreground flex items-center justify-between text-[11px]">
              <span>
                {progress?.phase === "unpack"
                  ? "Unpacking"
                  : progress
                    ? "Downloading"
                    : "Resolving…"}
              </span>
              <span className="tabular-nums">{extInstallLabel(progress)}</span>
            </div>
            <Progress value={extInstallPercent(progress)} className="h-1 rounded-full" />
          </div>
        ) : null}

        {error ? <div className="text-destructive text-[11px] break-words">{error}</div> : null}

        <div className="flex flex-col gap-1.5">
          {!hydrated ? (
            <span className="text-muted-foreground text-[11px]">Loading…</span>
          ) : items.length === 0 ? (
            <span className="text-muted-foreground text-[11px]">Nothing installed yet.</span>
          ) : (
            items.map((ext) => (
              <div
                key={ext.dir}
                className="border-border/60 flex items-center gap-2 rounded border px-2 py-1.5"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[12px]">{ext.name}</span>
                  <span className="text-muted-foreground truncate text-[10.5px]">
                    {ext.version}
                    {ext.source ? ` · ${ext.source}` : ""}
                    {ext.manifest_version === 2 ? " · Manifest V2, Chromium is removing it" : ""}
                  </span>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  {ext.source ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-[11px]"
                      disabled={busy}
                      onClick={() =>
                        void runInstall(() => browserExtInstall(ext.source, setProgress), "Updated")
                      }
                    >
                      Update
                    </Button>
                  ) : null}
                  {/* Spelled out, not just a switch position: a fresh install is
                      already on, and pressing the switch to "activate it" turns
                      it off silently. */}
                  <span
                    className={`w-6 text-right text-[11px] ${
                      ext.enabled ? "text-foreground" : "text-muted-foreground/70"
                    }`}
                  >
                    {ext.enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    checked={ext.enabled}
                    onCheckedChange={(next) => {
                      void browserExtSetEnabled(ext.dir, next)
                        .then(refresh)
                        .catch((e) => setError(String(e)));
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => {
                      void browserExtRemove(ext.dir)
                        .then(refresh)
                        .then(() => toast(`Removed ${ext.name}`))
                        .catch((e) => setError(String(e)));
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        <p className="text-muted-foreground text-[11px] leading-relaxed">
          A Chrome Web Store or Edge Add-ons page link works as-is: the extension is fetched from
          the same endpoint the browser itself uses, so a store listing needs no manual download.
          The two stores do not always carry the same build, so paste the listing you actually want.
          Extensions are attached when a browser tab opens, so changes here apply to tabs you open
          afterwards. Browser tabs also move to their own WebView2 profile once the first extension
          is installed, which keeps extensions out of TEDI&apos;s own window; sites you were signed
          into in a browser tab will ask you to sign in again. Extension popups and toolbar buttons
          have nowhere to appear in a webview, so open an extension&apos;s own dashboard page in a
          browser tab to configure it.
        </p>
      </div>
    </SettingsCard>
  );
}
