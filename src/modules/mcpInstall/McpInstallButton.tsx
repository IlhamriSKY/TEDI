/**
 * Header button that wires TEDI's MCP server into the AI CLIs on this machine,
 * and shows at a glance whether the DevTools port is open as well.
 *
 * MCP itself needs no port and no restart: every tool, the real-input and
 * screenshot ones included, reaches TEDI through the authenticated local bridge
 * (`mcp_bridge.rs`, `mcp_devtools.rs`), which is always on. So installing turns
 * nothing else on, and an installed server is ready - green.
 *
 * The automation channel is a separate, optional thing: a DevTools port with no
 * authentication, for tooling outside MCP. Anything already running as this user
 * can drive the window through it, and it keeps renderer flags on that cost
 * memory and CPU for as long as TEDI runs. A session where that is ON must never
 * look like one where it is off, so the dot turns amber while the port is open -
 * and switching it off is the action amber is asking for.
 */
import { IconSwap } from "@/components/IconMorph";
import { useCallback, useEffect, useState } from "react";
import { Plug, PlugZap, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { TOOLBAR_HOVER } from "@/lib/toolbarButton";
import {
  getAutomationPort,
  getMcpSurface,
  setAutomationPort,
  setMcpSurface,
} from "@/modules/settings/store";
import { listExtensions } from "@/modules/extensions/store";
import { disabledToolsFor, MCP_PACKS } from "./packs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DEFAULT_PORT, detect, install, uninstall, type Scope, type TargetStatus } from "./install";

/** True when THIS session was started with the automation channel open. Set by
 *  the Rust init script; see `src-tauri/src/modules/automation.rs`. */
const channelLive = (): boolean =>
  (window as unknown as { __TEDI_AUTOMATION__?: boolean }).__TEDI_AUTOMATION__ === true;

/** The last user-picked folder, only a FALLBACK now. The live open folder comes
 *  in as `projectRoot` (the focused terminal's cwd), so a per-project config
 *  lands in the folder you are actually working in, not one you opened days ago -
 *  which is the whole point of the "This project" scope. */
function pickedRoot(): string | null {
  try {
    return localStorage.getItem("tedi.workspaceRoot");
  } catch {
    return null;
  }
}

/** The folder name to show for the project scope. */
function folderName(root: string | null): string {
  if (!root) return "";
  return root.replace(/\/+$/, "").split("/").pop() || root;
}

export function McpInstallButton({ projectRoot }: { projectRoot: string | null }) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<Scope>("global");
  const [rows, setRows] = useState<TargetStatus[] | null>(null);
  const [port, setPort] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);

  /** The folder a project-scoped config is written into: the focused terminal's
   *  cwd, falling back to the last picked root. */
  const root = projectRoot ?? pickedRoot();

  /** What is switched OFF, so anything added later is on without a visit here. */
  const [offPacks, setOffPacks] = useState<string[]>([]);
  const [offExts, setOffExts] = useState<string[]>([]);
  /** Extensions that are installed, ENABLED and have something to reach. A disabled
   *  one has nothing live to switch: deactivation clears its registry entries. */
  const [exts, setExts] = useState<{ id: string; name: string; summary: string }[]>([]);

  const refresh = useCallback(async () => {
    const [cli, storedPort, surfaceCfg] = await Promise.all([
      detect(scope, root),
      getAutomationPort(),
      getMcpSurface(),
    ]);
    setRows(cli);
    setPort(storedPort);
    setOffExts(surfaceCfg.disabledExtensions);
    // Stored as tool names; mapped back to pack ids so the switches reflect it.
    const off = new Set(surfaceCfg.disabledTools);
    setOffPacks(
      MCP_PACKS.filter((p) => !p.always && p.tools.every((t) => off.has(t))).map((p) => p.id),
    );
    // `listExtensions` reads the RUNTIME registry, so a tool count is what each one
    // really registers, not what its manifest claims.
    setExts(
      listExtensions()
        .filter((e) => e.enabled && e.aiTools.length + e.commands.length + e.panels.length > 0)
        .map((e) => ({
          id: e.id,
          name: e.name,
          summary: [
            e.aiTools.length && `${e.aiTools.length} AI tool${e.aiTools.length === 1 ? "" : "s"}`,
            e.commands.length &&
              `${e.commands.length} command${e.commands.length === 1 ? "" : "s"}`,
            e.panels.length && `${e.panels.length} panel${e.panels.length === 1 ? "" : "s"}`,
          ]
            .filter(Boolean)
            .join(", "),
        }))
        .sort((x, y) => x.name.localeCompare(y.name)),
    );
  }, [scope, root]);

  const writeSurface = useCallback(async (nextOff: string[], nextExts: string[]) => {
    setOffPacks(nextOff);
    setOffExts(nextExts);
    await setMcpSurface({ disabledTools: disabledToolsFor(nextOff), disabledExtensions: nextExts });
    toast("Saved. It applies from the next call, with nothing to restart.", { variant: "default" });
  }, []);

  // Once on mount for the indicator, and again whenever the dialog opens - a
  // config can be edited by hand, or by another TEDI window, between the two.
  useEffect(() => {
    void refresh().catch(() => setRows([]));
  }, [refresh, open]);

  /**
   * How much of the surface is switched on, as a plain count of packs.
   *
   * A count, not a token estimate: what this dialog chooses is which
   * capabilities to expose, and a figure that looks precise but is a guess
   * invites a decision it cannot support. The measured per-request cost is
   * printed by `scripts/ai/tool-budget-verify.ts`, which serializes the real
   * schemas.
   */
  const onPacks = MCP_PACKS.filter((p) => p.always || !offPacks.includes(p.id));
  const onCount = onPacks.length + exts.filter((e) => !offExts.includes(e.id)).length;
  const totalCount = MCP_PACKS.length + exts.length;

  const installed = (rows ?? []).some((r) => r.installed);
  const live = channelLive();

  const toggle = useCallback(
    async (row: TargetStatus, next: boolean) => {
      setBusy(row.id);
      try {
        await (next ? install(row, scope, root) : uninstall(row, scope, root));
        // No port is switched on here any more: the bridge carries every tool,
        // so the config works the moment it is written, with no restart.
        await refresh();
        toast(next ? `${row.name}: MCP installed` : `${row.name}: MCP removed`, {
          variant: "success",
        });
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), { variant: "error" });
      } finally {
        setBusy(null);
      }
    },
    [refresh, scope, root],
  );

  /** One click to wire every found CLI in the current scope. Skips the ones
   *  already installed and the ones not present, and reports how many it did. */
  const enableAll = useCallback(async () => {
    const targets = (rows ?? []).filter((r) => r.present && !r.installed);
    if (targets.length === 0) return;
    setBusy("all");
    try {
      for (const row of targets) await install(row, scope, root);
      await refresh();
      toast(`MCP installed for ${targets.length} CLI${targets.length === 1 ? "" : "s"}`, {
        variant: "success",
      });
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), { variant: "error" });
    } finally {
      setBusy(null);
    }
  }, [rows, scope, root, refresh]);

  const setChannel = useCallback(async (on: boolean) => {
    await setAutomationPort(on ? DEFAULT_PORT : 0);
    setPort(on ? DEFAULT_PORT : 0);
    toast(
      on
        ? "Automation channel on - restart TEDI to open it"
        : "Automation channel off after restart",
      { variant: "default" },
    );
  }, []);

  return (
    <>
      <IconTooltip
        label={
          installed
            ? live
              ? `MCP installed - the DevTools port ${port || DEFAULT_PORT} is also open`
              : "MCP installed and ready"
            : "Install MCP"
        }
      >
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "text-muted-foreground relative",
            TOOLBAR_HOVER,
            "size-7 shrink-0 rounded-md",
          )}
          onClick={() => setOpen(true)}
          aria-label="Install MCP"
        >
          <IconSwap
            active={installed ? 0 : 1}
            icons={[
              <PlugZap size={16} strokeWidth={1.75} />,
              <Plug size={16} strokeWidth={1.75} />,
            ]}
          />
          {installed && (
            <span
              // `ring-card` so the dot reads as separate from the glyph on the
              // header's own background rather than merging into the stroke.
              // Theme tokens, never a fixed Tailwind hue: a hard-coded green
              // reads the same in a warm preset and a monochrome one, which is
              // how the usage meter once shipped fixed bars into twenty themes.
              // `diff-added` is the documented success colour; `icon-blocked` is
              // "awaiting an action", which switching an open port off is.
              // (`theme-verify` greps this file's TEXT, comments included.)
              className={cn(
                "ring-card absolute right-0.5 bottom-0.5 size-1.5 rounded-full ring-2",
                live ? "bg-icon-blocked" : "bg-diff-added",
              )}
              aria-hidden
            />
          )}
        </Button>
      </IconTooltip>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Control TEDI from your AI CLI</DialogTitle>
            <DialogDescription>
              Registers TEDI&rsquo;s MCP server, which tells an agent about the <code>tedi</code>{" "}
              command so it can read and drive your panes, terminals, editors, settings and
              extensions. Only CLIs found on this machine are listed.
            </DialogDescription>
          </DialogHeader>

          {/* THE SCROLL CONTAINER. `DialogContent` is `flex flex-col` with
              `max-h-[calc(100dvh-2rem)]` AND `overflow-hidden`, so anything past
              that cap is clipped with nothing to scroll - which is exactly what
              expanding the pack accordion did. Header and footer stay put; this
              is the part that gives. `min-h-0` is load-bearing: without it a
              flex child refuses to shrink below its content and the overflow
              never engages. The negative margin + padding keep the switches'
              focus rings from being cropped by the scroll edge. */}
          <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto px-1">
            {/* Scope: write to each CLI's user-wide config, or to its own
                project-scoped file inside the OPEN FOLDER (the focused terminal's
                cwd). Two buttons rather than a Switch because neither side is a
                default-off "extra" - they are two equal destinations, and a
                Switch would imply one is the on-state of the other. */}
            <div className="flex items-center justify-between gap-3">
              {/* The Settings window's segmented recipe, class for class (see
                  ThemeSection's light/dark switch): a `bg-muted/40` track, `h-6`
                  triggers, `bg-background` for the active one. No radius, because
                  the app force-zeroes it and a `rounded` here would just read as
                  a mistake. */}
              <div className="bg-muted/40 inline-flex h-7 shrink-0 items-center p-0.5 text-[11px]">
                {(["global", "project"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setScope(s)}
                    aria-pressed={scope === s}
                    className={cn(
                      "h-6 px-2.5 transition-colors",
                      scope === s
                        ? "bg-background text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {s === "global" ? "Global" : "This project"}
                  </button>
                ))}
              </div>
              {/* Names the folder a project config lands in, so "This project" is
                  never mistaken for global - the bug the old single row had. */}
              <span className="text-muted-foreground min-w-0 truncate text-xs" title={root ?? ""}>
                {scope === "global"
                  ? "User-wide, every session"
                  : root
                    ? folderName(root)
                    : "No folder open"}
              </span>
            </div>

            <div className="flex flex-col gap-1">
              {rows === null && (
                <div className="text-muted-foreground flex items-center gap-2 py-4 text-sm">
                  <Spinner className="size-4" /> Looking for AI CLIs&hellip;
                </div>
              )}
              {scope === "project" && !root ? (
                <p className="text-muted-foreground px-2 py-4 text-sm">
                  Open a folder (its terminal) to write a project-scoped config there. Each CLI gets
                  its own standard file - <code className="text-foreground">.mcp.json</code>,{" "}
                  <code className="text-foreground">.cursor/mcp.json</code>, and so on.
                </p>
              ) : (
                <>
                  {(rows ?? []).some((r) => r.present && !r.installed) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 self-end text-xs"
                      onClick={() => void enableAll()}
                      disabled={busy !== null}
                    >
                      Enable all found
                    </Button>
                  )}
                  {rows?.map((row) => (
                    <label
                      key={row.id}
                      className={cn(
                        "flex items-center justify-between gap-3 rounded-md px-2 py-2",
                        row.present ? "hover:bg-accent/50" : "opacity-45",
                      )}
                    >
                      <span className="min-w-0">
                        <span className="text-sm">{row.name}</span>
                        {/* The full path on hover: the row truncates from the right,
                        which is exactly the end that says WHICH file this is. */}
                        <span
                          className="text-muted-foreground block truncate text-xs"
                          title={row.present ? row.path : undefined}
                        >
                          {row.present ? row.path : "not installed"}
                        </span>
                      </span>
                      {busy === row.id ? (
                        <Spinner className="size-4 shrink-0" />
                      ) : (
                        <Switch
                          checked={row.installed}
                          disabled={!row.present}
                          onCheckedChange={(next) => void toggle(row, next)}
                          aria-label={`${row.installed ? "Remove" : "Install"} MCP for ${row.name}`}
                        />
                      )}
                    </label>
                  ))}
                  {rows?.length === 0 && (
                    <p className="text-muted-foreground py-4 text-sm">
                      No supported AI CLI found. Point any MCP client at{" "}
                      <code className="text-foreground">tedi mcp</code>.
                    </p>
                  )}
                </>
              )}
            </div>

            {/* What an agent may reach. Off means refused, by the app itself. */}
            <details className="border-border/60 rounded-md border">
              <summary className="hover:bg-accent/40 cursor-pointer px-3 py-2 text-sm">
                What agents can reach
                <span className="text-muted-foreground ml-1.5 text-xs tabular-nums">
                  {onCount} of {totalCount} on
                </span>
              </summary>
              <div className="border-border/60 flex flex-col gap-0.5 border-t px-1 py-1">
                {MCP_PACKS.map((p) => (
                  <label
                    key={p.id}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded px-2 py-1.5",
                      p.always ? "opacity-60" : "hover:bg-accent/40",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="text-[13px]">{p.name}</span>
                      <span className="text-muted-foreground block text-[11px]">{p.hint}</span>
                    </span>
                    <Switch
                      // A pack with no static tools has nothing to switch: the
                      // Extensions category is populated per-extension below and
                      // the AI one is not built yet. A live-looking switch that
                      // turns nothing off would be the lie.
                      checked={p.tools.length > 0 && (p.always || !offPacks.includes(p.id))}
                      disabled={p.always || p.tools.length === 0}
                      aria-label={p.name}
                      onCheckedChange={(on) =>
                        void writeSurface(
                          on ? offPacks.filter((x) => x !== p.id) : [...offPacks, p.id],
                          offExts,
                        )
                      }
                    />
                  </label>
                ))}

                {exts.length > 0 && (
                  <>
                    <span className="text-muted-foreground mt-1 px-2 text-[10px] tracking-wide uppercase">
                      Extensions
                    </span>
                    {exts.map((e) => (
                      <label
                        key={e.id}
                        className="hover:bg-accent/40 flex items-center justify-between gap-3 rounded px-2 py-1.5"
                      >
                        <span className="min-w-0">
                          <span className="text-[13px]">{e.name}</span>
                          <span className="text-muted-foreground block text-[11px]">
                            {e.summary}
                          </span>
                        </span>
                        <Switch
                          checked={!offExts.includes(e.id)}
                          aria-label={e.name}
                          onCheckedChange={(on) =>
                            void writeSurface(
                              offPacks,
                              on ? offExts.filter((x) => x !== e.id) : [...offExts, e.id],
                            )
                          }
                        />
                      </label>
                    ))}
                  </>
                )}
              </div>
            </details>

            <div className="border-border/60 flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <span className="min-w-0">
                <span className="text-sm">Automation channel</span>
                <span className="text-muted-foreground block text-xs">
                  {live
                    ? `Open on port ${port || DEFAULT_PORT}. Anything running as you can drive this window, and it keeps TEDI heavier. MCP does not need it.`
                    : port
                      ? `Opens on port ${port} after a restart. MCP does not need it.`
                      : "Off, and it should stay off. MCP and the tedi command work without it. It only serves DevTools tools outside TEDI."}
                </span>
              </span>
              <Switch
                checked={port > 0}
                onCheckedChange={(on) => void setChannel(on)}
                aria-label="Automation channel"
              />
            </div>
          </div>

          <DialogFooter className="sm:justify-between">
            <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
              {port > 0 && !live && (
                <>
                  <RotateCw size={12} /> Restart TEDI to open the port.
                </>
              )}
              {port === 0 && live && (
                <>
                  <RotateCw size={12} /> Restart TEDI to close the port.
                </>
              )}
            </span>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
