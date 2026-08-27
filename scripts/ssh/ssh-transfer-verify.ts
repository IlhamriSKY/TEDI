/**
 * Self-check for the SSH file tree's transfer and permission features.
 * Run: `npx tsx scripts/ssh/ssh-transfer-verify.ts`.
 *
 * Two halves, because the interesting bugs here live in two different places.
 *
 * The pure half exercises the unix-mode helpers. A permissions dialog whose
 * `rwxr-xr-x` line disagrees with the octal it is about to send is worse than
 * no dialog: the user reads one thing and applies another. The `s`/`S` and
 * `t`/`T` cases are the ones that are easy to get wrong and impossible to
 * notice by eye.
 *
 * The structural half pins down invariants that only exist as a shape in the
 * source, each one a trap that was live at some point while this was written:
 *
 *   - `FileAttributes::default()` in russh-sftp is NOT empty. It carries
 *     size 0, uid/gid 0 and zeroed timestamps, so a chmod built from it would
 *     truncate the file and reset its owner. Only `empty()` is safe.
 *   - SFTP `rmdir` clears an EMPTY directory only, so deleting a non-empty
 *     folder needs a walk. It used to just fail, silently.
 *   - SSH_FXP_SETSTAT is `chmod()`, which FOLLOWS symlinks: a recursive chmod
 *     that touches a link re-modes a file outside the tree entirely.
 *   - `delete` must lstat, or a symlink to a directory gets walked and emptied
 *     instead of unlinked.
 *   - The synthesized drag bridge must hit-test drop zones as well as terminal
 *     panes, and only remote rows may declare themselves as either.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { modeString, octal, parseOctal } from "../../src/modules/ssh/permissions";
import { joinRemote, remoteDirname } from "../../src/modules/ssh/sftp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}
function ok(label: string, cond: boolean): void {
  if (cond) console.log(`  ok: ${label}`);
  else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

console.log("[modeString] the everyday modes read like ls -l");
check("0755", modeString(0o755), "rwxr-xr-x");
check("0644", modeString(0o644), "rw-r--r--");
check("0600", modeString(0o600), "rw-------");
check("0777", modeString(0o777), "rwxrwxrwx");
check("0000", modeString(0o000), "---------");

console.log("\n[modeString] special bits replace the class's x, and case says whether x is on");
check("setuid over an executable", modeString(0o4755), "rwsr-xr-x");
check("setuid without execute is uppercase", modeString(0o4644), "rwSr--r--");
check("setgid over an executable", modeString(0o2755), "rwxr-sr-x");
check("setgid without execute is uppercase", modeString(0o2644), "rw-r-Sr--");
check("sticky /tmp", modeString(0o1777), "rwxrwxrwt");
check("sticky without execute is uppercase", modeString(0o1666), "rw-rw-rwT");
check("all three at once", modeString(0o7777), "rwsrwsrwt");

console.log("\n[octal] always four digits, always masked to the mode bits");
check("0755 pads", octal(0o755), "0755");
check("0 pads", octal(0), "0000");
check("4755 keeps the special digit", octal(0o4755), "4755");
// The mode a stat returns carries the file-type bits (0o100644 for a regular
// file). Sending those back in a setstat is harmless on OpenSSH, which masks
// them, but the DISPLAY must never show "100644" as the octal to type.
check("file type bits are dropped", octal(0o100644), "0644");
check("dir type bits are dropped", octal(0o040755), "0755");

console.log("\n[parseOctal] accepts a mode mid-typing, rejects everything else");
check("one digit is a valid prefix", parseOctal("7"), 7);
check("three digits", parseOctal("755"), 0o755);
check("four digits", parseOctal("4755"), 0o4755);
check("empty is not a mode", parseOctal(""), null);
check("8 is not octal", parseOctal("758"), null);
check("nine is not octal", parseOctal("9"), null);
check("letters are not a mode", parseOctal("rwx"), null);
check("five digits is past a mode", parseOctal("17777"), null);
check("no negatives", parseOctal("-7"), null);

console.log("\n[modeString/octal] round-trip over every mode the dialog can produce");
let roundTripped = 0;
for (let m = 0; m <= 0o7777; m++) {
  if (parseOctal(octal(m)) !== m) break;
  roundTripped++;
}
check("all 4096 modes survive octal -> parse", roundTripped, 0o7777 + 1);

console.log("\n[remote paths] POSIX joins whatever the local OS separator is");
check("plain join", joinRemote("/var/www", "site"), "/var/www/site");
check("root does not double its slash", joinRemote("/", "etc"), "/etc");
check("a trailing slash is not doubled", joinRemote("/var/www/", "site"), "/var/www/site");
check("dirname of a nested path", remoteDirname("/var/www/site/index.html"), "/var/www/site");
check("dirname at the root is the root", remoteDirname("/etc"), "/");
check("dirname of the root is the root", remoteDirname("/"), "/");

console.log("\n[sftp.rs] a chmod must not be built from FileAttributes::default()");
const sftpRs = read("src-tauri/src/modules/ssh/sftp.rs");
ok(
  "set_mode uses empty(), the only attrs with nothing else set",
  /FileAttributes::empty\(\)/.test(sftpRs),
);
ok(
  "and never default(), which carries size 0 and uid 0",
  !/FileAttributes::default\(\)/.test(sftpRs),
);
ok("the mode is masked to the permission bits", /permissions = Some\(mode & 0o7777\)/.test(sftpRs));

console.log("\n[sftp.rs] delete unlinks a link and walks a real directory");
const deleteBody = sftpRs.slice(sftpRs.indexOf("pub async fn ssh_sftp_delete"));
ok("stats without following links", deleteBody.includes("symlink_metadata"));
ok("walks the tree, because rmdir needs an empty directory", deleteBody.includes("walk_remote"));
ok("children before parents", deleteBody.includes(".rev()"));

console.log("\n[sftp.rs] recursive chmod steps over symlinks");
const chmodBody = sftpRs.slice(
  sftpRs.indexOf("pub async fn ssh_sftp_chmod"),
  sftpRs.indexOf("pub async fn ssh_sftp_exists"),
);
ok("the walk reports whether an entry is a link", /is_symlink: bool/.test(sftpRs));
ok("and chmod skips those", /if e\.is_symlink \{\s*continue;/.test(chmodBody));
ok("the files/dirs split exists at all", /"files" => !e\.is_dir/.test(chmodBody));

console.log("\n[sftp.rs] transfers stream instead of buffering a whole file");
ok("upload reads the local file in chunks", /src\s*\n?\s*\.read\(&mut buf\)/.test(sftpRs));
ok("no whole-file read of a local upload", !/std::fs::read\(&read_path\)/.test(sftpRs));
ok("every walk is bounded", /MAX_WALK_ENTRIES/.test(sftpRs));

console.log("\n[drag bridge] drop zones are hit-tested alongside terminal panes");
const dragTs = read("src/modules/terminal/lib/useTerminalFileDrop.ts");
ok(
  "one selector covers both, so the nearer one wins",
  dragTs.includes('"[data-fs-drop],[data-terminal-leaf-id]"'),
);
ok("a zone gets an event rather than the terminal's write", dragTs.includes("FS_DROP_EVENT"));
ok("the event carries the source row, not just its path", /sourceEl: HTMLElement/.test(dragTs));
ok(
  "the outline is not gated on the synthesized gesture, so OS drops can use it",
  /\n\.tedi-fs-drop-target \{/.test(dragTs),
);

console.log("\n[FileTreeNode] only remote rows are drop zones");
const nodeTsx = read("src/modules/explorer/FileTreeNode.tsx");
ok(
  "a folder takes the drop, a file hands it to its parent",
  /data-fs-drop=\{remote \? \(isDir \? path : parentPath\) : undefined\}/.test(nodeTsx),
);
ok(
  "remote rows say so, so a drop can tell a move from a transfer",
  /data-fs-remote=\{remote \? "" : undefined\}/.test(nodeTsx),
);
ok(
  "upload/download/permissions are opt-in props, so the local tree never shows them",
  /onUpload\?:/.test(nodeTsx) && /onDownload\?:/.test(nodeTsx) && /onProperties\?:/.test(nodeTsx),
);

console.log("\n[SshFileExplorer] a remote source moves, anything else uploads");
const explorerTsx = read("src/modules/ssh/SshFileExplorer.tsx");
ok(
  "the discriminator is the source row's own remote flag",
  /sourceEl\.hasAttribute\("data-fs-remote"\)/.test(explorerTsx),
);
ok(
  "the tree body is a drop zone for the current root",
  /data-fs-drop=\{rootPath\}/.test(explorerTsx),
);

console.log("\n[useSshFileTree] a failed remote mutation is visible, not console-only");
const treeTs = read("src/modules/ssh/useSshFileTree.ts");
ok("failures raise a toast", /function reportFailure/.test(treeTs) && /toast\(/.test(treeTs));
for (const action of ["Rename", "Delete", "Move"]) {
  ok(`${action} reports its failure`, treeTs.includes(`reportFailure("${action}"`));
}
ok(
  "a move into its own subtree is refused",
  /toDir === from \|\| toDir\.startsWith\(`\$\{from\}\/`\)/.test(treeTs),
);
ok("a move checks for a collision first", /await sftpExists\(sessionId, to\)/.test(treeTs));

console.log(`\n${failed === 0 ? "All ssh-transfer checks passed." : `${failed} check(s) FAILED`}`);
if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
