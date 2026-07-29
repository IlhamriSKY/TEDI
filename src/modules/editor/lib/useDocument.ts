import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { sftpReadFile, sftpWriteFile } from "@/modules/ssh/sftp";
import type { FsReadResult } from "@/lib/ipc";
import { notifyMemoryPathChanged } from "@/modules/ai/lib/memoryCache";
import { notifySkillPathChanged } from "@/modules/ai/lib/skillCache";

type ReadResult = FsReadResult;

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
  /** Route read/write through SFTP on the matching russh session instead of
   *  the local FS. Remote files are text-only (the SFTP wrapper rejects
   *  non-UTF-8), so binary/image previews aren't supported remotely. */
  sshSessionId?: number;
};

export function useDocument({ path, onDirtyChange, sshSessionId }: Options) {
  const [doc, setDoc] = useState<DocumentState>({ status: "loading" });
  const [dirty, setDirty] = useState(false);
  const [reloadCounter, setReloadCounter] = useState(0);
  /** Live (unsaved) buffer mirrored from `onChange`. Used by the markdown
   *  preview overlay and other surfaces that need in-progress edits. */
  const [liveContent, setLiveContent] = useState<string>("");

  // Saved buffer reference for cheap change detection.
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

  /** Path this effect last loaded, to tell a real path change from a remote
   *  leaf rebinding to a fresh session. */
  const loadedPathRef = useRef<string | null>(null);

  // Load on path change or explicit reload.
  useEffect(() => {
    // A remote leaf whose SSH session reconnects gets a NEW session id for the
    // same path. Re-reading then would overwrite unsaved edits with the copy on
    // disk, so keep the buffer and let it save through the new session instead.
    // Same rule `reload` already applies. Never fires locally: `sshSessionId` is
    // static there, and `reload` refuses while dirty.
    if (dirtyRef.current && loadedPathRef.current === path) return;
    loadedPathRef.current = path;
    let cancelled = false;
    setDoc({ status: "loading" });
    setDirty(false);

    const load = async () => {
      if (sshSessionId !== undefined) {
        // SFTP: backend rejects non-UTF-8 with a clear message. Size comes
        // from the UTF-8 byte length. No binary/image/toolarge branches
        // over SFTP yet.
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

  /** Re-reads the file from disk. Silent no-op when dirty (preserves
   *  unsaved edits). Returns whether reload ran. */
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

  /**
   * Persist the buffer. With no argument: short-circuits when clean and
   * writes `bufferRef.current` otherwise. With `overrideContent`: forces a
   * write of the provided text (used by format-on-save so we don't race
   * the stale `dirty` closure between a CM dispatch and the save call).
   */
  const save = useCallback(
    async (overrideContent?: string) => {
      const usingOverride = overrideContent !== undefined;
      if (!usingOverride && !dirty) return;
      const content = usingOverride ? overrideContent : bufferRef.current;
      if (sshSessionId !== undefined) {
        await sftpWriteFile(sshSessionId, path, content);
      } else {
        await invoke("fs_write_file", { path, content });
      }
      notifyMemoryPathChanged(path);
      notifySkillPathChanged(path);
      savedRef.current = content;
      if (usingOverride) bufferRef.current = content;
      setDirty(false);
    },
    [path, sshSessionId, dirty],
  );

  return { doc, dirty, liveContent, onChange, save, reload };
}
