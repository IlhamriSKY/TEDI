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
import {
  getConnectionSecrets,
  newConnectionId,
  upsertConnection,
  type SshAuthMode,
  type SshConnection,
} from "@/modules/ssh/connections";
import { openSsh } from "@/modules/ssh/bridge";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Existing connection to edit, or `null` to create a new one. */
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
};

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; fingerprint: string; durationMs: number }
  | { kind: "fail"; message: string };

type ImportState =
  | { kind: "idle" }
  | { kind: "loaded"; path: string }
  | { kind: "error"; message: string };

export function SshConnectionDialog({ open, onOpenChange, editing, onSaved }: Props) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [imported, setImported] = useState<ImportState>({ kind: "idle" });

  // Reset/populate when the dialog opens. Secrets are fetched async; the
  // form stays responsive in the meantime.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
    setTest({ kind: "idle" });
    setImported({ kind: "idle" });
    if (!editing) {
      setDraft(EMPTY_DRAFT);
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
    });
    void getConnectionSecrets(editing.id).then((s) => {
      setDraft((d) => ({
        ...d,
        password: s.password ?? "",
        privateKey: s.privateKey ?? "",
        keyPassphrase: s.keyPassphrase ?? "",
      }));
    });
  }, [open, editing]);

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
    try {
      // Open a probe session, wait for the Connected event, then close it
      // immediately. We never write to the keychain — the test runs against
      // whatever is in the form right now.
      let resolved = false;
      const result = await new Promise<{ fingerprint: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          reject(new Error("test timed out after 20s"));
        }, 20_000);
        openSsh(
          {
            host: draft.host.trim(),
            port,
            user: draft.user.trim(),
            password: draft.authMode === "password" ? draft.password : undefined,
            privateKey: draft.authMode === "key" ? draft.privateKey : undefined,
            privateKeyPassphrase:
              draft.authMode === "key" ? draft.keyPassphrase || undefined : undefined,
            cols: 80,
            rows: 24,
          },
          {
            onData: () => {},
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
            // Close right away — we only care that the handshake worked.
            try {
              await sess.close();
            } catch {
              // ignore; the runtime will reap the dead session.
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
    }
  };

  const pickKeyFile = async () => {
    setImported({ kind: "idle" });
    try {
      const picked = await openDialog({
        multiple: false,
        directory: false,
        title: "Pick SSH private key",
      });
      if (typeof picked !== "string") return;
      const result = await invoke<
        | { kind: "text"; content: string; size: number }
        | { kind: "binary"; size: number }
        | { kind: "image"; dataUrl: string; mime: string; size: number }
        | { kind: "toolarge"; size: number; limit: number }
      >("fs_read_file", { path: picked });
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
      const conn: SshConnection = {
        id,
        name: draft.name.trim(),
        host: draft.host.trim(),
        port,
        user: draft.user.trim(),
        authMode: draft.authMode,
        hasPassword: false,
        hasPrivateKey: false,
        hasKeyPassphrase: false,
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit SSH connection" : "New SSH connection"}</DialogTitle>
          <DialogDescription>
            Credentials are stored in your OS keychain (Windows Credential Manager / macOS
            Keychain).
          </DialogDescription>
        </DialogHeader>

        {/* DialogContent caps at calc(100dvh-2rem). Without min-h-0 the
            inner gap-6 stack refuses to shrink and the top fields scroll
            off-screen instead of the form scrolling inside the dialog.
            -mr-2/pr-2 keeps the scrollbar from butting against the
            content edge. */}
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
            </div>
          </Field>

          {draft.authMode === "password" ? (
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
                        Paste or import a private key
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

          {error ? <p className="text-destructive text-[11px]">{error}</p> : null}

          {test.kind === "running" ? (
            <p className="text-muted-foreground text-[11px]">Testing connection…</p>
          ) : test.kind === "ok" ? (
            <p className="text-[11px] text-emerald-600 dark:text-emerald-400">
              Connected · server key {test.fingerprint || "(unavailable)"} · {test.durationMs}ms
            </p>
          ) : test.kind === "fail" ? (
            <p className="text-destructive text-[11px]">Test failed: {test.message}</p>
          ) : null}
        </div>

        {/* Override DialogFooter's flex-col-reverse so Cancel stays on the
            left / on top regardless of viewport width. */}
        <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between">
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
          ? "border-foreground/40 bg-accent/60"
          : "border-border/60 hover:bg-accent/30 bg-transparent")
      }
    >
      {children}
    </button>
  );
}
