/**
 * Self-check for the `.tedi-ssh` connection backup parser.
 * Run: `npx tsx scripts/ssh-backup-verify.ts`.
 *
 * Importing a backup is a TRUST BOUNDARY: the file arrives from a USB stick or
 * a chat, and everything that survives `parseBackupFile` is written into the
 * connections store and later dialled. The failures this pins down are the
 * quiet ones - a port of 0 or 99999 reaching `TcpStream::connect`, a
 * `proxyJumpId` pointing at a host that does not exist (which makes every
 * connect through it fail with a message about a host the user never deleted),
 * a duplicate id where the second entry silently wins, and `hasPassword: true`
 * copied from the file so the UI claims a credential that is not in the
 * keychain.
 *
 * The crypto itself is checked on the Rust side (`modules/backup.rs` tests:
 * round trip, wrong passphrase, tampered ciphertext, nonce reuse).
 */
import {
  BACKUP_KIND,
  clearDanglingJumps,
  parseBackupFile,
  sanitizeConnection,
  sanitizeSecrets,
} from "../src/modules/ssh/backupFile";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}
function throws(label: string, fn: () => unknown, needle: string): void {
  try {
    fn();
    console.error(`  FAIL: ${label} did not throw`);
    failed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes(needle.toLowerCase())) {
      console.log(`  ok: ${label}`);
    } else {
      console.error(`  FAIL: ${label} threw "${msg}", expected to mention "${needle}"`);
      failed++;
    }
  }
}

const SEALED = {
  kdf: "pbkdf2-hmac-sha256",
  iterations: 600000,
  salt: "c2FsdA==",
  nonce: "bm9uY2U=",
  ciphertext: "Y2lwaGVy",
};
const envelope = (over: Record<string, unknown> = {}) => ({
  kind: BACKUP_KIND,
  version: 1,
  exportedAt: 1,
  connections: [],
  secrets: SEALED,
  ...over,
});
const conn = (over: Record<string, unknown> = {}) => ({
  id: "c-1",
  name: "prod",
  host: "example.com",
  port: 22,
  user: "root",
  authMode: "password",
  ...over,
});

console.log("[envelope] a file that is not a backup must be rejected outright");
throws("a plain object", () => parseBackupFile({}), "not a TEDI SSH backup");
throws("null", () => parseBackupFile(null), "not a TEDI SSH backup");
throws("an array", () => parseBackupFile([]), "not a TEDI SSH backup");
throws("a theme file", () => parseBackupFile({ kind: "tedi-theme" }), "not a TEDI SSH backup");
throws("no version", () => parseBackupFile(envelope({ version: "1" })), "version");
// A newer TEDI may add fields this build would silently drop, so refuse rather
// than import a partial connection.
throws("a newer format", () => parseBackupFile(envelope({ version: 99 })), "newer TEDI");
throws("no connections list", () => parseBackupFile(envelope({ connections: {} })), "connections");
throws("no secrets block", () => parseBackupFile(envelope({ secrets: undefined })), "credentials");
throws(
  "half a secrets block",
  () => parseBackupFile(envelope({ secrets: { kdf: "x" } })),
  "credentials",
);
throws(
  "non-integer iterations",
  () => parseBackupFile(envelope({ secrets: { ...SEALED, iterations: 1.5 } })),
  "credentials",
);

console.log("\n[ports] what would otherwise reach TcpStream::connect");
check("22 is fine", sanitizeConnection(conn())?.port, 22);
check("65535 is fine", sanitizeConnection(conn({ port: 65535 }))?.port, 65535);
check("0 is dropped", sanitizeConnection(conn({ port: 0 })), null);
check("65536 is dropped", sanitizeConnection(conn({ port: 65536 })), null);
check("negative is dropped", sanitizeConnection(conn({ port: -1 })), null);
check("a float is dropped", sanitizeConnection(conn({ port: 22.5 })), null);
check("a string is dropped", sanitizeConnection(conn({ port: "22" })), null);
check("NaN is dropped", sanitizeConnection(conn({ port: Number.NaN })), null);

console.log("\n[required fields]");
check("no id", sanitizeConnection(conn({ id: "" })), null);
check("no host", sanitizeConnection(conn({ host: "   " })), null);
check("not an object", sanitizeConnection("c-1"), null);
check(
  "a blank name falls back to the host",
  sanitizeConnection(conn({ name: "" }))?.name,
  "example.com",
);

console.log("\n[credential flags] never trusted from the file, or the UI pips lie");
const flagged = sanitizeConnection(
  conn({ hasPassword: true, hasPrivateKey: true, hasKeyPassphrase: true }),
);
check(
  "all three are forced false",
  [flagged?.hasPassword, flagged?.hasPrivateKey, flagged?.hasKeyPassphrase],
  [false, false, false],
);

console.log("\n[carried fields]");
check(
  "the pinned host key survives, so the new machine keeps the TOFU anchor",
  sanitizeConnection(conn({ lastFingerprint: "SHA256:abc" }))?.lastFingerprint,
  "SHA256:abc",
);
check(
  "an unknown authMode falls back to password",
  sanitizeConnection(conn({ authMode: "sso" }))?.authMode,
  "password",
);
check("key auth survives", sanitizeConnection(conn({ authMode: "key" }))?.authMode, "key");
check("proxyJumpId survives", sanitizeConnection(conn({ proxyJumpId: "c-2" }))?.proxyJumpId, "c-2");

console.log("\n[forwards] a bad rule must not look configured while binding nothing");
check(
  "a good rule survives",
  sanitizeConnection(
    conn({ forwards: [{ localPort: 8080, remoteHost: "127.0.0.1", remotePort: 80 }] }),
  )?.forwards,
  [{ localPort: 8080, remoteHost: "127.0.0.1", remotePort: 80 }],
);
// localPort 0 is meaningful (bind an ephemeral port); remotePort 0 is not.
check(
  "localPort 0 is kept, it means 'pick a free port'",
  sanitizeConnection(conn({ forwards: [{ localPort: 0, remoteHost: "db", remotePort: 5432 }] }))
    ?.forwards,
  [{ localPort: 0, remoteHost: "db", remotePort: 5432 }],
);
check(
  "remotePort 0 is dropped",
  sanitizeConnection(conn({ forwards: [{ localPort: 1, remoteHost: "db", remotePort: 0 }] }))
    ?.forwards,
  undefined,
);
check(
  "a missing remoteHost is dropped",
  sanitizeConnection(conn({ forwards: [{ localPort: 1, remotePort: 5432 }] }))?.forwards,
  undefined,
);
check(
  "forwards that is not an array is ignored",
  sanitizeConnection(conn({ forwards: "8080:80" }))?.forwards,
  undefined,
);
check(
  "a bad rule is dropped without taking the good one with it",
  sanitizeConnection(
    conn({ forwards: [{ localPort: 1, remoteHost: "a", remotePort: 2 }, { localPort: 3 }] }),
  )?.forwards,
  [{ localPort: 1, remoteHost: "a", remotePort: 2 }],
);

console.log("\n[list handling] bad entries are skipped and counted, not fatal");
const mixed = parseBackupFile(
  envelope({ connections: [conn(), conn({ id: "c-2", port: 0 }), null, conn({ id: "c-3" })] }),
);
check(
  "two good entries survive",
  mixed.file.connections.map((c) => c.id),
  ["c-1", "c-3"],
);
check("two bad entries counted", mixed.skipped, 2);
// A duplicate id would import twice and the second would silently win.
const dupes = parseBackupFile(envelope({ connections: [conn(), conn({ name: "other" })] }));
check("a duplicate id is skipped", dupes.file.connections.length, 1);
check("the first one wins", dupes.file.connections[0].name, "prod");
check("and it is counted", dupes.skipped, 1);

console.log("\n[dangling jump hosts] resolveJumpHops throws on these, so clear them first");
const list = [
  { ...conn({ id: "a", proxyJumpId: "b" }) },
  { ...conn({ id: "b" }) },
  { ...conn({ id: "c", proxyJumpId: "gone" }) },
] as Parameters<typeof clearDanglingJumps>[0];
const cleared = clearDanglingJumps(list, new Set(["a", "b", "c"]));
check("a resolvable jump is kept", cleared[0].proxyJumpId, "b");
check("a dangling jump is cleared", cleared[2].proxyJumpId, undefined);
check(
  "a jump host already saved on THIS machine counts as resolvable",
  clearDanglingJumps(
    [{ ...conn({ id: "x", proxyJumpId: "local-only" }) }] as never,
    new Set(["x", "local-only"]),
  )[0].proxyJumpId,
  "local-only",
);

console.log("\n[secrets] the decrypted payload is validated before it reaches the keychain");
check(
  "well-formed entries survive",
  sanitizeSecrets({ "c-1": { password: "pw", privateKey: "k", keyPassphrase: "p" } }),
  { "c-1": { password: "pw", privateKey: "k", keyPassphrase: "p" } },
);
check("non-string values are dropped", sanitizeSecrets({ "c-1": { password: 123 } }), {});
check("empty strings are dropped", sanitizeSecrets({ "c-1": { password: "" } }), {});
check("a non-object entry is skipped", sanitizeSecrets({ "c-1": "pw" }), {});
check("junk is not fatal", sanitizeSecrets(null), {});
check("an array is not fatal", sanitizeSecrets([1, 2]), {});
check(
  "a partial entry keeps only what is there",
  sanitizeSecrets({ "c-1": { privateKey: "k", password: null } }),
  { "c-1": { privateKey: "k" } },
);

console.log("\n[round trip] the shape an export actually writes");
const real = parseBackupFile(
  envelope({
    connections: [
      conn({ id: "bastion" }),
      conn({
        id: "db",
        proxyJumpId: "bastion",
        forwards: [{ localPort: 0, remoteHost: "127.0.0.1", remotePort: 5432 }],
      }),
    ],
  }),
);
check("both hosts survive", real.file.connections.length, 2);
check("nothing skipped", real.skipped, 0);
check("the jump chain is intact", real.file.connections[1].proxyJumpId, "bastion");
check("the forward is intact", real.file.connections[1].forwards?.[0].remotePort, 5432);

console.log(failed === 0 ? "\nAll ssh-backup checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
