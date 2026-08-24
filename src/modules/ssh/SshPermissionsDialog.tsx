import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { formatBytes } from "@/lib/format";
import { useEffect, useState } from "react";
import {
  modeString,
  octal,
  parseOctal,
  PERMISSION_BITS,
  PERMISSION_CLASSES,
  SPECIAL_BITS,
} from "./permissions";
import { sftpChmod, sftpStat, type ChmodScope, type SftpStat } from "./sftp";

// Properties + permission editor for one remote entry, the panel's answer to
// WinSCP's F9 / FileZilla's "File permissions". Every field comes from a fresh
// `ssh_sftp_stat`, so it never shows a mode the tree cached minutes ago.
//
// Chmod is the only editable part. Owner and group are read-only: SFTP can
// carry a uid/gid in a setstat, but only root may apply one, and a numeric-id
// field that fails for every normal user is worse than no field at all.

/** Scopes offered once "apply to enclosed items" is ticked. `"none"` is the
 *  unticked state itself, so it is not among them. */
const SCOPES: { value: Exclude<ChmodScope, "none">; label: string }[] = [
  { value: "all", label: "All" },
  { value: "files", label: "Files only" },
  { value: "dirs", label: "Folders only" },
];

/** Unix seconds to a local date-time, or a dash when the server sent none. */
function formatTime(unixSeconds: number): string {
  if (!unixSeconds) return "-";
  return new Date(unixSeconds * 1000).toLocaleString();
}

function ownerLabel(name: string | null, id: number | null): string {
  if (name && id !== null) return `${name} (${id})`;
  if (name) return name;
  if (id !== null) return String(id);
  return "-";
}

type Props = {
  sessionId: number | null;
  /** Remote path to inspect. Null closes the dialog. */
  path: string | null;
  onClose: () => void;
  /** Re-read this directory after a successful chmod, so the row's mode
   *  string in the tree matches what was just applied. */
  onChanged: (path: string) => void;
};

export function SshPermissionsDialog({ sessionId, path, onClose, onChanged }: Props) {
  const [stat, setStat] = useState<SftpStat | null>(null);
  const [mode, setMode] = useState(0);
  /** Kept as text so a half-typed octal ("7" on the way to "755") is not
   *  snapped back to 0007 under the user's cursor. */
  const [octalText, setOctalText] = useState("");
  /** How far the chmod reaches; `"none"` IS the unticked checkbox, so a
   *  separate boolean would only be a second thing to keep in step. */
  const [scope, setScope] = useState<ChmodScope>("none");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = path !== null;

  useEffect(() => {
    if (!open || sessionId === null) return;
    let cancelled = false;
    setStat(null);
    setError(null);
    setBusy(false);
    setScope("none");
    void sftpStat(sessionId, path)
      .then((s) => {
        if (cancelled) return;
        setStat(s);
        const m = s.mode ?? 0;
        setMode(m);
        setOctalText(octal(m));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, sessionId, path]);

  const toggleBit = (bit: number) => {
    const next = mode ^ bit;
    setMode(next);
    setOctalText(octal(next));
  };

  const onOctalInput = (text: string) => {
    setOctalText(text);
    const parsed = parseOctal(text);
    if (parsed !== null) setMode(parsed);
  };

  const isDir = stat?.targetKind === "dir";
  const editable = stat !== null && stat.mode !== null;
  const dirty = editable && mode !== stat.mode;
  // Recursion is a change even when the target's own mode is untouched: it is
  // what pushes this mode down over the whole subtree.
  const recursing = isDir && scope !== "none";
  const canApply = editable && !busy && (dirty || recursing);

  const apply = async () => {
    if (sessionId === null || path === null) return;
    setBusy(true);
    setError(null);
    try {
      const summary = await sftpChmod(sessionId, path, mode, recursing ? scope : "none");
      const suffix = summary.failed > 0 ? `, ${summary.failed} skipped (permission denied)` : "";
      toast(
        summary.changed === 1
          ? `Permissions set to ${octal(mode)}`
          : `Permissions set to ${octal(mode)} on ${summary.changed} items${suffix}`,
        { variant: summary.failed > 0 ? "warning" : "success" },
      );
      onChanged(path);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const name = path ? (path.split("/").pop() ?? path) : "";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate">{name || "Permissions"}</DialogTitle>
          <DialogDescription className="font-mono text-[11px] break-all">{path}</DialogDescription>
        </DialogHeader>

        {stat === null ? (
          <div className="text-muted-foreground flex items-center gap-2 py-6 text-xs">
            {error === null ? (
              <>
                <Spinner className="size-3.5" />
                Reading remote metadata…
              </>
            ) : (
              <span className="text-destructive">{error}</span>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[11px]">
              <dt className="text-muted-foreground">Type</dt>
              <dd className="text-foreground/85">
                {stat.kind === "symlink"
                  ? `Symlink → ${stat.linkTarget ?? "?"}${
                      stat.targetKind === "broken" ? " (broken)" : ""
                    }`
                  : stat.kind === "dir"
                    ? "Folder"
                    : "File"}
              </dd>
              {!isDir && (
                <>
                  <dt className="text-muted-foreground">Size</dt>
                  <dd className="text-foreground/85 tabular-nums">
                    {formatBytes(stat.size)}
                    <span className="text-muted-foreground"> ({stat.size} bytes)</span>
                  </dd>
                </>
              )}
              <dt className="text-muted-foreground">Modified</dt>
              <dd className="text-foreground/85 tabular-nums">{formatTime(stat.mtime)}</dd>
              <dt className="text-muted-foreground">Owner</dt>
              <dd className="text-foreground/85">{ownerLabel(stat.user, stat.uid)}</dd>
              <dt className="text-muted-foreground">Group</dt>
              <dd className="text-foreground/85">{ownerLabel(stat.group, stat.gid)}</dd>
            </dl>

            {!editable ? (
              <div className="text-muted-foreground border-border/60 rounded-md border px-3 py-2 text-[11px]">
                This server did not report a mode for the entry, so permissions cannot be changed
                from here.
              </div>
            ) : (
              <>
                {stat.kind === "symlink" && (
                  <div className="text-muted-foreground border-border/60 rounded-md border px-3 py-2 text-[11px]">
                    A chmod through a symlink applies to its target. The mode below is the
                    target&apos;s.
                  </div>
                )}

                <div className="border-border/60 overflow-hidden rounded-md border">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-border/60 text-muted-foreground border-b">
                        <th className="px-2 py-1 text-left font-medium">Class</th>
                        {PERMISSION_BITS.map((b) => (
                          <th key={b.key} className="px-2 py-1 text-center font-medium">
                            {b.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {PERMISSION_CLASSES.map((c) => (
                        <tr key={c.key} className="border-border/40 border-b last:border-b-0">
                          <td className="text-foreground/85 px-2 py-1">{c.label}</td>
                          {PERMISSION_BITS.map((b) => {
                            const bit = b.bit << c.shift;
                            return (
                              <td key={b.key} className="px-2 py-1 text-center">
                                <Checkbox
                                  checked={(mode & bit) !== 0}
                                  onCheckedChange={() => toggleBit(bit)}
                                  aria-label={`${c.label} ${b.label}`}
                                />
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {SPECIAL_BITS.map((s) => (
                    <label
                      key={s.label}
                      title={s.hint}
                      className="text-foreground/85 flex cursor-pointer items-center gap-1.5 text-[11px]"
                    >
                      <Checkbox
                        checked={(mode & s.bit) !== 0}
                        onCheckedChange={() => toggleBit(s.bit)}
                      />
                      {s.label}
                    </label>
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  <label className="text-muted-foreground text-[11px]" htmlFor="ssh-perm-octal">
                    Octal
                  </label>
                  <Input
                    id="ssh-perm-octal"
                    value={octalText}
                    onChange={(e) => onOctalInput(e.target.value)}
                    onBlur={() => setOctalText(octal(mode))}
                    inputMode="numeric"
                    maxLength={4}
                    className="h-7 w-20 font-mono text-xs"
                    aria-label="Octal permission bits"
                  />
                  <span className="text-muted-foreground font-mono text-[11px]">
                    {modeString(mode)}
                  </span>
                </div>

                {isDir && (
                  <div className="space-y-2">
                    <label className="text-foreground/85 flex cursor-pointer items-center gap-1.5 text-[11px]">
                      <Checkbox
                        checked={scope !== "none"}
                        onCheckedChange={(v) => setScope(v === true ? "all" : "none")}
                      />
                      Apply to enclosed items
                    </label>
                    {scope !== "none" && (
                      <>
                        <div className="flex gap-1.5">
                          {SCOPES.map((s) => (
                            <Button
                              key={s.value}
                              type="button"
                              size="xs"
                              variant={scope === s.value ? "default" : "outline"}
                              onClick={() => setScope(s.value)}
                            >
                              {s.label}
                            </Button>
                          ))}
                        </div>
                        {/* The reason the scope selector exists: a flat
                            recursive 644 strips `x` off every directory and
                            locks the user out of their own tree. */}
                        {scope === "all" && (mode & 0o111) === 0 && (
                          <p className="text-icon-working text-[11px]">
                            This removes execute from every folder too, which makes them
                            unenterable. Use “Files only”.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}

                {error !== null && <p className="text-destructive text-[11px]">{error}</p>}
              </>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void apply()} disabled={!canApply}>
            {busy && <Spinner className="size-3.5" />}
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
