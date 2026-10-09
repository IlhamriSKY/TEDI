import { createHostWatch } from "@/lib/hostWatch";

/** Mirrors Rust `fs::watch::FsChange`. */
export type FsChange = {
  /** Parent directories that may list differently, forward-slash and deduped. */
  dirs: string[];
  /** Too much moved to name: re-read every loaded directory. */
  rescan: boolean;
};

/** Hear about changes under `root`. One host watcher per root, shared by the
 *  Explorer, a second Explorer and an extension's folder tree. */
export const watchTree = createHostWatch<FsChange>("fs_watch", "fs_unwatch");
