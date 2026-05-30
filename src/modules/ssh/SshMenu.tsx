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
  Delete02Icon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@/lib/utils";
import { TOOLBAR_EXPANDED, TOOLBAR_HOVER } from "@/lib/toolbarButton";
import { lazy, Suspense, useEffect, useState } from "react";
import {
  deleteConnection,
  listConnections,
  onConnectionsChanged,
  type SshConnection,
} from "./connections";

// Heavy module. Lazy-load until the user opens the add/edit modal.
const SshConnectionDialog = lazy(() =>
  import("./SshConnectionDialog").then((m) => ({ default: m.SshConnectionDialog })),
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
                // Override Radix's blue focus styling with a muted hover so
                // the row reads as a list entry, not a primary action.
                // `**:text-current!` blocks the parent cascade from
                // recolouring child icons.
                className="group focus:bg-muted! focus:text-foreground! flex items-center justify-between gap-2 pr-1 text-[12px] focus:**:text-current!"
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
        // onSelect (the row's connect action).
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        className={cn(
          "flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors",
          danger
            ? "text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <HugeiconsIcon icon={icon} size={12} strokeWidth={1.75} />
      </button>
    </IconTooltip>
  );
}
