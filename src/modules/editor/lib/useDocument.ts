import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { sftpReadFile, sftpWriteFile } from "@/modules/ssh/sftp";

type ReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "image"; dataUrl: string; mime: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

export type DocumentState =
  | { status: "loading" }
  | { status: "ready"; content: string; size: number }
  | { status: "image"; dataUrl: string; mime: string; size: number }
  | { status: "binary"; size: number }
  | { status: "toolarge"; size: number; limit: number }
  | { status: "error"; message: string };

type Options = {
  path: string;
  onDirtyChange?: (dirty: boolean) => void;
  /** When set, read/write goes through SFTP on the matching russh session
   *  instead of the local FS. Remote files are text-only for now (the
   *  Rust SFTP wrapper rejects non-UTF-8), so binary/image previews
   *  aren't supported on the remote path. */
  sshSessionId?: number;
};

export function useDocument({ path, onDirtyChange, sshSessionId }: Options) {
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);
  /** Live (unsaved) buffer mirrored from `onChange`. Drives surfaces that
   *  need to see in-progress edits, e.g. the markdown preview overlay. */
  const [liveContent, setLiveContent] = useState<string>("");

  // Track the saved buffer so we can detect changes cheaply.
  const savedRef = useRef<string>("");
  const bufferRef = useRef<string>("");
  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Notify parent of dirty transitions.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  // Load on path change or explicit reload.
  useEffect(() => {
    let cancelled = false;
    setDoc({ status: "loading" });
    setDirty(false);

    const load = async () => {
      if (sshSessionId !== undefined) {
        // SFTP path: backend already rejects non-UTF-8 with a clear message;
        // size comes from the byte length of what we received. We skip the
        // binary/image/toolarge branches entirely since the Rust side
        // doesn't surface those signals over SFTP yet.
        try {
          const content = await sftpReadFile(sshSessionId, path);
          if (cancelled) return;
          savedRef.current = content;
          bufferRef.current = content;
          setLiveContent(content);
          setDoc({
            status: "ready",
            content,
            size: new TextEncoder().encode(content).length,
          });
        } catch (e) {
          if (!cancelled) setDoc({ status: "error", message: String(e) });
        }
        return;
      }

      try {
        const res = await invoke<ReadResult>("fs_read_file", { path });
        if (cancelled) return;
        if (res.kind === "text") {
          savedRef.current = res.content;
          bufferRef.current = res.content;
          setLiveContent(res.content);
          setDoc({
            status: "ready",
            content: res.content,
            size: res.size,
          });
        } else if (res.kind === "image") {
          setDoc({
            status: "image",
            dataUrl: res.dataUrl,
            mime: res.mime,
            size: res.size,
          });
        } else if (res.kind === "binary") {
          setDoc({ status: "binary", size: res.size });
        } else if (res.kind === "toolarge") {
          setDoc({
            status: "toolarge",
            size: res.size,
            limit: res.limit,
          });
        }
      } catch (e) {
        if (!cancelled) setDoc({ status: "error", message: String(e) });
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [path, sshSessionId, reloadCounter]);

  /** Re-read the file from disk. No-op (silent) if the buffer is dirty -
   *  callers shouldn't clobber unsaved user edits. Returns whether reload ran. */
  const reload = useCallback((): boolean => {
    if (dirtyRef.current) return false;
    setReloadCounter((n) => n + 1);
    return true;
  }, []);

  const onChange = useCallback((next: string) => {
    bufferRef.current = next;
    setDirty(next !== savedRef.current);
    setLiveContent(next);
  }, []);

  const save = useCallback(async () => {
    if (!dirty) return;
    const content = bufferRef.current;
    if (sshSessionId !== undefined) {
      await sftpWriteFile(sshSessionId, path, content);
    } else {
      await invoke("fs_write_file", { path, content });
    }
    savedRef.current = content;
    setDirty(false);
  }, [path, sshSessionId, dirty]);

  return { doc, dirty, liveContent, onChange, save, reload };
}
