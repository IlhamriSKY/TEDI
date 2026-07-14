import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "@/components/ui/toast";
import { localBasename, sftpUpload } from "./sftp";

/** In-flight upload progress, or null when idle. Drives the explorer's
 *  progress strip. `index`/`count` are 1-based for display. */
export type SshUploadState = {
  name: string;
  index: number;
  count: number;
  written: number;
  total: number;
};

// Drag-and-drop upload: drop OS files onto the SSH file tree to SFTP them to the
// remote. Rides Tauri's `tauri://drag-drop` (the same OS-level target the
// terminal file-drop uses); we hit-test the drop point against this panel's
// rows so a drop meant for a terminal or another surface is ignored. A drop on
// a folder row uploads into it, on a file row into its parent dir, on empty
// tree area into the root. Write permission is enforced by the remote kernel.

function joinRemote(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function remoteDirname(path: string): string {
  const i = path.lastIndexOf("/");
  if (i <= 0) return "/";
  return path.slice(0, i);
}

type Params = {
  sessionId: number | null;
  rootPath: string | null;
  containerRef: RefObject<HTMLElement | null>;
  /** Refetch a remote directory's children after an upload lands there. */
  onUploaded: (remoteDir: string) => void;
};

export function useSshFileDrop({
  sessionId,
  rootPath,
  containerRef,
  onUploaded,
}: Params): SshUploadState | null {
  // Latest callback kept in a ref so the Tauri listener subscribes once per
  // session/root instead of re-subscribing on every tree re-render (which
  // could drop an in-flight drag event).
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const [upload, setUpload] = useState<SshUploadState | null>(null);

  useEffect(() => {
    if (sessionId === null || !rootPath) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const highlight = (on: boolean) => {
      const el = containerRef.current;
      if (!el) return;
      // Inline outline avoids any CSS plumbing; cleared by passing "".
      el.style.outline = on ? "2px solid var(--ring)" : "";
      el.style.outlineOffset = on ? "-2px" : "";
    };

    // Remote directory under a window point (physical px, as Tauri reports),
    // or null when the point isn't over this panel.
    const dirAtPoint = (physX: number, physY: number): string | null => {
      const dpr = window.devicePixelRatio || 1;
      const under = document.elementFromPoint(physX / dpr, physY / dpr) as HTMLElement | null;
      const container = containerRef.current;
      if (!under || !container || !container.contains(under)) return null;
      const row = under.closest<HTMLElement>("[data-fs-path]");
      const p = row?.getAttribute("data-fs-path");
      if (!p) return rootPath; // over the panel but not a row -> root
      return row?.getAttribute("data-fs-kind") === "dir" ? p : remoteDirname(p);
    };

    getCurrentWebviewWindow()
      .onDragDropEvent(async (event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          highlight(false);
          return;
        }
        if (payload.type === "enter" || payload.type === "over") {
          highlight(dirAtPoint(payload.position.x, payload.position.y) !== null);
          return;
        }
        if (payload.type !== "drop") return;
        highlight(false);
        const { position, paths } = payload;
        if (!paths || paths.length === 0 || sessionId === null) return;
        const dir = dirAtPoint(position.x, position.y);
        if (dir === null) return; // dropped elsewhere (e.g. a terminal)

        const failures: string[] = [];
        for (let i = 0; i < paths.length; i++) {
          const local = paths[i];
          const name = localBasename(local);
          setUpload({ name, index: i + 1, count: paths.length, written: 0, total: 0 });
          try {
            await sftpUpload(sessionId, local, joinRemote(dir, name), (p) =>
              setUpload({ name, index: i + 1, count: paths.length, ...p }),
            );
          } catch (e) {
            failures.push(`${name}: ${String(e)}`);
          }
        }
        setUpload(null);
        onUploadedRef.current(dir);
        const ok = paths.length - failures.length;
        if (failures.length === 0) {
          toast(`Uploaded ${ok} file${ok === 1 ? "" : "s"} to ${dir}`, { variant: "success" });
        } else {
          console.error("ssh upload failures:", failures);
          toast(`Uploaded ${ok}/${paths.length} - ${failures.length} failed (${failures[0]})`, {
            variant: "warning",
          });
        }
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch((err) => console.error("ssh drag-drop listen failed:", err));

    return () => {
      cancelled = true;
      highlight(false);
      unlisten?.();
    };
  }, [sessionId, rootPath, containerRef]);

  return upload;
}
