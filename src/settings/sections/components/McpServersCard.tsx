import { useCallback, useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { SettingsCard } from "../../components/SettingsCard";
import {
  getMcpServers,
  getMcpServersEnabled,
  joinCommandLine,
  splitCommandLine,
  removeMcpServer,
  saveMcpServer,
  setMcpServersEnabled,
  toggleMcpServer,
  type McpServerConfig,
} from "@/modules/ai/lib/mcpConfig";
import { refreshMcpTools, validateMcpServer } from "@/modules/ai/lib/mcpClient";
import {
  clearMcpAuth,
  getMcpHeaders,
  headerLines,
  parseHeaderLines,
  setMcpHeaders,
} from "@/modules/ai/lib/mcpAuth";
import { CirclePlay, Pause, Pencil, Plus, Trash2 } from "lucide-react";

/**
 * Derive a compact server name from a run command, so adding an MCP server
 * needs no separate name field: take the last non-flag token, reduce it to the
 * package basename minus scope/version. `npx -y @scope/foo-mcp@1.2.0` -> `foo-mcp`.
 * Deduped against existing names so re-adds don't silently overwrite.
 */
function deriveName(args: string[], command: string, existing: McpServerConfig[]): string {
  const last = [...args].reverse().find((a) => !a.startsWith("-")) ?? command;
  let base = (last.split(/[\\/]/).pop() || last)
    .replace(/@[^@]*$/, "") // drop @version / trailing @
    .replace(/\.(c|m)?[jt]s$/i, "") // drop .js/.ts/.cjs/.mjs
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .toLowerCase();
  if (!base) base = "mcp-server";
  const taken = new Set(existing.map((s) => s.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/** `https://mcp.linear.app/mcp` -> `linear`: the host minus `mcp.`/`api.` and its TLD. */
function deriveNameFromUrl(url: string, existing: McpServerConfig[]): string {
  let base = "mcp-server";
  try {
    const labels = new URL(url).hostname.split(".").filter((l) => !/^(mcp|api|www)$/i.test(l));
    base = (labels.length > 1 ? labels[labels.length - 2] : (labels[0] ?? base)).toLowerCase();
  } catch {
    // Not a URL after all: the generic name, deduped below.
  }
  const taken = new Set(existing.map((s) => s.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/** What a row shows and the edit field holds: the URL, or the run command. */
const serverTarget = (s: McpServerConfig) => s.url ?? joinCommandLine([s.command, ...s.args]);

/** `{FOO:"1"}` <-> "FOO=1" lines, for the optional credentials field. */
const envToText = (env?: Record<string, string>): string =>
  Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return env;
}

/**
 * Settings card for managing MCP servers. Add by pasting a run command (name
 * auto-derived), then enable/disable, edit, or remove each server.
 */
export function McpServersCard() {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [cmd, setCmd] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [editCmd, setEditCmd] = useState("");
  const [envText, setEnvText] = useState("");
  const [showEnv, setShowEnv] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [serversEnabled, setServersEnabled] = useState(true);

  const refresh = useCallback(() => {
    void getMcpServers().then(setServers);
    void getMcpServersEnabled().then(setServersEnabled);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleAdd = async () => {
    const raw = cmd.trim();
    if (!raw || busy) return;
    let config: McpServerConfig;
    let command = raw;
    if (isUrl(raw)) {
      // A remote server: Streamable HTTP, signed in over OAuth if it asks.
      const name = deriveNameFromUrl(raw, servers);
      config = { name, command: "", args: [], url: raw, enabled: true };
    } else {
      // Quote-aware: a Windows profile path ("C:/Users/IT STAFF/...") has a space.
      const [cmd0, ...args] = splitCommandLine(raw);
      command = cmd0;
      config = {
        name: deriveName(args, cmd0, servers),
        command: cmd0,
        args,
        env: {},
        enabled: true,
      };
    }
    const name = config.name;
    setBusy(true);
    setStatus({
      kind: "ok",
      msg: config.url
        ? `Connecting to "${name}". If it asks you to sign in, a browser tab opens; finish there.`
        : `Connecting to "${name}"`,
    });
    try {
      // Validate by spawning and handshaking before persisting. A command that
      // cannot launch is rejected and left in the input for correction; one that
      // launches but fails the handshake (commonly a missing credential or
      // argument) is still saved so it can be edited, but reported as failed.
      const result = await validateMcpServer(config);
      if (!result.ok && result.reason === "spawn") {
        setStatus({ kind: "err", msg: `Couldn't start "${command}": ${result.error}` });
        return;
      }
      await saveMcpServer(config);
      setCmd("");
      refresh();
      setStatus(
        result.ok
          ? {
              kind: "ok",
              msg: `Added "${name}" (${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}).`,
            }
          : {
              kind: "err",
              msg: `Added "${name}", but it didn't complete the MCP handshake: ${result.error} Edit it to add credentials/args, or remove it.`,
            },
      );
    } catch (e) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleSave = async () => {
    if (!editing) return;
    const target = editCmd.trim();
    let config: McpServerConfig;
    let command = target;
    if (isUrl(target)) {
      // Headers go to the keychain, never the config file; the bumped revision
      // is what tells the main window its live connection is stale.
      await setMcpHeaders(editing.name, parseHeaderLines(envText));
      config = {
        ...editing,
        command: "",
        args: [],
        env: {},
        url: target,
        authRev: (editing.authRev ?? 0) + 1,
      };
    } else {
      const [cmd0, ...args] = splitCommandLine(target);
      if (!cmd0) return;
      command = cmd0;
      // Was an HTTP server: its keychain headers mean nothing to a process.
      if (editing.url) await setMcpHeaders(editing.name, {});
      config = { ...editing, command: cmd0, args, env: parseEnv(envText), url: undefined };
    }
    setBusy(true);
    setStatus({ kind: "ok", msg: `Connecting to "${editing.name}"` });
    try {
      // An edit is an explicit user action (often fixing a broken server), so
      // it is persisted even when the handshake fails - except when the command
      // cannot launch at all, which is a typo rather than a fix.
      const result = await validateMcpServer(config);
      // An edit whose command cannot even LAUNCH is a typo, not a fix: keep the
      // working config instead of overwriting it with one that cannot start.
      if (!result.ok && result.reason === "spawn") {
        setStatus({ kind: "err", msg: `Not saved: couldn't start "${command}": ${result.error}` });
        return;
      }
      await saveMcpServer(config);
      void refreshMcpTools(editing.name); // drop the stale connection so edits take effect next turn
      setEditing(null);
      refresh();
      setStatus(
        result.ok
          ? {
              kind: "ok",
              msg: `Saved "${config.name}" (${result.toolCount} tool${result.toolCount === 1 ? "" : "s"}).`,
            }
          : { kind: "err", msg: `Saved "${config.name}", but connection failed: ${result.error}` },
      );
    } catch (e) {
      setStatus({ kind: "err", msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (name: string) => {
    const enabled = await toggleMcpServer(name);
    void refreshMcpTools(name); // stop a disabled server / pick up a re-enabled one
    refresh();
    setStatus({ kind: "ok", msg: `${name} ${enabled ? "enabled" : "disabled"}.` });
  };

  const handleMaster = async (on: boolean) => {
    setServersEnabled(on);
    await setMcpServersEnabled(on);
    // Off stops every running server now rather than at its 5-minute idle
    // sweep: turning MCP off is how a user gets those processes back. On
    // starts nothing - the next agent turn connects what is enabled.
    if (!on) for (const s of servers) void refreshMcpTools(s.name);
    setStatus({
      kind: "ok",
      msg: on
        ? "MCP servers on. Enabled servers start with the next agent turn."
        : "MCP servers off. Running servers were stopped; each server's own setting is kept.",
    });
  };

  const handleDelete = async (name: string) => {
    await removeMcpServer(name);
    // An HTTP server's headers, tokens and client registration go with it.
    await clearMcpAuth(name);
    void refreshMcpTools(name); // stop the removed server's process now
    setPendingDelete(null);
    refresh();
    setStatus({ kind: "ok", msg: `Removed "${name}".` });
  };

  return (
    <SettingsCard
      title="MCP Servers"
      badge={
        !serversEnabled ? (
          <span className="text-muted-foreground text-[10px]">off</span>
        ) : servers.length > 0 ? (
          <span className="text-muted-foreground text-[10px]">
            {servers.filter((s) => s.enabled).length}/{servers.length} enabled
          </span>
        ) : null
      }
      headerRight={
        <Switch
          checked={serversEnabled}
          onCheckedChange={(v) => void handleMaster(v)}
          aria-label="Enable MCP servers"
        />
      }
      description="Connect external tool servers via the Model Context Protocol. Each server exposes tools the AI agent can use (e.g. browser automation, database access)."
    >
      {/* Add: paste the run command (name auto-derived) */}
      <div className="flex items-center gap-2">
        <Input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleAdd();
          }}
          placeholder="Run command or URL, e.g. npx -y chrome-devtools-mcp or https://mcp.linear.app/mcp"
          className="h-8 flex-1 text-[12px]"
          spellCheck={false}
          disabled={busy}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8 shrink-0 gap-1.5 px-2.5 text-[11px]"
          disabled={busy || !cmd.trim()}
          onClick={() => void handleAdd()}
        >
          {busy ? <Spinner className="size-3.5" /> : <Plus size={12} strokeWidth={1.75} />}
          Add
        </Button>
      </div>

      {/* Status */}
      {status && (
        <div
          className={cn(
            "text-[10.5px] leading-relaxed",
            status.kind === "ok" ? "text-diff-added" : "text-destructive",
          )}
        >
          {status.msg}
        </div>
      )}

      {!serversEnabled && (
        <div className="text-muted-foreground text-[10.5px] leading-relaxed">
          MCP servers are off: none is started for the agent or its sub-agents. Each server&apos;s
          own setting below is kept for when you turn them back on. TEDI&apos;s built-in tools are
          not affected.
        </div>
      )}

      {/* Server list */}
      {servers.length === 0 ? (
        <div className="text-muted-foreground/80 border-border/40 border-t pt-2 text-[10.5px] leading-relaxed">
          No MCP servers yet. Paste a run command above (e.g.{" "}
          <span className="font-mono">npx -y chrome-devtools-mcp</span>) or a remote server&apos;s
          URL to add one.
        </div>
      ) : (
        <div
          className={cn(
            "border-border/40 flex flex-col gap-1.5 border-t pt-2",
            !serversEnabled && "opacity-60",
          )}
        >
          {servers.map((s) => (
            <div
              key={s.name}
              className={cn(
                "border-border/60 bg-card flex items-start gap-2 rounded-lg border px-3 py-2",
                !s.enabled && "opacity-50",
              )}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[12px] font-medium">{s.name || "(unnamed)"}</span>
                  <span
                    className={cn(
                      "rounded px-1 py-0 font-mono text-[9.5px]",
                      s.enabled
                        ? "bg-diff-added/20 text-diff-added"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {s.enabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <span className="text-muted-foreground truncate font-mono text-[10.5px]">
                  {serverTarget(s)}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <IconTooltip label={s.enabled ? "Disable" : "Enable"} side="top">
                  <Button
                    size="icon"
                    variant="ghost"
                    className={cn(
                      "size-7",
                      s.enabled
                        ? "text-muted-foreground hover:bg-muted/50"
                        : "text-accent-foreground hover:bg-accent/20",
                    )}
                    onClick={() => void handleToggle(s.name)}
                  >
                    {s.enabled ? (
                      <Pause size={12} strokeWidth={1.75} />
                    ) : (
                      <CirclePlay size={12} strokeWidth={1.75} />
                    )}
                  </Button>
                </IconTooltip>
                <IconTooltip label="Edit" side="top">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-muted-foreground hover:bg-muted/50 size-7"
                    onClick={() => {
                      setEditing({ ...s });
                      setEditCmd(serverTarget(s));
                      if (s.url) {
                        // Headers live in the keychain, so they load after the click.
                        setEnvText("");
                        setShowEnv(false);
                        void getMcpHeaders(s.name).then((h) => {
                          setEnvText(headerLines(h));
                          setShowEnv(Object.keys(h).length > 0);
                        });
                      } else {
                        setEnvText(envToText(s.env));
                        setShowEnv(Object.keys(s.env ?? {}).length > 0);
                      }
                    }}
                  >
                    <Pencil size={12} strokeWidth={1.75} />
                  </Button>
                </IconTooltip>
                <IconTooltip label="Remove" side="top">
                  <Button
                    size="icon"
                    variant="ghost"
                    className={cn(DESTRUCTIVE_ACTION, "size-7")}
                    onClick={() => setPendingDelete(s.name)}
                  >
                    <Trash2 size={12} strokeWidth={1.75} />
                  </Button>
                </IconTooltip>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Edit dialog */}
      {editing && (
        <div className="border-border/60 bg-accent/10 flex flex-col gap-2 rounded-lg border px-3 py-2.5">
          <div className="text-[11px] font-medium">Edit: {editing.name}</div>
          <div className="flex flex-col gap-1.5">
            <Input
              value={editCmd}
              onChange={(e) => setEditCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !showEnv) void handleSave();
              }}
              placeholder="Run command or URL"
              className="h-7 text-[11px]"
              spellCheck={false}
            />
            {showEnv ? (
              <Textarea
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                placeholder={
                  isUrl(editCmd)
                    ? "Headers, one Name: value per line (e.g. Authorization: Bearer ghp_xxx). Kept in the OS keychain. Leave empty to sign in with OAuth."
                    : "Credentials, one KEY=value per line (e.g. GITHUB_TOKEN=ghp_xxx)"
                }
                className="min-h-[3.5rem] resize-y font-mono text-[10.5px] leading-relaxed"
                spellCheck={false}
              />
            ) : (
              <button
                type="button"
                onClick={() => setShowEnv(true)}
                className="text-muted-foreground hover:text-foreground w-fit text-[10.5px] underline-offset-2 hover:underline"
              >
                {isUrl(editCmd)
                  ? "+ Add headers (a token instead of signing in)"
                  : "+ Add credentials (env vars)"}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7 text-[11px]"
              disabled={busy || !editCmd.trim()}
              onClick={() => void handleSave()}
            >
              {busy ? <Spinner className="size-3.5" /> : "Save"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px]"
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove MCP server?</AlertDialogTitle>
            <AlertDialogDescription>
              &quot;{pendingDelete}&quot; will be permanently removed. The server process will be
              stopped on next agent turn.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => pendingDelete && void handleDelete(pendingDelete)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  );
}
