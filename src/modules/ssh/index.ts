// Public surface of the SSH module (ssh/ + sftp_* Rust backend's frontend).
// Components manage connections and the remote file explorer; connections.ts
// persists hosts (passwords in keychain), status.ts tracks live session state,
// bridge.ts/sftp.ts wrap the Rust ssh_*/sftp_* commands.
export { SshFileExplorer } from "./SshFileExplorer";
export { SshConnectionDialog } from "./SshConnectionDialog";
export { HostKeyPromptDialog } from "./HostKeyPromptDialog";
export { SshMenu } from "./SshMenu";
export { SshStatusPill } from "./components/SshStatusPill";
export { useSshFileTree, type SshDirEntry, type PendingCreate } from "./useSshFileTree";
export * from "./connections";
export * from "./status";
export * from "./bridge";
export * from "./sftp";
