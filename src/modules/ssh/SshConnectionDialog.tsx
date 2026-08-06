import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { FsReadResult } from "@/lib/ipc";
import {
  authFields,
  clearFingerprint,
  getConnectionSecrets,
  listConnections,
  newConnectionId,
  pinFingerprint,
  resolveJumpHops,
  upsertConnection,
  type SshAuthMode,
  type SshConnection,
} from "@/modules/ssh/connections";
import { listSshAgentKeys, openSsh, type SshAgentKey } from "@/modules/ssh/bridge";
import { useHostKeyPrompt } from "@/modules/ssh/hostKeyPrompt";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION } from "@/lib/toolbarButton";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, X } from "lucide-react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Connection to edit, or `null` to create a new one. */
  editing: SshConnection | null;
  onSaved?: (conn: SshConnection) => void;
};

type Draft = {
  name: string;
  host: string;
  port: string;
  user: string;
  authMode: SshAuthMode;
  password: string;
  privateKey: string;
  keyPassphrase: string;
  /** Saved-connection id of the jump host, or "" for a direct connection. */
  proxyJumpId: string;
  /** `ssh -L` rules. Ports stay strings so a half-typed field isn't NaN. */
  forwards: { localPort: string; remoteHost: string; remotePort: string }[];
};

const EMPTY_DRAFT: Draft = {
  name: "",
  host: "",
  port: "22",
  user: "",
  authMode: "password",
  password: "",
  privateKey: "",
  keyPassphrase: "",
  proxyJumpId: "",
  forwards: [],
};

function isPort(v: string): boolean {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 && String(n) === v.trim();
}

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; fingerprint: string; durationMs: number }
  | { kind: "fail"; message: string };

type ImportState =
  { kind: "idle" } | { kind: "loaded"; path: string } | { kind: "error"; message: string };

/** What the local ssh-agent answered. Agent auth has no field to fill in, so
 *  this IS the form validation for that mode: it says up front whether an agent
 *  is running and holding a key, instead of failing at dial time. */
type AgentState =
  { kind: "checking" } | { kind: "ok"; keys: SshAgentKey[] } | { kind: "error"; message: string };

export function SshConnectionDialog({ open, onOpenChange, editing, onSaved }: Props) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [imported, setImported] = useState<ImportState>({ kind: "idle" });
  const [agent, setAgent] = useState<AgentState>({ kind: "checking" });
  // The server key this connection trusts, as of right now: seeded from the
  // saved one, cleared by "Forget", set by trusting a new one during Test. It is
  // the single source of truth for the pin - what Test verifies against AND what
  // Save writes - so a key trusted here cannot be lost, and a forgotten one
  // cannot come back from the stale `editing` prop.
  const [pinnedFingerprint, setPinnedFingerprint] = useState<string | null>(null);
  // Other saved hosts, offered as jump-host (ProxyJump) options.
  const [allConns, setAllConns] = useState<SshConnection[]>([]);
  const [jumpPickerOpen, setJumpPickerOpen] = useState(false);

  // Reset and populate when the dialog opens. Secrets load async.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    setTest({ kind: "idle" });
    setImported({ kind: "idle" });
    void listConnections().then((cs) => {
      setAllConns(cs);
      // If this connection's jump host was deleted, drop the dangling reference
      // so the <select> and a subsequent save reflect a direct connection
      // instead of silently keeping a dead id that fails every connect.
      setDraft((d) =>
        d.proxyJumpId && !cs.some((c) => c.id === d.proxyJumpId) ? { ...d, proxyJumpId: "" } : d,
      );
    });
    if (!editing) {
      setDraft(EMPTY_DRAFT);
      setPinnedFingerprint(null);
      return;
    }
    setDraft({
      name: editing.name,
      host: editing.host,
      port: String(editing.port),
      user: editing.user,
      authMode: editing.authMode,
      password: "",
      privateKey: "",
      keyPassphrase: "",
      proxyJumpId: editing.proxyJumpId ?? "",
      forwards: (editing.forwards ?? []).map((f) => ({
        localPort: String(f.localPort),
        remoteHost: f.remoteHost,
        remotePort: String(f.remotePort),
      })),
    });
    setPinnedFingerprint(editing.lastFingerprint ?? null);
    void getConnectionSecrets(editing.id).then((s) => {
      setDraft((d) => ({
        ...d,
        password: s.password ?? "",
        privateKey: s.privateKey ?? "",
        keyPassphrase: s.keyPassphrase ?? "",
      }));
    });
  }, [open, editing]);

  // Ask the agent what it holds whenever this mode is on screen. Cheap enough
  // to re-run on every open and every switch into the tab, which is also what
  // makes "start the agent, then come back" show the right answer.
  const checkAgent = useCallback(async () => {
    setAgent({ kind: "checking" });
    try {
      setAgent({ kind: "ok", keys: await listSshAgentKeys() });
    } catch (e) {
      setAgent({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    if (!open || draft.authMode !== "agent") return;
    void checkAgent();
  }, [open, draft.authMode, checkAgent]);

  const forgetPinnedKey = async () => {
    if (!editing) return;
    await clearFingerprint(editing.id);
    setPinnedFingerprint(null);
    // Stale "host key mismatch" result is no longer valid.
    setTest({ kind: "idle" });
  };

  const validateDraft = (): string | null => {
    const port = Number.parseInt(draft.port, 10);
    if (!draft.name.trim()) return "Name is required";
    if (!draft.host.trim()) return "Host is required";
    if (!draft.user.trim()) return "User is required";
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return "Port must be 1–65535";
    if (draft.authMode === "password" && !draft.password)
      return "Password is required for password auth";
    if (draft.authMode === "key" && !draft.privateKey.trim())
      return "Private key body is required for key auth";
    // Agent mode has nothing to require here on purpose: the agent may be
    // started (or the key added) after this host is saved, so a down agent must
    // not block saving. The panel reports its state, and a connect attempt fails
    // with the backend's message naming what to start.
    for (const f of draft.forwards) {
      if (!f.remoteHost.trim()) return "Port forward needs a destination host";
      if (!isPort(f.localPort) || !isPort(f.remotePort))
        return "Port forward ports must be 1–65535";
    }
    return null;
  };

  const runTest = async () => {
    const v = validateDraft();
    if (v) {
      setError(v);
      return;
    }
    setError(null);
    setTest({ kind: "running" });
    const port = Number.parseInt(draft.port, 10);
    const started = performance.now();
    // A new host (no pinned key) makes the backend pause the handshake on a
    // first-connect prompt; we route it to the global confirmation dialog and
    // remember the id so it can be cleared if the probe ends without an answer.
    let testPromptId: string | null = null;
    try {
      // Resolve the jump chain (if a jump host is selected) so the probe dials
      // through it, exactly like a real connect would.
      const jumps = await resolveJumpHops(draft.proxyJumpId || undefined, editing?.id, allConns);
      // Open a probe session, wait for Connected, then close. Runs against the
      // current form values.
      // Budget scales with chain depth: each hop is a full handshake the backend
      // caps at ~15s, and a fully-pinned chain fires no host-key prompt to clear
      // this timer, so a deep chain needs more than the base 20s.
      const probeTimeoutMs = 20_000 + jumps.length * 15_000;
      let resolved = false;
      const result = await new Promise<{ fingerprint: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          reject(new Error(`test timed out after ${Math.round(probeTimeoutMs / 1000)}s`));
        }, probeTimeoutMs);
        openSsh(
          {
            host: draft.host.trim(),
            port,
            user: draft.user.trim(),
            // Same mapping the real connect uses, straight off the draft, so
            // Test can never authenticate differently from what Save produces.
            ...authFields(draft.authMode, {
              password: draft.password,
              privateKey: draft.privateKey,
              keyPassphrase: draft.keyPassphrase,
            }),
            // Pin against the previously recorded fingerprint so Test cannot
            // silently re-anchor on a different key. New connections leave
            // this unset and use TOFU on first connect.
            expectedFingerprint: pinnedFingerprint || undefined,
            jumps,
            cols: 80,
            rows: 24,
          },
          {
            onData: () => {},
            // New host: hand the fingerprint to the global host-key dialog so
            // the user can verify it, and stop the 20s probe deadline - waiting
            // on a human can take arbitrarily long and the handshake stays
            // paused (no credentials sent) until they answer. Without this, a
            // first-connect Test dropped the prompt and could only ever time out.
            onHostKeyPrompt: (prompt) => {
              testPromptId = prompt.promptId;
              clearTimeout(timer);
              // Trusting the key here counts, whatever the rest of the test
              // does. A saved host records it on the spot; a brand-new one has
              // no id yet, so Save writes it from the same state. Both used to
              // be forgotten, which is why testing a new server and then saving
              // it asked the very same question again.
              useHostKeyPrompt.getState().enqueue(prompt, () => {
                setPinnedFingerprint(prompt.fingerprint);
                if (editing) void pinFingerprint(editing.id, prompt.fingerprint).catch(() => {});
              });
            },
            onConnected: (fingerprint) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timer);
              resolve({ fingerprint });
            },
            onError: (msg) => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timer);
              reject(new Error(msg));
            },
            onExit: () => {
              if (resolved) return;
              resolved = true;
              clearTimeout(timer);
              reject(new Error("session ended before authenticating"));
            },
          },
        )
          .then(async (sess) => {
            // Close immediately. Only the handshake matters.
            try {
              await sess.close();
            } catch {
              // Runtime will reap the dead session.
            }
          })
          .catch((err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            reject(err);
          });
      });
      setTest({
        kind: "ok",
        fingerprint: result.fingerprint,
        durationMs: Math.round(performance.now() - started),
      });
    } catch (e) {
      setTest({
        kind: "fail",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      // If the probe ended while a host-key prompt was still pending (rejected,
      // timed out, or the user walked away), drop it so it can't linger in the
      // shared queue and block a later real connect's dialog.
      if (testPromptId) useHostKeyPrompt.getState().dismiss(testPromptId);
    }
  };

  const pickKeyFile = async () => {
    setImported({ kind: "idle" });
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        title: "Pick SSH private key",
        filters: [
          {
            name: "Private key (.pem, .key, .ppk, .pub)",
            extensions: ["pem", "key", "ppk", "pub"],
          },
          // OpenSSH keys (id_rsa, id_ed25519, …) have no extension, so keep an
          // all-files fallback the user can switch to.
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (typeof picked !== "string") return;
      const result = await invoke<FsReadResult>("fs_read_file", { path: picked });
      if (result.kind !== "text") {
        setImported({
          kind: "error",
          message:
            result.kind === "toolarge"
              ? "File too large to import"
              : "Picked file is not a text key",
        });
        return;
      }
      setDraft((d) => ({ ...d, privateKey: result.content }));
      setImported({ kind: "loaded", path: picked });
    } catch (e) {
      setImported({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const save = async () => {
    setError(null);
    const v = validateDraft();
    if (v) return setError(v);
    const port = Number.parseInt(draft.port, 10);

    setSaving(true);
    try {
      const id = editing?.id ?? newConnectionId();
      const host = draft.host.trim();
      // A pinned key belongs to the machine that presented it. Re-pointing this
      // connection at a different host makes it stale, and keeping it would fail
      // the next connect as a key MISMATCH, which reads as an attack rather than
      // as an edit. The port is not part of that: one sshd presents the same
      // host key on every port it listens on.
      const keepPin = !editing || editing.host === host;
      const conn: SshConnection = {
        // Spread the existing record first so an edit preserves fields the form
        // doesn't own (lastFingerprint, lastConnectedAt, description) instead of
        // wiping them - important now that editing is also how a jump host gets
        // attached to an already-pinned connection.
        ...(editing ?? {}),
        id,
        name: draft.name.trim(),
        host,
        port,
        user: draft.user.trim(),
        authMode: draft.authMode,
        hasPassword: false,
        hasPrivateKey: false,
        hasKeyPassphrase: false,
        // Written from the dialog's own pin state, not carried over by the
        // spread above: `editing` is a snapshot from when the dialog opened, so
        // a key trusted during Test would be dropped and a key just cleared with
        // "Forget" would come back.
        lastFingerprint: (keepPin && pinnedFingerprint) || undefined,
        proxyJumpId: draft.proxyJumpId || undefined,
        forwards: draft.forwards.length
          ? draft.forwards.map((f) => ({
              localPort: Number.parseInt(f.localPort, 10),
              remoteHost: f.remoteHost.trim(),
              remotePort: Number.parseInt(f.remotePort, 10),
            }))
          : undefined,
      };
      await upsertConnection(conn, {
        password: draft.authMode === "password" ? draft.password : "",
        privateKey: draft.authMode === "key" ? draft.privateKey : "",
        keyPassphrase: draft.authMode === "key" ? draft.keyPassphrase : "",
      });
      onSaved?.(conn);
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Jump-host options (every saved host except this one) plus the current pick,
  // for the searchable combobox below.
  const jumpOptions = allConns.filter((c) => c.id !== editing?.id);
  const selectedJump = allConns.find((c) => c.id === draft.proxyJumpId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit SSH connection" : "New SSH connection"}</DialogTitle>
          <DialogDescription>
            {draft.authMode === "agent"
              ? "Nothing to store: the local ssh-agent holds the key and signs each handshake."
              : "Credentials are stored in your OS keychain (Windows Credential Manager / macOS Keychain)."}
          </DialogDescription>
        </DialogHeader>

        {/* DialogContent caps at calc(100dvh-2rem). min-h-0 lets the inner
            stack shrink so the form scrolls inside the dialog instead of
            top fields sliding off-screen. -mr-2/pr-2 keeps the scrollbar
            off the content edge. */}
        <div className="-mr-2 flex min-h-0 flex-col gap-3 overflow-y-auto pr-2">
          <Field label="Name">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="prod-bastion"
              spellCheck={false}
              className="h-8 text-[12px]"
            />
          </Field>

          <div className="grid grid-cols-[1fr_5rem] gap-2">
            <Field label="Host">
              <Input
                value={draft.host}
                onChange={(e) => setDraft({ ...draft, host: e.target.value })}
                placeholder="example.com or 192.168.1.10"
                spellCheck={false}
                className="h-8 font-mono text-[12px]"
              />
            </Field>
            <Field label="Port">
              <Input
                value={draft.port}
                onChange={(e) => setDraft({ ...draft, port: e.target.value })}
                inputMode="numeric"
                className="h-8 font-mono text-[12px]"
              />
            </Field>
          </div>

          <Field label="User">
            <Input
              value={draft.user}
              onChange={(e) => setDraft({ ...draft, user: e.target.value })}
              placeholder="users"
              spellCheck={false}
              className="h-8 font-mono text-[12px]"
            />
          </Field>

          <Field label="Authentication">
            <div className="flex gap-1">
              <AuthTab
                active={draft.authMode === "password"}
                onClick={() => setDraft({ ...draft, authMode: "password" })}
              >
                Password
              </AuthTab>
              <AuthTab
                active={draft.authMode === "key"}
                onClick={() => setDraft({ ...draft, authMode: "key" })}
              >
                Private key
              </AuthTab>
              <AuthTab
                active={draft.authMode === "agent"}
                onClick={() => setDraft({ ...draft, authMode: "agent" })}
              >
                SSH agent
              </AuthTab>
            </div>
          </Field>

          {draft.authMode === "agent" ? (
            <AgentPanel state={agent} onRecheck={() => void checkAgent()} />
          ) : draft.authMode === "password" ? (
            <Field label="Password">
              <Input
                type="password"
                value={draft.password}
                onChange={(e) => setDraft({ ...draft, password: e.target.value })}
                className="h-8 font-mono text-[12px]"
              />
            </Field>
          ) : (
            <>
              <Field label="Private key (PEM / OpenSSH)">
                <div className="flex flex-col gap-1">
                  <Textarea
                    value={draft.privateKey}
                    onChange={(e) => setDraft({ ...draft, privateKey: e.target.value })}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    spellCheck={false}
                    className="h-32 font-mono text-[11px]"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => void pickKeyFile()}
                    >
                      Import from file…
                    </Button>
                    {imported.kind === "loaded" ? (
                      <span className="text-muted-foreground truncate text-[10.5px]">
                        Loaded {imported.path}
                      </span>
                    ) : imported.kind === "error" ? (
                      <span className="text-destructive truncate text-[10.5px]">
                        {imported.message}
                      </span>
                    ) : (
                      <span className="text-muted-foreground text-[10.5px]">
                        Paste, or import a .pem / key file
                      </span>
                    )}
                  </div>
                </div>
              </Field>
              <Field label="Key passphrase (optional)">
                <Input
                  type="password"
                  value={draft.keyPassphrase}
                  onChange={(e) => setDraft({ ...draft, keyPassphrase: e.target.value })}
                  className="h-8 font-mono text-[12px]"
                />
              </Field>
            </>
          )}

          <Field label="Jump host (optional)">
            {/* NOT `modal`. It looks like the fix for "cmdk items only answer
                Enter, never a click" inside a Dialog, but it buys that by making
                the whole page inert: every field behind it freezes and clicking
                away cannot even close it, since the click lands on nothing that
                listens. The click was never a focus problem - the portaled
                content was inheriting `pointer-events: none` from the body,
                which `PopoverContent` now overrides for itself. Focus is fine
                either way: any mounted FocusScope pauses the Dialog's, trapped
                or not. */}
            <Popover open={jumpPickerOpen} onOpenChange={setJumpPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  role="combobox"
                  aria-expanded={jumpPickerOpen}
                  className="h-8 w-full justify-between px-2.5 text-[12px] font-normal"
                >
                  <span className={cn("truncate", !selectedJump && "text-muted-foreground")}>
                    {selectedJump
                      ? `${selectedJump.name} (${selectedJump.user}@${selectedJump.host}:${selectedJump.port})`
                      : "None (direct connection)"}
                  </span>
                  <ChevronDown size={13} strokeWidth={2} className="ml-2 shrink-0 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={6}
                className="w-[var(--radix-popover-trigger-width)] gap-0 overflow-hidden rounded-2xl p-0"
              >
                <Command className="rounded-2xl">
                  <CommandInput placeholder="Search saved hosts…" className="text-[12px]" />
                  <CommandList className="max-h-56">
                    <CommandEmpty className="py-4 text-[11px]">No saved host found.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value="none direct connection"
                        data-checked={!draft.proxyJumpId ? "true" : undefined}
                        onSelect={() => {
                          setDraft((d) => ({ ...d, proxyJumpId: "" }));
                          setJumpPickerOpen(false);
                        }}
                        className="gap-2 rounded-xl px-2.5 py-1.5 text-[12px]"
                      >
                        <span className="truncate">None (direct connection)</span>
                      </CommandItem>
                      {jumpOptions.map((c) => (
                        <CommandItem
                          key={c.id}
                          // Searchable on name + user@host:port; the id keeps the
                          // value unique so cmdk never collapses two like-named hosts.
                          value={`${c.name} ${c.user}@${c.host}:${c.port} ${c.id}`}
                          data-checked={draft.proxyJumpId === c.id ? "true" : undefined}
                          onSelect={() => {
                            setDraft((d) => ({ ...d, proxyJumpId: c.id }));
                            setJumpPickerOpen(false);
                          }}
                          className="gap-2 rounded-xl px-2.5 py-1.5 text-[12px]"
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">{c.name}</span>
                            <span className="text-muted-foreground truncate font-mono text-[10px]">
                              {c.user}@{c.host}:{c.port}
                            </span>
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <span className="text-muted-foreground text-[10.5px]">
              Tunnel through another saved host to reach this one (ProxyJump). Chains transitively
              if the jump host has its own jump host.
            </span>
          </Field>

          <Field label="Port forwarding (optional)">
            <div className="flex flex-col gap-1.5">
              {draft.forwards.map((f, i) => {
                const patch = (next: Partial<(typeof draft.forwards)[number]>) =>
                  setDraft((d) => ({
                    ...d,
                    forwards: d.forwards.map((row, j) => (j === i ? { ...row, ...next } : row)),
                  }));
                return (
                  // Index key: rows have no id and are only ever appended or
                  // removed as a whole, so React never has to match them up.
                  <div
                    key={i}
                    className="grid grid-cols-[4.5rem_auto_1fr_4.5rem_auto] items-center gap-1.5"
                  >
                    <Input
                      value={f.localPort}
                      onChange={(e) => patch({ localPort: e.target.value })}
                      placeholder="5432"
                      inputMode="numeric"
                      aria-label="Local port"
                      className="h-8 font-mono text-[12px]"
                    />
                    <span className="text-muted-foreground text-[11px]">→</span>
                    <Input
                      value={f.remoteHost}
                      onChange={(e) => patch({ remoteHost: e.target.value })}
                      placeholder="127.0.0.1 or db.internal"
                      spellCheck={false}
                      aria-label="Destination host"
                      className="h-8 font-mono text-[12px]"
                    />
                    <Input
                      value={f.remotePort}
                      onChange={(e) => patch({ remotePort: e.target.value })}
                      placeholder="5432"
                      inputMode="numeric"
                      aria-label="Destination port"
                      className="h-8 font-mono text-[12px]"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={cn(DESTRUCTIVE_ACTION, "h-8 px-2 text-[11px]")}
                      aria-label="Remove port forward"
                      onClick={() =>
                        setDraft((d) => ({
                          ...d,
                          forwards: d.forwards.filter((_, j) => j !== i),
                        }))
                      }
                    >
                      <X size={13} strokeWidth={2} />
                    </Button>
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 self-start px-2 text-[11px]"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    forwards: [...d.forwards, { localPort: "", remoteHost: "", remotePort: "" }],
                  }))
                }
              >
                Add forward
              </Button>
            </div>
            <span className="text-muted-foreground text-[10.5px]">
              Like <span className="font-mono">ssh -L</span>: binds the local port on 127.0.0.1 and
              tunnels it to a host:port reachable <em>from the server</em>. Opened on every connect,
              closed with the session.
            </span>
          </Field>

          {editing ? (
            <Field label="Recorded server key">
              {pinnedFingerprint ? (
                <div className="border-border/60 bg-muted/30 flex items-center justify-between gap-2 rounded-md border px-2 py-1">
                  <span className="truncate font-mono text-[10.5px]" title={pinnedFingerprint}>
                    {pinnedFingerprint}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-[10.5px]"
                    onClick={() => void forgetPinnedKey()}
                  >
                    Forget
                  </Button>
                </div>
              ) : (
                <span className="text-muted-foreground text-[10.5px]">
                  No key pinned yet · next successful connect will record one (TOFU).
                </span>
              )}
            </Field>
          ) : null}

          {error ? <p className="text-destructive text-[11px]">{error}</p> : null}

          {test.kind === "running" ? (
            <p className="text-muted-foreground text-[11px]">Testing connection…</p>
          ) : test.kind === "ok" ? (
            <p className="text-diff-added text-[11px]">
              Connected · server key {test.fingerprint || "(unavailable)"} · {test.durationMs}ms
            </p>
          ) : test.kind === "fail" ? (
            <p className="text-destructive text-[11px]">Test failed: {test.message}</p>
          ) : null}
        </div>

        {/* Override DialogFooter's flex-col-reverse so Cancel stays on the
            left at any viewport width. */}
        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between sm:[&>button]:flex-none">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void runTest()}
            disabled={test.kind === "running" || saving}
          >
            {test.kind === "running" ? "Testing…" : "Test connection"}
          </Button>
          <div className="flex items-center gap-2">
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : editing ? "Save" : "Create"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-[11px] font-medium tracking-tight">{label}</span>
      {children}
    </div>
  );
}

/**
 * The whole of the agent auth "form": there is nothing to type, so the panel
 * answers the only question that matters - is an agent running and does it hold
 * a key. The error text comes from the backend, which names the exact service to
 * start per platform.
 */
function AgentPanel({ state, onRecheck }: { state: AgentState; onRecheck: () => void }) {
  return (
    <Field label="SSH agent">
      {/* Same box and same secondary button as "Recorded server key" below, so
          the two read-only status blocks in this dialog look like one thing. */}
      <div className="border-border/60 bg-muted/30 flex flex-col gap-1.5 rounded-md border px-2 py-1.5">
        <div className="flex items-center justify-between gap-2">
          {state.kind === "checking" ? (
            <span className="text-muted-foreground text-[11px]">Checking ssh-agent…</span>
          ) : state.kind === "error" ? (
            <span className="text-destructive text-[11px]">{state.message}</span>
          ) : state.keys.length === 0 ? (
            <span className="text-[11px]">
              Agent is running but holds no key. Add one with{" "}
              <span className="font-mono">ssh-add</span>.
            </span>
          ) : (
            <span className="text-[11px]">
              {state.keys.length} key{state.keys.length === 1 ? "" : "s"} available
            </span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 shrink-0 px-2 text-[10.5px]"
            onClick={onRecheck}
            disabled={state.kind === "checking"}
          >
            Recheck
          </Button>
        </div>
        {state.kind === "ok" && state.keys.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {state.keys.map((k) => (
              <li
                key={k.fingerprint}
                className="flex min-w-0 items-center gap-2 font-mono text-[10.5px]"
                title={k.fingerprint}
              >
                <span className="text-muted-foreground shrink-0">{k.algorithm}</span>
                <span className="truncate">{k.comment || k.fingerprint}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <span className="text-muted-foreground text-[10.5px]">
        The key never leaves the agent: TEDI asks it to sign each handshake and stores nothing · the
        server must already have the matching public key · Windows uses the OpenSSH Authentication
        Agent service or Pageant, elsewhere <span className="font-mono">SSH_AUTH_SOCK</span>.
      </span>
    </Field>
  );
}

function AuthTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] transition-colors " +
        (active
          ? "border-accent bg-accent/60"
          : "border-border/60 hover:bg-accent/30 bg-transparent")
      }
    >
      {children}
    </button>
  );
}
