// Canonical TypeScript mirrors of the Rust IPC payload enums. Keep in lockstep
// with the #[derive(Serialize)] types in src-tauri/src/modules/fs/file.rs.
// Defined ONCE and imported everywhere so the shapes cannot silently diverge -
// a hand-copied variant that dropped `image` previously caused real images to
// be mishandled as "non-text" and skipped.

/** Mirrors Rust `fs::file::ReadResult` (commands: fs_read_file, git_file_head, git_file_at). */
export type FsReadResult =
  | { kind: "text"; content: string; size: number }
  | { kind: "image"; dataUrl: string; mime: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

/** Mirrors Rust `fs::file::ReadPortionResult` (command: fs_read_file_portion). No image variant. */
export type FsReadPortionResult =
  | {
      kind: "text";
      content: string;
      size: number;
      totalLines: number;
      startLine: number;
      endLine: number;
    }
  | { kind: "binary"; size: number }
  | { kind: "toolarge"; size: number; limit: number };

/**
 * Names of Tauri events emitted by the RUST process and listened to on the TS
 * side. Magic strings on both sides drift silently (a typo just never fires),
 * so every TS listener references these constants. Mirror = the `emit(...)`
 * calls in src-tauri/src/lib.rs.
 */
export const IPC_EVENTS = {
  /** Rust -> Settings webview: focus a settings tab (payload: tab id string). */
  SETTINGS_TAB: "tedi:settings-tab",
  /** Rust -> main window: open a path passed to the `tedi` CLI (single-instance forward). */
  OPEN_CLI_TARGET: "tedi:open-cli-target",
  /** Rust -> main window: the `tedi --update` shim asks the UI to start updating. */
  TRIGGER_UPDATE: "tedi:trigger-update",
} as const;
