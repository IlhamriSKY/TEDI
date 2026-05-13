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

export function SshConnectionDialog({
  open,
  onOpenChange,
  editing,
  onSaved,
}: Props) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset/populate when the dialog opens. Secrets are fetched async; the
  // form stays responsive in the meantime.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setSaving(false);
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

  const save = async () => {
    setError(null);
    const port = Number.parseInt(draft.port, 10);
    if (!draft.name.trim()) return setError("Name is required");
    if (!draft.host.trim()) return setError("Host is required");
    if (!draft.user.trim()) return setError("User is required");
    if (!Number.isInteger(port) || port <= 0 || port > 65535)
      return setError("Port must be 1–65535");
    if (draft.authMode === "password" && !draft.password)
      return setError("Password is required for password auth");
    if (draft.authMode === "key" && !draft.privateKey.trim())
      return setError("Private key body is required for key auth");

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
          <DialogTitle>
            {editing ? "Edit SSH connection" : "New SSH connection"}
          </DialogTitle>
          <DialogDescription>
            Credentials are stored in your OS keychain (Windows Credential
            Manager / macOS Keychain).
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
                onChange={(e) =>
                  setDraft({ ...draft, password: e.target.value })
                }
                className="h-8 font-mono text-[12px]"
              />
            </Field>
          ) : (
            <>
              <Field label="Private key (PEM / OpenSSH)">
                <Textarea
                  value={draft.privateKey}
                  onChange={(e) =>
                    setDraft({ ...draft, privateKey: e.target.value })
                  }
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  spellCheck={false}
                  className="h-32 font-mono text-[11px]"
                />
              </Field>
              <Field label="Key passphrase (optional)">
                <Input
                  type="password"
                  value={draft.keyPassphrase}
                  onChange={(e) =>
                    setDraft({ ...draft, keyPassphrase: e.target.value })
                  }
                  className="h-8 font-mono text-[12px]"
                />
              </Field>
            </>
          )}

          {error ? (
            <p className="text-[11px] text-destructive">{error}</p>
          ) : null}
        </div>

        {/* Override DialogFooter's flex-col-reverse so Cancel stays on the
            left / on top regardless of viewport width. */}
        <DialogFooter className="flex-row justify-end gap-2">
          <DialogClose asChild>
            <Button variant="outline" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : editing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium tracking-tight text-muted-foreground">
        {label}
      </span>
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
          : "border-border/60 bg-transparent hover:bg-accent/30")
      }
    >
      {children}
    </button>
  );
}
