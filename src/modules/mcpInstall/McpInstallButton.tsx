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
import { getAutomationPort, setAutomationPort } from "@/modules/settings/store";
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

  const refresh = useCallback(async () => {
    const root = pickedRoot();
    const [cli, project, storedPort, path] = await Promise.all([
      detect(),
      root ? projectStatus(root) : Promise.resolve(null),
      getAutomationPort(),
      serverPath(),
    ]);
    setRows(project ? [...cli, project] : cli);
    setPort(storedPort);
    setServer(path);
  }, []);

  // Once on mount for the indicator, and again whenever the dialog opens - a
  // config can be edited by hand, or by another TEDI window, between the two.
  useEffect(() => {
    void refresh().catch(() => setRows([]));
  }, [refresh, open]);

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
                  <span className="text-muted-foreground block truncate text-xs">
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
