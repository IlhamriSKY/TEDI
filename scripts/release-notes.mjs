// Compose the GitHub Release body (and, through tauri-action's updater
// manifest, the in-app "update available" notes) from CHANGELOG.md so the text
// users see always matches what actually shipped in the tagged version.
//
// Usage: node scripts/release-notes.mjs v0.3.76   (a leading "v" is optional)
//
// Prints the CHANGELOG section for the version followed by a standard install /
// updater footer. Falls back to a link so a missing or misformatted entry never
// blocks a release.
import { readFileSync } from "node:fs";

const REPO = "https://github.com/IlhamriSKY/TEDI";

const version = (process.argv[2] ?? "").replace(/^v/, "").trim();
if (!version) {
  console.error("usage: release-notes.mjs <version>");
  process.exit(2);
}

const md = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const lines = md.split(/\r?\n/);

// Section headers look like: "## [0.3.76] - 04-07-2026"
const isSectionHeader = (line) => /^##\s+\[/.test(line);
const versionHeader = new RegExp(`^##\\s+\\[${version.replace(/\./g, "\\.")}\\]`);

const start = lines.findIndex((line) => versionHeader.test(line));
let section = "";
if (start !== -1) {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isSectionHeader(lines[i])) {
      end = i;
      break;
    }
  }
  // Skip the header line itself; the release title already names the version.
  section = lines.slice(start + 1, end).join("\n").trim();
}

const body = section || `Release ${version}. Full changelog: ${REPO}/blob/main/CHANGELOG.md`;

const footer = [
  "---",
  "",
  '**macOS users:** if Gatekeeper says TEDI "can\'t be opened because Apple cannot check it for malicious software" or "is damaged and can\'t be opened", drag the app to `/Applications` and run this once in Terminal:',
  "",
  "```",
  "xattr -cr /Applications/TEDI.app",
  "```",
].join("\n");

process.stdout.write(`${body}\n\n${footer}\n`);
