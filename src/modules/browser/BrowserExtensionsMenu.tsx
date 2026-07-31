import { useCallback, useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Download, Puzzle, Settings, Store, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import {
  browserExtInstall,
  browserExtInstallFile,
  browserExtList,
  browserExtRemove,
  browserExtSetEnabled,
  extInstallLabel,
  extInstallPercent,
  previewEmbedLoadedExts,
  storeExtensionId,
  CHROME_WEB_STORE_URL,
  type BrowserExt,
  type ExtInstallProgress,
  type LoadedExt,
} from "./lib/extensions";

/** Normalized for matching an installed folder against what the engine loaded.
 *  Both sides read the same manifest name, but one goes through the engine's own
 *  localization and the other through ours, so compare loosely. */
function key(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

type Props = {
  /** Leaf id of the pane this menu belongs to: the engine's extension list is
   *  read through it, and store / settings pages open in it. */
  paneId: number;
  /** The address the pane is currently on, so a store listing can offer itself. */
  url: string;
  onNavigate: (url: string) => void;
};

/**
 * The browser toolbar's extensions button: install any Chrome or Edge
 * extension, see what is installed, switch each one on or off, open its settings
 * and remove it - the puzzle-piece menu every browser puts here.
 *
 * Nothing here is about ad blocking, or about any other category. It installs
 * *an extension*, from the store, from a GitHub release, or from a file, and it
 * knows nothing about what any of them do.
 *
 * Two things a normal browser has that a webview cannot: a toolbar popup, and a
 * store page with an install button wired into the browser. The first is gone
 * for good - there is nowhere to put it - which is why the settings action here
 * matters so much, since an extension whose real behaviour sits behind a
 * first-run or a mode switch is otherwise stuck on defaults forever. The second
 * is replaced by noticing when the pane is looking at a listing and offering to
 * install that.
 *
 * Hidden entirely off Windows, where the pane's engine cannot load Chrome
 * extensions at all (Rust reports that verdict, so this never checks the
 * platform itself).
 */
export function BrowserExtensionsMenu({ paneId, url, onNavigate }: Props) {
  const [items, setItems] = useState<BrowserExt[]>([]);
  const [loaded, setLoaded] = useState<LoadedExt[]>([]);
  const [supported, setSupported] = useState(false);
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExtInstallProgress | null>(null);

  const refresh = useCallback(async () => {
    try {
      const info = await browserExtList();
      setSupported(info.supported);
      setItems(info.items);
    } catch (e) {
      setError(String(e));
    }
    // Best effort and deliberately not fatal: the pane may have no webview yet,
    // and everything except the settings action works without this.
    try {
      setLoaded(await previewEmbedLoadedExts(paneId));
    } catch {
      setLoaded([]);
    }
  }, [paneId]);

  // One cheap directory read on mount, so the button knows whether to render at
  // all and the dot can report "something is on" without opening the menu.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Every mutating action, so all of them report progress + failure the same
   *  way and none of them can overlap another. */
  const run = useCallback(
    async (op: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await op();
        await refresh();
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [busy, refresh],
  );

  const install = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      await run(() => browserExtInstall(trimmed, setProgress));
      setSource("");
    },
    [run],
  );

  const installFile = useCallback(async () => {
    const picked = await openFileDialog({
      multiple: false,
      filters: [{ name: "Browser extension", extensions: ["zip", "crx"] }],
    });
    if (typeof picked !== "string") return;
    await run(() => browserExtInstallFile(picked));
  }, [run]);

  if (!supported) return null;

  const anyEnabled = items.some((e) => e.enabled);
  // The pane is looking at a store listing, so offer that one directly.
  const viewing = storeExtensionId(url);
  const already = viewing !== null && loaded.some((l) => l.id === viewing);

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) void refresh();
        else setError(null);
      }}
    >
      <IconTooltip label="Extensions" side="top">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Extensions"
            className={`text-muted-foreground ${TOOLBAR_HOVER} relative size-7 shrink-0 rounded-md`}
          >
            <Puzzle size={14} strokeWidth={1.75} />
            {anyEnabled ? (
              <span className="bg-primary absolute right-1 bottom-1 size-1.5 rounded-full" />
            ) : null}
          </Button>
        </PopoverTrigger>
      </IconTooltip>
      <PopoverContent align="end" className="w-80 gap-2.5 rounded-xl p-3">
        {/* The browser's own "Add to Chrome": when the pane is on a listing, the
            thing you are looking at is one click away. */}
        {viewing ? (
          <Button
            size="sm"
            className="h-8 w-full gap-1.5 text-[11px]"
            disabled={busy || already}
            onClick={() => void install(url)}
          >
            <Download size={13} strokeWidth={2} />
            {already ? "Already installed" : "Install this extension"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-full gap-1.5 text-[11px]"
            onClick={() => onNavigate(CHROME_WEB_STORE_URL)}
          >
            <Store size={13} strokeWidth={2} />
            Browse the Chrome Web Store
          </Button>
        )}

        <div className="flex gap-1.5">
          <Input
            value={source}
            placeholder="Store link, owner/repo, or .zip / .crx"
            spellCheck={false}
            className="h-7 text-xs"
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void install(source);
            }}
          />
          <Button
            size="sm"
            className="h-7 shrink-0 px-2 text-[11px]"
            disabled={busy || !source.trim()}
            onClick={() => void install(source)}
          >
            {/* Store packages are tens of MB and then unpack to hundreds, so this
                label is on screen for a while. "…" reads as a hang. */}
            {busy ? "Working…" : "Install"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 shrink-0 px-2 text-[11px]"
            disabled={busy}
            onClick={() => void installFile()}
          >
            File…
          </Button>
        </div>

        {/* Both phases are minutes long for a big package, and which one is
            running explains why: fetching, then writing several times as much. */}
        {busy ? (
          <div className="flex flex-col gap-1">
            <div className="text-muted-foreground flex items-center justify-between text-[10.5px]">
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

        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {items.length === 0 ? (
            <span className="text-muted-foreground text-[11px]">Nothing installed yet.</span>
          ) : (
            items.map((ext) => {
              const live = loaded.find((l) => key(l.name) === key(ext.name));
              return (
                <div key={ext.dir} className="flex items-center gap-2">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12px]">{ext.name}</span>
                    {/* Deliberately allowed to wrap. The not-loaded line is the
                        one thing in this row someone has to act on, and it is
                        also what explains the missing settings button, so
                        truncating it turned a instruction into a dead end. */}
                    <span
                      className={`text-[10px] ${
                        ext.enabled && !live
                          ? "text-icon-working"
                          : "text-muted-foreground truncate"
                      }`}
                    >
                      {ext.enabled && !live
                        ? "Not loaded yet — open a new browser tab"
                        : ext.version}
                    </span>
                  </div>
                  <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {/* The only way to configure an extension here: a browser
                        would use the toolbar popup, which has nowhere to appear
                        over a webview. */}
                    {live && ext.optionsPage ? (
                      <IconTooltip label={`${ext.name} settings`} side="top">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`${ext.name} settings`}
                          className={`text-muted-foreground ${TOOLBAR_HOVER} size-6 rounded-md`}
                          onClick={() =>
                            onNavigate(`chrome-extension://${live.id}/${ext.optionsPage}`)
                          }
                        >
                          <Settings size={13} strokeWidth={1.75} />
                        </Button>
                      </IconTooltip>
                    ) : null}
                    {/* Spelled out, not just a switch position. A fresh install is
                        already on, and without a word for it the natural move is
                        to press the switch to "activate it" - which turns it off,
                        silently, and then nothing works. */}
                    <span
                      className={`w-6 text-right text-[10px] ${
                        ext.enabled ? "text-foreground" : "text-muted-foreground/70"
                      }`}
                    >
                      {ext.enabled ? "On" : "Off"}
                    </span>
                    <Switch
                      checked={ext.enabled}
                      disabled={busy}
                      onCheckedChange={(next) =>
                        void run(() => browserExtSetEnabled(ext.dir, next))
                      }
                    />
                    <IconTooltip label={`Remove ${ext.name}`} side="top">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${ext.name}`}
                        disabled={busy}
                        className={`text-muted-foreground ${TOOLBAR_HOVER} size-6 rounded-md`}
                        onClick={() => void run(() => browserExtRemove(ext.dir))}
                      >
                        <X size={13} strokeWidth={2} />
                      </Button>
                    </IconTooltip>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <p className="text-muted-foreground text-[10.5px]">
          Extensions attach when a browser tab opens, so open a new tab after changing this.
        </p>
      </PopoverContent>
    </Popover>
  );
}
