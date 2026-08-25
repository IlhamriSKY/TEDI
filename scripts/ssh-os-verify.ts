/**
 * Self-check for the remote-OS read behind the status-bar OS pill.
 * Run: `npx tsx scripts/ssh-os-verify.ts`.
 *
 * The pill is now the ONLY thing in that slot: the jump chain that used to
 * spell out `bastion > user@target` folded into its tooltip, so if this parser
 * picks the wrong mark the bar silently claims the user is on a different
 * machine than they are. The derivative cases are the ones worth pinning -
 * Mint, Rocky and Manjaro all identify themselves only through `ID_LIKE`, and
 * a host that says nothing recognisable must still not be blamed on Ubuntu.
 */
import { parseOsRelease } from "../src/modules/ssh/remoteOs";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

console.log("[direct hit] the distro names itself");
check(
  "ubuntu",
  parseOsRelease(`PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\n`),
  { brand: "ubuntu", label: "Ubuntu 24.04.1 LTS" },
);
check("debian", parseOsRelease(`PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n`), {
  brand: "debian",
  label: "Debian GNU/Linux 12 (bookworm)",
});
check(
  "alpine, which ships no PRETTY_NAME quotes",
  parseOsRelease(`NAME=Alpine Linux\nID=alpine\n`),
  {
    brand: "alpine",
    label: "Alpine Linux",
  },
);
check("freebsd also ships os-release", parseOsRelease(`NAME=FreeBSD\nID=freebsd\n`), {
  brand: "freebsd",
  label: "FreeBSD",
});

console.log("\n[derivative] only ID_LIKE identifies it");
check(
  "mint wears Ubuntu's mark",
  parseOsRelease(`PRETTY_NAME="Linux Mint 22"\nID=linuxmint\nID_LIKE=ubuntu\n`),
  { brand: "ubuntu", label: "Linux Mint 22" },
);
check(
  "rocky takes the CLOSEST ancestor in the list, not the last",
  parseOsRelease(`PRETTY_NAME="Rocky Linux 9.4"\nID=rocky\nID_LIKE="rhel centos fedora"\n`),
  { brand: "redhat", label: "Rocky Linux 9.4" },
);
check("manjaro wears Arch's", parseOsRelease(`NAME="Manjaro"\nID=manjaro\nID_LIKE=arch\n`), {
  brand: "arch",
  label: "Manjaro",
});

console.log("\n[unknown] a host we cannot place is still Linux, never a guess");
check("unrecognised id, no ID_LIKE", parseOsRelease(`PRETTY_NAME="Gentoo Linux"\nID=gentoo\n`), {
  brand: "linux",
  label: "Gentoo Linux",
});
check("unrecognised ID_LIKE too", parseOsRelease(`ID=weird\nID_LIKE="alsoweird"\n`), {
  brand: "linux",
  label: "weird",
});
// The read succeeded, so the file is there and it IS a Linux-ish box; only the
// name is missing.
check("nothing parseable at all", parseOsRelease(`# comment only\n\n`), {
  brand: "linux",
  label: "Remote host",
});

console.log("\n[format] os-release quirks");
// The label falls back to the id lowercased. Only reachable on a file with
// neither PRETTY_NAME nor NAME, where "ubuntu" is still the honest answer.
check("ID is case-insensitive", parseOsRelease(`ID=Ubuntu\n`), {
  brand: "ubuntu",
  label: "ubuntu",
});
check(
  "a value containing = survives (HOME_URL query strings do)",
  parseOsRelease(`ID=debian\nHOME_URL="https://x.example/?a=b"\nPRETTY_NAME="Deb=ian"\n`).label,
  "Deb=ian",
);
check("PRETTY_NAME wins over NAME", parseOsRelease(`NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 22.04"\n`), {
  brand: "linux",
  label: "Ubuntu 22.04",
});
check("CRLF line endings", parseOsRelease(`PRETTY_NAME="Ubuntu 24.04"\r\nID=ubuntu\r\n`), {
  brand: "ubuntu",
  label: "Ubuntu 24.04",
});

console.log(failed === 0 ? "\nAll ssh-os checks passed." : `\n${failed} check(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
