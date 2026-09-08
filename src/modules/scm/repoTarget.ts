/**
 * Which repository Source Control reads, when it is not the workspace root.
 *
 * Source Control follows the workspace, which is right until the workspace
 * holds more than one repository - a submodule, a vendored checkout, two
 * services side by side. Picking a folder in the Explorer points the panel at
 * whatever repository contains it instead. Git resolves that itself (every
 * command already goes through `--show-toplevel`), so a folder deep inside one
 * repo and the repo root are the same target, and a folder in no repo at all
 * just resolves back to the workspace's own.
 *
 * Nothing scans, watches or discovers: the target is only ever set by an
 * explicit menu pick.
 *
 * `forRoot` is the workspace the pick was made under. Reading through
 * {@link useScmRepoTarget} means opening another workspace stops applying it
 * with nothing having to clear it, so a target can never outlive its tree.
 */
import { create } from "zustand";

type State = {
  path: string | null;
  forRoot: string | null;
};

type Actions = {
  target: (path: string, forRoot: string | null) => void;
  clear: () => void;
};

export const useScmRepoTargetStore = create<State & Actions>((set) => ({
  path: null,
  forRoot: null,
  target: (path, forRoot) => set({ path, forRoot }),
  clear: () => set({ path: null, forRoot: null }),
}));

/** The folder Source Control should resolve under `workspaceRoot`, or null to follow it. */
export function useScmRepoTarget(workspaceRoot: string | null): string | null {
  return useScmRepoTargetStore((s) => (s.forRoot === workspaceRoot ? s.path : null));
}
