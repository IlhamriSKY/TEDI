/**
 * Header button that wires TEDI's MCP server into the AI CLIs on this machine,
 * and shows at a glance whether the channel is actually live.
 *
 * The indicator dot is the point of putting this in the header at all. The
 * automation channel opens a DevTools port with no authentication - anything
 * already running as this user can drive the window - so a session where that is
 * ON must never look like a session where it is off. Amber is the other half of
 * the same honesty: the config is written but WebView2 fixes its browser
 * arguments when it creates its environment, so nothing is listening until TEDI
 * restarts, and a green light there would be a lie.
 */
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
import { disabledToolsFor, MCP_EXTENSION_ALLOWLIST, MCP_PACKS } from "./packs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DEFAULT_PORT,
  detect,
  install,
  installProject,
  projectStatus,
  serverPath,
  uninstall,
  uninstallProject,
  type TargetStatus,
} from "./install";

/** True when THIS session was started with the automation channel open. Set by
 *  the Rust init script; see `src-tauri/src/modules/automation.rs`. */
const channelLive = (): boolean =>
  (window as unknown as { __TEDI_AUTOMATION__?: boolean }).__TEDI_AUTOMATION__ === true;

/** The folder the explorer is rooted at. Read from the same localStorage key
 *  `useWorkspaceRoot` seeds itself from, rather than threading a prop through
 *  App and the whole Header for one optional row. */
function pickedRoot(): string | null {
  try {
    return localStorage.getItem("tedi.workspaceRoot");
  } catch {
    return null;
  }
}

export function McpInstallButton() {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<TargetStatus[] | null>(null);
  const [port, setPort] = useState(0);
  const [server, setServer] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  /** Pack ids switched OFF, and extension ids switched ON. Stored that way round
   *  so a pack added later is on by default and a new extension is not. */
  const [offPacks, setOffPacks] = useState<string[]>([]);
  const [onExts, setOnExts] = useState<string[]>([]);
  /** Only extensions that are installed, ENABLED, and really register AI tools.
   *  Anything else would be a switch the server cannot honour. */
  const [exts, setExts] = useState<{ id: string; name: string; tools: number; usable: boolean }[]>(
    [],
  );

  const refresh = useCallback(async () => {
    const root = pickedRoot();
    const [cli, project, storedPort, path, surfaceCfg] = await Promise.all([
      detect(),
      root ? projectStatus(root) : Promise.resolve(null),
      getAutomationPort(),
      serverPath(),
      getMcpSurface(),
    ]);
    setRows(project ? [...cli, project] : cli);
    setPort(storedPort);
    setServer(path);
    setOnExts(surfaceCfg.extensions);
    // Stored as tool names; mapped back to pack ids so the switches reflect it.
    const off = new Set(surfaceCfg.disabledTools);
    setOffPacks(
      MCP_PACKS.filter((p) => !p.always && p.tools.every((t) => off.has(t))).map((p) => p.id),
    );
    // The ALLOW-LIST, not "everything that registers a tool". Advertising an
    // extension costs tokens on every request, so only the two an agent really
    // drives are offered; the rest stay reachable through `run_command`.
    // `listExtensions` reads the RUNTIME registry, so the count is what each
    // one really registers, not what its manifest claims.
    const live = listExtensions();
    setExts(
      MCP_EXTENSION_ALLOWLIST.map(({ id, label }) => {
        const found = live.find((e) => e.id === id);
        return {
          id,
          name: label,
          tools: found?.aiTools.length ?? 0,
          // INSTALLED AND ENABLED, and it really has tools. All three, because
          // each fails differently: not installed = nothing to switch;
          // disabled = deactivation CLEARS its runtime registry entries, so it
          // would advertise tools that answer nothing; zero tools = a switch
          // that turns nothing on. A row for any of those is a promise the
          // server cannot keep.
          usable: Boolean(found?.enabled) && (found?.aiTools.length ?? 0) > 0,
        };
      }).filter((e) => e.usable),
    );
  }, []);

  const writeSurface = useCallback(async (nextOff: string[], nextExts: string[]) => {
    setOffPacks(nextOff);
    setOnExts(nextExts);
    await setMcpSurface({ disabledTools: disabledToolsFor(nextOff), extensions: nextExts });
    toast("MCP surface saved - TEDI's own agent already has it; reconnect your AI CLI", {
      variant: "default",
    });
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
  const onCount = onPacks.length + exts.filter((e) => onExts.includes(e.id)).length;
  const totalCount = MCP_PACKS.length + exts.length;

  const installed = (rows ?? []).some((r) => r.installed);
  const live = channelLive();

  const toggle = useCallback(
    async (row: TargetStatus, next: boolean) => {
      setBusy(row.id);
      try {
        if (row.id === "project") {
          const root = pickedRoot();
          if (!root) throw new Error("No folder is open.");
          await (next ? installProject(root, port || DEFAULT_PORT) : uninstallProject(root));
        } else {
          await (next ? install(row, port || DEFAULT_PORT) : uninstall(row));
        }
        // Writing a config is only half of it: with the channel off, that config
        // points at a port nothing is listening on. Turning it on here is what
        // makes one click enough - it takes effect on the next launch.
        if (next && !port) await setAutomationPort(DEFAULT_PORT);
        await refresh();
        toast(
          next
            ? `${row.name}: MCP installed${live ? "" : " - restart TEDI to open the channel"}`
            : `${row.name}: MCP removed`,
          { variant: next && !live ? "default" : "success" },
        );
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), { variant: "error" });
      } finally {
        setBusy(null);
      }
    },
    [port, live, refresh],
  );

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
              ? "MCP installed and running"
              : "MCP installed - restart TEDI to open the channel"
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
          {installed && live ? (
            <PlugZap size={16} strokeWidth={1.75} />
          ) : (
            <Plug size={16} strokeWidth={1.75} />
          )}
          {installed && (
            <span
              // `ring-card` so the dot reads as separate from the glyph on the
              // header's own background rather than merging into the stroke.
              // Theme tokens, never a fixed Tailwind hue: a hard-coded green
              // reads the same in a warm preset and a monochrome one, which is
              // how the usage meter once shipped fixed bars into twenty themes.
              // `diff-added` is the documented success colour; `icon-blocked` is
              // "awaiting an action", which a pending restart is.
              // (`theme-verify` greps this file's TEXT, comments included.)
              className={cn(
                "ring-card absolute right-0.5 bottom-0.5 size-1.5 rounded-full ring-2",
                live ? "bg-diff-added" : "bg-icon-blocked",
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
              Registers TEDI&rsquo;s MCP server so an agent can read your panes, terminals, editors,
              settings and extensions, and drive them. Only CLIs found on this machine are listed.
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
            <div className="flex flex-col gap-1">
              {rows === null && (
                <div className="text-muted-foreground flex items-center gap-2 py-4 text-sm">
                  <Spinner className="size-4" /> Looking for AI CLIs&hellip;
                </div>
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
                  <code className="text-foreground">node {server}</code>.
                </p>
              )}
            </div>

            {/* What the server advertises. The tool list is loaded into EVERY
              request of a connected CLI for the whole session, so this is a
              standing bill and the user is the one who should size it. */}
            <details className="border-border/60 rounded-md border">
              <summary className="hover:bg-accent/40 cursor-pointer px-3 py-2 text-sm">
                What the MCP exposes
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
                          onExts,
                        )
                      }
                    />
                  </label>
                ))}

                {exts.length > 0 && (
                  <>
                    <span className="text-muted-foreground mt-1 px-2 text-[10px] tracking-wide uppercase">
                      Extension packs
                    </span>
                    {exts.map((e) => (
                      <label
                        key={e.id}
                        className="hover:bg-accent/40 flex items-center justify-between gap-3 rounded px-2 py-1.5"
                      >
                        <span className="min-w-0">
                          <span className="text-[13px]">{e.name}</span>
                          <span className="text-muted-foreground block text-[11px]">
                            {e.tools} AI tool{e.tools === 1 ? "" : "s"} advertised directly, so a
                            CLI sees them without asking first.
                          </span>
                        </span>
                        <Switch
                          checked={onExts.includes(e.id)}
                          aria-label={e.name}
                          onCheckedChange={(on) =>
                            void writeSurface(
                              offPacks,
                              on ? [...onExts, e.id] : onExts.filter((x) => x !== e.id),
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
                    ? `Open on port ${port || DEFAULT_PORT}. Anything running as you can drive this window.`
                    : port
                      ? `Opens on port ${port} after a restart.`
                      : "Off. Required for any of the above to connect."}
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
                  <RotateCw size={12} /> Restart TEDI to finish.
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
