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
import { SelectionAskAi } from "@/modules/ai";
import { type SshConnection } from "@/modules/ssh/connections";
import { HostKeyPromptDialog } from "@/modules/ssh/HostKeyPromptDialog";
import { AnimatePresence } from "motion/react";
import { lazy, Suspense, type Dispatch, type SetStateAction } from "react";
import { type PendingClose } from "../hooks/useTabActions";

// Dialogs mount only while `open` is true.
const NewEditorDialog = lazy(() =>
  import("@/modules/editor/NewEditorDialog").then((m) => ({ default: m.NewEditorDialog })),
);
const SshConnectionDialog = lazy(() =>
  import("@/modules/ssh/SshConnectionDialog").then((m) => ({ default: m.SshConnectionDialog })),
);

type Props = {
  askPopup: { x: number; y: number } | null;
  onAskFromSelection: () => void;
  setAskPopup: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  newEditorMounted: boolean;
  newEditorOpen: boolean;
  setNewEditorOpen: Dispatch<SetStateAction<boolean>>;
  explorerRoot: string | null;
  home: string | null;
  openFileTab: (path: string) => void;
  sshEditorMounted: boolean;
  sshEditorOpen: boolean;
  setSshEditorOpen: Dispatch<SetStateAction<boolean>>;
  editingSshConn: SshConnection | null;
  setEditingSshConn: Dispatch<SetStateAction<SshConnection | null>>;
  pendingClose: PendingClose | null;
  cancelClose: () => void;
  confirmClose: () => void;
};

/**
 * The dialog/overlay JSX cluster lifted out of App's render tree: the
 * ask-from-selection popup, the lazy NewEditor / SSH dialogs, and the
 * close-confirmation AlertDialog. Every value/handler it uses arrives as an
 * explicit prop; the lazy() + Suspense wrappers and conditional mounting are
 * preserved verbatim.
 */
export function AppDialogs({
  askPopup,
  onAskFromSelection,
  setAskPopup,
  newEditorMounted,
  newEditorOpen,
  setNewEditorOpen,
  explorerRoot,
  home,
  openFileTab,
  sshEditorMounted,
  sshEditorOpen,
  setSshEditorOpen,
  editingSshConn,
  setEditingSshConn,
  pendingClose,
  cancelClose,
  confirmClose,
}: Props) {
  return (
    <>
      <AnimatePresence>
        {askPopup ? (
          <SelectionAskAi
            key="ask-ai-popup"
            x={askPopup.x}
            y={askPopup.y}
            onAsk={onAskFromSelection}
            onDismiss={() => setAskPopup(null)}
          />
        ) : null}
      </AnimatePresence>

      {/* Mount-once. Defers the chunk until first open, then stays
          mounted so Radix's exit animation plays and reopens skip the
          chunk-load cost. */}
      {newEditorMounted ? (
        <Suspense fallback={null}>
          <NewEditorDialog
            open={newEditorOpen}
            onOpenChange={setNewEditorOpen}
            rootPath={explorerRoot ?? home}
            onCreated={(path) => openFileTab(path)}
          />
        </Suspense>
      ) : null}

      {sshEditorMounted ? (
        <Suspense fallback={null}>
          <SshConnectionDialog
            open={sshEditorOpen}
            onOpenChange={(o) => {
              setSshEditorOpen(o);
              if (!o) setEditingSshConn(null);
            }}
            editing={editingSshConn}
          />
        </Suspense>
      ) : null}

      <AlertDialog open={pendingClose !== null} onOpenChange={(open) => !open && cancelClose()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingClose?.reason === "running" ? "Process Running" : "Unsaved Changes"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingClose?.reason === "running"
                ? pendingClose.title
                  ? `"${pendingClose.title}" still has a process running. Closing it will stop the process. Close anyway?`
                  : "A process is still running. Closing it will stop the process. Close anyway?"
                : pendingClose?.title
                  ? `"${pendingClose.title}" has unsaved changes. Close anyway?`
                  : "This file has unsaved changes. Close anyway?"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={cancelClose}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmClose}>Close Anyway</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Blocking confirmation for a NEW SSH host key (trust-on-first-use).
          Self-contained: reads its own queue store, shown only when the backend
          pauses a first-connect handshake awaiting fingerprint verification. */}
      <HostKeyPromptDialog />
    </>
  );
}
