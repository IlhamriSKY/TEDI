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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconTooltip } from "@/components/ui/icon-tooltip";
import { cn } from "@/lib/utils";
import { DESTRUCTIVE_ACTION, TOOLBAR_EXPANDED, TOOLBAR_HOVER } from "@/lib/toolbarButton";
import { lazy, Suspense, useEffect, useState } from "react";
import {
  deleteConnection,
  listConnections,
  onConnectionsChanged,
  type SshConnection,
} from "./connections";
import type { BackupMode } from "./SshBackupDialog";
import type { FsReadResult } from "@/lib/ipc";
import { BACKUP_EXTENSION } from "./backupFile";
import { invoke } from "@tauri-apps/api/core";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Download, Pencil, Plus, Server, Trash2, Upload, type LucideIcon } from "lucide-react";

// Heavy module. Lazy-load until the user opens the add/edit modal.
const SshConnectionDialog = lazy(() =>
  import("./SshConnectionDialog").then((m) => ({ default: m.SshConnectionDialog })),
);

// Same treatment: the backup dialog pulls in the crypto/IO path, which nobody
// pays for until they actually move machines.
const SshBackupDialog = lazy(() =>
  import("./SshBackupDialog").then((m) => ({ default: m.SshBackupDialog })),
);

type Props = {
  /** Opens a saved host as a new terminal tab. `opts.private` is kept for
   *  backward compatibility with callers that still pass it; the SSH menu
   *  itself no longer exposes a private-mode shortcut button. */
  onConnect: (conn: SshConnection, opts?: { private?: boolean }) => void;
};

export function SshMenu({ onConnect }: Props) {
  const [conns, setConns] = useState<SshConnection[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Latches once the editor opens. Keeps the lazy dialog mounted so Radix's
  // close animation can play. Mirrors the latch in App.tsx.
  const [editorMounted, setEditorMounted] = useState(false);
  useEffect(() => {
    if (editorOpen) setEditorMounted(true);
  }, [editorOpen]);
  const [editing, setEditing] = useState<SshConnection | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SshConnection | null>(null);
  const [backup, setBackup] = useState<BackupMode | null>(null);
  const [backupOpen, setBackupOpen] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  useEffect(() => {
    void listConnections().then(setConns);
    const unsub = onConnectionsChanged(() => void listConnections().then(setConns));
    return () => {
      void unsub.then((fn) => fn());
    };
  }, []);

  const openAdd = () => {
    setEditing(null);
    setEditorOpen(true);
    setMenuOpen(false);
  };

  const openEdit = (c: SshConnection) => {
    setEditing(c);
    setEditorOpen(true);
    setMenuOpen(false);
  };

  const askDelete = (c: SshConnection) => {
    setConfirmDelete(c);
    setMenuOpen(false);
  };

  const onPick = (c: SshConnection) => {
    setMenuOpen(false);
    onConnect(c);
  };

  const openExport = () => {
    setPickError(null);
    setBackup({ kind: "export" });
    setBackupOpen(true);
    setMenuOpen(false);
  };

  // The file is picked and read BEFORE the dialog opens, so an unreadable or
  // wrong-type file is rejected up front instead of after the user has typed a
  // passphrase for it.
  const openImport = async () => {
    setPickError(null);
    setMenuOpen(false);
    try {
      const selected = await openFileDialog({
        multiple: false,
        filters: [{ name: "TEDI SSH backup", extensions: [BACKUP_EXTENSION, "json"] }],
      });
      const path = typeof selected === "string" ? selected : null;
      if (!path) return;
      const result = await invoke<FsReadResult>("fs_read_file", { path });
      if (result.kind !== "text") {
        setPickError("That file is not a UTF-8 text file.");
        return;
      }
      setBackup({ kind: "import", path, text: result.content });
      setBackupOpen(true);
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <IconTooltip label="SSH connections">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "text-muted-foreground",
                TOOLBAR_HOVER,
                TOOLBAR_EXPANDED,
                "size-7 shrink-0 rounded-md",
              )}
              aria-label="SSH connections"
            >
              <Server size={15} strokeWidth={1.75} />
            </Button>
          </DropdownMenuTrigger>
        </IconTooltip>
        <DropdownMenuContent align="end" className="w-72 min-w-72">
          <DropdownMenuLabel className="text-muted-foreground text-[10px] tracking-wide uppercase">
            SSH connections
          </DropdownMenuLabel>
          {conns === null ? (
            <div className="text-muted-foreground px-3 py-2 text-[11px]">Loading…</div>
          ) : conns.length === 0 ? (
            <div className="text-muted-foreground px-3 py-2 text-[11px]">No saved hosts yet.</div>
          ) : (
            conns.map((c) => (
              <DropdownMenuItem
                key={c.id}
                onSelect={() => onPick(c)}
                // Override Radix's blue focus styling with a muted hover so
                // the row reads as a list entry, not a primary action.
                // `[&_span]:text-current!` blocks the parent cascade from
                // recolouring the label spans (including the muted host line,
                // which is a grandchild). Scoped to spans on purpose: a bare
                // `**:` also swept the row's action BUTTONS, and being important
                // it out-ranked their own colour and greyed out the red trash.
                className="group focus:bg-muted! focus:text-foreground! flex items-center justify-between gap-2 pr-1 text-[12px] focus:[&_span]:text-current!"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{c.name}</span>
                  <span className="text-muted-foreground truncate font-mono text-[10px]">
                    {c.user}@{c.host}:{c.port}
                  </span>
                </span>
                {/* Action buttons. preventDefault on click blocks the row's
                    onSelect (which would also trigger connect).
                    stopPropagation on pointerDown stops the menu treating
                    the click as a row select. Icons stay visible at rest
                    (no opacity fade) so the affordance is discoverable
                    without hovering each row. */}
                <span className="ml-1 flex shrink-0 items-center gap-0.5">
                  <RowIconButton
                    label={`Edit ${c.name}`}
                    onClick={() => openEdit(c)}
                    icon={Pencil}
                  />
                  <RowIconButton
                    label={`Delete ${c.name}`}
                    onClick={() => askDelete(c)}
                    icon={Trash2}
                    danger
                  />
                </span>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openAdd} className="gap-2 text-[12px]">
            <Plus size={13} strokeWidth={1.75} />
            <span>Add new connection…</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={openExport}
            disabled={conns !== null && conns.length === 0}
            className="gap-2 text-[12px]"
          >
            <Download size={13} strokeWidth={1.75} />
            <span>Export connections…</span>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void openImport()} className="gap-2 text-[12px]">
            <Upload size={13} strokeWidth={1.75} />
            <span>Import connections…</span>
          </DropdownMenuItem>
          {pickError ? (
            <div className="text-destructive px-3 py-1 text-[10.5px]">{pickError}</div>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {editorMounted ? (
        <Suspense fallback={null}>
          <SshConnectionDialog open={editorOpen} onOpenChange={setEditorOpen} editing={editing} />
        </Suspense>
      ) : null}

      {/* Unmounted once closed, unlike the editor above: the dialog holds a
          passphrase and, for an import, the decrypted file text in state, so
          there is no reason to keep either resident for a close animation. */}
      {backup ? (
        <Suspense fallback={null}>
          <SshBackupDialog
            open={backupOpen}
            onOpenChange={(o) => {
              setBackupOpen(o);
              if (!o) setBackup(null);
            }}
            mode={backup}
          />
        </Suspense>
      ) : null}

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete connection?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete
                ? `"${confirmDelete.name}" will be removed and its stored credentials wiped from the keychain.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const target = confirmDelete;
                setConfirmDelete(null);
                if (target) await deleteConnection(target.id);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function RowIconButton({
  label,
  onClick,
  icon,
  danger,
}: {
  label: string;
  onClick: () => void;
  icon: LucideIcon;
  danger?: boolean;
}) {
  const Icon = icon;
  return (
    <IconTooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        // Run on mousedown, before the row's pointerup fires and highlights it.
        // preventDefault stops focus shifting here (which would also blue-paint
        // the parent row via Radix focus styling).
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onClick();
        }}
        // Block propagation so the parent DropdownMenuItem never fires its
        // onSelect (the row's connect action). Both pointer events must be
        // stopped: Radix's menu item records isPointerDownRef on its own
        // pointerdown, and if it never sees one (because we swallowed it) it
        // synthesizes a click() on itself at pointerup - which would connect
        // and open a tab. Stopping pointerup blocks that synthetic select.
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className={cn(
          "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors",
          danger
            ? DESTRUCTIVE_ACTION
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Icon size={12} strokeWidth={1.75} />
      </button>
    </IconTooltip>
  );
}
