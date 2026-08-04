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
import { Spinner } from "@/components/ui/spinner";
import { applyBackup, buildBackup, type ImportResult } from "./backup";
import { BACKUP_EXTENSION } from "./backupFile";
import { invoke } from "@tauri-apps/api/core";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";

export type BackupMode =
  | { kind: "export" }
  /** Import already has the file text: the native picker runs before this
   *  dialog so the user is not asked for a passphrase and only then told
   *  they picked the wrong file. */
  | { kind: "import"; path: string; text: string };

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: BackupMode;
};

export function SshBackupDialog({ open, onOpenChange, mode }: Props) {
  const isExport = mode.kind === "export";
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Reset per opening. The passphrase must never survive a closed dialog, and
  // a stale result line would otherwise read as if it applied to this run.
  useEffect(() => {
    if (!open) return;
    setPassphrase("");
    setConfirm("");
    setError(null);
    setDone(null);
    setBusy(false);
  }, [open, mode]);

  const mismatch = isExport && confirm.length > 0 && passphrase !== confirm;
  const canSubmit =
    !busy && passphrase.length > 0 && (!isExport || (confirm.length > 0 && !mismatch));

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      if (isExport) {
        const { text, count } = await buildBackup(passphrase);
        // Built BEFORE the save dialog on purpose: "no saved connections" or a
        // keychain refusal should surface without first making the user pick a
        // filename for a file that was never going to be written.
        const target = await saveFileDialog({
          defaultPath: `tedi-ssh-connections.${BACKUP_EXTENSION}`,
          filters: [{ name: "TEDI SSH backup", extensions: [BACKUP_EXTENSION] }],
        });
        if (!target) {
          setBusy(false);
          return;
        }
        await invoke<void>("fs_write_file", { path: target, content: text });
        setDone(`Exported ${count} connection${count === 1 ? "" : "s"} to ${target}`);
      } else {
        const result = await applyBackup(mode.text, passphrase);
        setDone(summarize(result));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isExport ? "Export SSH connections" : "Import SSH connections"}
          </DialogTitle>
          <DialogDescription>
            {isExport
              ? "Writes every saved host and its stored credentials to one encrypted file. Keep the passphrase: without it the file cannot be read, and there is no recovery."
              : "Merges the hosts in the file into your saved connections, matching on connection id. Nothing is deleted."}
          </DialogDescription>
        </DialogHeader>

        {!isExport ? (
          <p className="text-muted-foreground truncate font-mono text-[10.5px]" title={mode.path}>
            {mode.path}
          </p>
        ) : null}

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-[11px] font-medium tracking-tight">
              Passphrase
            </span>
            <Input
              type="password"
              autoFocus
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) void run();
              }}
              className="h-8 font-mono text-[12px]"
            />
          </div>

          {isExport ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-muted-foreground text-[11px] font-medium tracking-tight">
                Confirm passphrase
              </span>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmit) void run();
                }}
                className="h-8 font-mono text-[12px]"
              />
              {mismatch ? (
                <span className="text-destructive text-[10.5px]">
                  The two passphrases do not match.
                </span>
              ) : null}
            </div>
          ) : null}

          {isExport ? (
            <p className="text-muted-foreground text-[10.5px]">
              The file contains your SSH passwords and private keys, encrypted with this passphrase
              (PBKDF2-SHA256, AES-256-GCM). Treat it like a key file.
            </p>
          ) : null}

          {error ? <span className="text-destructive text-[10.5px]">{error}</span> : null}
          {done ? <span className="text-muted-foreground text-[10.5px]">{done}</span> : null}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm">
              {done ? "Close" : "Cancel"}
            </Button>
          </DialogClose>
          <Button size="sm" disabled={!canSubmit} onClick={() => void run()} className="gap-1.5">
            {busy ? <Spinner className="size-3" /> : null}
            {isExport ? "Export" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function summarize(r: ImportResult): string {
  const parts = [`${r.added} added`, `${r.replaced} updated`];
  if (r.skipped > 0) parts.push(`${r.skipped} skipped as unreadable`);
  if (r.withoutSecrets > 0) parts.push(`${r.withoutSecrets} without stored credentials`);
  return `Imported: ${parts.join(", ")}.`;
}
