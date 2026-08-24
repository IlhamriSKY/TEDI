import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "@/components/ui/toast";
import { sftpDownload, sftpUpload, type TransferProgress, type TransferSummary } from "./sftp";

// Every byte that moves between this machine and the remote goes through here:
// the OS-level drag-drop listener below, the explorer's Upload/Download menu
// items, and the internal drag between explorer rows. One place owns the
// progress state, so the panel needs a single strip whichever direction the
// bytes are flowing.
//
// Drops from outside the WebView ride Tauri's `tauri://drag-drop` (the same
// OS-level target the terminal file-drop uses); we hit-test the drop point
// against this panel's `[data-fs-drop]` zones so a drop meant for a terminal
// or another surface is ignored. A folder row takes the drop directly, a file
// row hands it to its parent, and the tree body takes it into the current
// root. Write permission is enforced by the remote kernel.

/** In-flight transfer, or null when idle. Drives the explorer's progress
 *  strip; `kind` picks the verb. */
export type SshTransferState = TransferProgress & { kind: "upload" | "download" };

/** The gap between "user asked" and the first byte: the Rust side still has
 *  to walk the tree before it knows any total. `count: 0` is what the progress
 *  strip reads as "preparing". */
const STARTING: TransferProgress = {
  index: 0,
  count: 0,
  name: "",
  written: 0,
  total: 0,
  bytesDone: 0,
  bytesTotal: 0,
};

/** One toast for the whole job. A partial failure is a warning, not an error:
 *  the files that did land are still there. */
function reportSummary(verb: string, summary: TransferSummary, where: string): void {
  const { ok, failed } = summary;
  if (failed.length === 0) {
    toast(`${verb} ${ok} file${ok === 1 ? "" : "s"} to ${where}`, { variant: "success" });
    return;
  }
  console.error("ssh transfer failures:", failed);
  toast(`${verb} ${ok}/${ok + failed.length} - ${failed.length} failed (${failed[0]})`, {
    variant: "warning",
  });
}

type Params = {
  sessionId: number | null;
  containerRef: RefObject<HTMLElement | null>;
  /** Re-read a remote directory once something has landed in it. */
  onUploaded: (remoteDir: string) => void;
};

export function useSshTransfers({ sessionId, containerRef, onUploaded }: Params) {
  const [transfer, setTransfer] = useState<SshTransferState | null>(null);

  // Latest callback kept in a ref so the Tauri listener subscribes once per
  // session instead of re-subscribing on every tree re-render (which could
  // drop an in-flight drag event).
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const runUpload = useCallback(
    async (localPaths: string[], remoteDir: string) => {
      if (sessionId === null || localPaths.length === 0) return;
      setTransfer({ kind: "upload", ...STARTING });
      try {
        const summary = await sftpUpload(sessionId, localPaths, remoteDir, (p) =>
          setTransfer({ kind: "upload", ...p }),
        );
        reportSummary("Uploaded", summary, remoteDir);
      } catch (e) {
        // A rejected command means the job never started (bad path, oversized
        // tree, dead session) - there is no partial result to report.
        toast(`Upload failed: ${String(e)}`, { variant: "error" });
      } finally {
        setTransfer(null);
        onUploadedRef.current(remoteDir);
      }
    },
    [sessionId],
  );

  const runDownload = useCallback(
    async (remotePaths: string[], localDir: string) => {
      if (sessionId === null || remotePaths.length === 0) return;
      setTransfer({ kind: "download", ...STARTING });
      try {
        const summary = await sftpDownload(sessionId, remotePaths, localDir, (p) =>
          setTransfer({ kind: "download", ...p }),
        );
        reportSummary("Downloaded", summary, localDir);
      } catch (e) {
        toast(`Download failed: ${String(e)}`, { variant: "error" });
      } finally {
        setTransfer(null);
      }
    },
    [sessionId],
  );

  const runUploadRef = useRef(runUpload);
  runUploadRef.current = runUpload;

  useEffect(() => {
    if (sessionId === null) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    // The row currently outlined as the drop target. Shares the class the
    // synthesized internal drag uses, so both gestures look identical.
    let marked: HTMLElement | null = null;

    const highlight = (el: HTMLElement | null) => {
      if (el === marked) return;
      marked?.classList.remove("tedi-fs-drop-target");
      marked = el;
      el?.classList.add("tedi-fs-drop-target");
    };

    // The drop zone under a window point (physical px, as Tauri reports),
    // or null when the point isn't over one of this panel's zones.
    const zoneAtPoint = (physX: number, physY: number): { dir: string; el: HTMLElement } | null => {
      const dpr = window.devicePixelRatio || 1;
      const under = document.elementFromPoint(physX / dpr, physY / dpr);
      const container = containerRef.current;
      if (!under || !container || !container.contains(under)) return null;
      const el = under.closest<HTMLElement>("[data-fs-drop]");
      const dir = el?.getAttribute("data-fs-drop");
      return el && dir ? { dir, el } : null;
    };

    getCurrentWebviewWindow()
      .onDragDropEvent(async (event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          highlight(null);
          return;
        }
        if (payload.type === "enter" || payload.type === "over") {
          highlight(zoneAtPoint(payload.position.x, payload.position.y)?.el ?? null);
          return;
        }
        if (payload.type !== "drop") return;
        highlight(null);
        const { position, paths } = payload;
        if (!paths || paths.length === 0) return;
        const zone = zoneAtPoint(position.x, position.y);
        if (!zone) return; // dropped elsewhere (e.g. a terminal)
        await runUploadRef.current(paths, zone.dir);
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch((err) => console.error("ssh drag-drop listen failed:", err));

    return () => {
      cancelled = true;
      highlight(null);
      unlisten?.();
    };
  }, [sessionId, containerRef]);

  return { transfer, runUpload, runDownload };
}
