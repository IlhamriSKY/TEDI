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
import {
  Add01Icon,
  CloudServerIcon,
  Copy01Icon,
  Delete02Icon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { lazy, Suspense, useEffect, useState } from "react";
import {
  deleteConnection,
  getConnectionSecrets,
  listConnections,
  newConnectionId,
  onConnectionsChanged,
  upsertConnection,
  type SshConnection,
} from "./connections";
import { formatRelative } from "./components/SshStatusPill";

// Heavy module (keyring round-trip, multi-step form). Defer until the user
// actually opens the add/edit modal so it doesn't ride along on every SSH
// menu open.
const SshConnectionDialog = lazy(() =>
  import("./SshConnectionDialog").then((m) => ({ default: m.SshConnectionDialog })),
);

type Props = {
  /** Open a saved host as a new terminal tab in the main window. */
  onConnect: (conn: SshConnection) => void;
};

export function SshMenu({ onConnect }: Props) {
  const [conns, setConns] = useState<SshConnection[] | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  // Latches the first time the editor dialog is opened. Keeps the (lazy)
  // dialog mounted afterwards so Radix's exit animation can play normally on
  // close — see the matching latch in App.tsx.
  const [editorMounted, setEditorMounted] = useState(false);
  useEffect(() => {
    if (editorOpen) setEditorMounted(true);
  }, [editorOpen]);
  const [editing, setEditing] = useState<SshConnection | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<SshConnection | null>(null);

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

  const duplicate = async (c: SshConnection) => {
    setMenuOpen(false);
    const secrets = await getConnectionSecrets(c.id);
    const copy: SshConnection = {
      ...c,
      id: newConnectionId(),
      name: `${c.name} copy`,
      hasPassword: false,
      hasPrivateKey: false,
      hasKeyPassphrase: false,
      lastConnectedAt: undefined,
      lastFingerprint: undefined,
    };
    await upsertConnection(copy, {
      password: secrets.password ?? undefined,
      privateKey: secrets.privateKey ?? undefined,
      keyPassphrase: secrets.keyPassphrase ?? undefined,
    });
  };

  const onPick = (c: SshConnection) => {
    setMenuOpen(false);
    onConnect(c);
  };

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <IconTooltip label="SSH connections">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:bg-accent hover:text-foreground size-7 shrink-0 rounded-md"
              aria-label="SSH connections"
            >
              <HugeiconsIcon icon={CloudServerIcon} size={15} strokeWidth={1.75} />
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
                // Override Radix' default `focus:bg-accent focus:text-accent-foreground`
                // (blue highlight) with a neutral muted hover so the row reads
                // as a regular list entry, not a "selected primary action".
                // `**:text-current!` neutralises the parent's
                // `**:text-accent-foreground` cascade that was repainting
                // every descendant (including delete/edit icons).
                className="group focus:bg-muted! focus:text-foreground! flex items-center justify-between gap-2 pr-1 text-[12px] focus:**:text-current!"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{c.name}</span>
                  <span className="text-muted-foreground truncate font-mono text-[10px]">
                    {c.user}@{c.host}:{c.port}
                    {c.lastConnectedAt ? ` · last ${formatRelative(c.lastConnectedAt)}` : ""}
                  </span>
                </span>
                {/* Action buttons. preventDefault on click stops Radix'
                    DropdownMenuItem from firing its row-level onSelect
                    (which would also fire "connect"). stopPropagation on
                    pointerDown keeps the menu's focus heuristics from
                    treating the click as a row select. */}
                <span className="ml-1 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <RowIconButton
                    label={`Duplicate ${c.name}`}
                    onClick={() => void duplicate(c)}
                    icon={Copy01Icon}
                  />
                  <RowIconButton
                    label={`Edit ${c.name}`}
                    onClick={() => openEdit(c)}
                    icon={PencilEdit01Icon}
                  />
                  <RowIconButton
                    label={`Delete ${c.name}`}
                    onClick={() => askDelete(c)}
                    icon={Delete02Icon}
                    danger
                  />
                </span>
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openAdd} className="gap-2 text-[12px]">
            <HugeiconsIcon icon={Add01Icon} size={13} strokeWidth={1.75} />
            <span>Add new connection…</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {editorMounted ? (
        <Suspense fallback={null}>
          <SshConnectionDialog open={editorOpen} onOpenChange={setEditorOpen} editing={editing} />
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
  icon: typeof PencilEdit01Icon;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      // Fire on mousedown so the action runs *before* Radix' DropdownMenuItem
      // can react to pointerup and flash the row as highlighted/selected.
      // preventDefault keeps focus from shifting to this button (which would
      // also paint the row blue via Radix' :focus styling on parent).
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      // Block pointer/click propagation entirely so the parent DropdownMenuItem
      // never sees these and never fires its `onSelect` (which would also
      // trigger the row's connect action).
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      className={cn(
        "text-foreground flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors",
        danger ? "hover:bg-destructive/15 hover:text-destructive" : "hover:bg-muted-foreground/15",
      )}
    >
      <HugeiconsIcon icon={icon} size={12} strokeWidth={1.75} />
    </button>
  );
}
