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
import { type QuitGuard } from "../hooks/useQuitGuard";
import { type PendingClose } from "../hooks/useTabActions";
import { type PaneLayout } from "@/modules/terminal";

// Dialogs mount only while `open` is true.
const NewEditorDialog = lazy(() =>
  import("@/modules/editor/NewEditorDialog").then((m) => ({ default: m.NewEditorDialog })),
);
const SshConnectionDialog = lazy(() =>
  import("@/modules/ssh/SshConnectionDialog").then((m) => ({ default: m.SshConnectionDialog })),
);
const AgentSpawnDialog = lazy(() =>
  import("@/modules/tabs/components/AgentSpawnDialog").then((m) => ({
    default: m.AgentSpawnDialog,
  })),
);

type Props = {
  askPopup: { x: number; y: number } | null;
  onAskFromSelection: () => void;
  setAskPopup: Dispatch<SetStateAction<{ x: number; y: number } | null>>;
  agentDialogMounted: boolean;
  agentDialogOpen: boolean;
  setAgentDialogOpen: Dispatch<SetStateAction<boolean>>;
  /** Spawn one terminal per picked agent id, arranged by `layout`. */
  onSpawnAgents: (agentIds: string[], layout: PaneLayout) => void;
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
  quitGuard: QuitGuard;
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
  agentDialogMounted,
  agentDialogOpen,
  setAgentDialogOpen,
  onSpawnAgents,
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
  quitGuard,
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

      {agentDialogMounted ? (
        <Suspense fallback={null}>
          <AgentSpawnDialog
            open={agentDialogOpen}
            onOpenChange={setAgentDialogOpen}
            onSpawn={onSpawnAgents}
          />
        </Suspense>
      ) : null}

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

      {/* Quit prompt. Only shown when a terminal is actually busy; the two
          actions differ in what happens to those shells, since the PTY daemon
          outlives the GUI. */}
      <AlertDialog
        open={quitGuard.busyCount !== null}
        onOpenChange={(open) => !open && quitGuard.cancel()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {quitGuard.busyCount === 1
                ? "1 terminal is still running"
                : `${quitGuard.busyCount ?? 0} terminals are still running`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Leave them running and they keep going in the background, then reattach the next time
              you open TEDI. Closing them stops whatever they are doing right now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Three choices don't fit the shared two-column footer; stack them.
              Cancel stays last so Radix's open-auto-focus lands on it. */}
          <AlertDialogFooter className="grid-cols-1">
            <AlertDialogAction onClick={() => quitGuard.quit(false)}>
              Leave them running
            </AlertDialogAction>
            <AlertDialogAction variant="destructive" onClick={() => quitGuard.quit(true)}>
              Close all terminals
            </AlertDialogAction>
            <AlertDialogCancel onClick={quitGuard.cancel}>Cancel</AlertDialogCancel>
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
