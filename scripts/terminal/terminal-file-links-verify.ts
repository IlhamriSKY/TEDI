/**
 * Self-check for the clickable `path:line` references in terminal output.
 * Run: `npx tsx scripts/terminal/terminal-file-links-verify.ts`.
 *
 * The failure is silent: a reference that is not found is simply not
 * underlined, and a wrong one opens the wrong file. The lines below are the
 * shapes real tools print, including a Windows path with spaces in it, which
 * a plain token regex cuts in half.
 */
import { candidatePaths, findFileRefs } from "../../src/modules/terminal/lib/fileLinks";

let failed = 0;
function check(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`  ok: ${label}`);
  } else {
    console.error(`  FAIL: ${label} = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failed++;
  }
}

const refs = (s: string) => findFileRefs(s).map((r) => [r.path, r.line ?? null, r.col ?? null]);

console.log("[tool output shapes]");
check("tsc --pretty", refs("src/app.ts:12:5 - error TS2322: Type"), [["src/app.ts", 12, 5]]);
check("plain tsc / msbuild", refs("src/app.ts(12,5): error TS2322"), [["src/app.ts", 12, 5]]);
check("eslint path only", refs("  /home/me/p/src/a.tsx"), [["/home/me/p/src/a.tsx", null, null]]);
check("node stack frame", refs("    at run (D:\\proj\\src\\index.js:40:11)"), [
  ["D:\\proj\\src\\index.js", 40, 11],
]);
check("python traceback", refs('  File "C:\\work\\app\\main.py", line 7, in <module>'), [
  ["C:\\work\\app\\main.py", 7, null],
]);
check("php error", refs("PHP Fatal error: oops in /var/www/app/index.php on line 9"), [
  ["/var/www/app/index.php", 9, null],
]);
check("cargo", refs("  --> src/main.rs:3:9"), [["src/main.rs", 3, 9]]);

console.log("\n[a Windows path with spaces is found whole]");
const spaced = findFileRefs("D:\\Ilham\\Project\\TEDI - terax-ai\\src\\app.ts:3:1 error");
check(
  "reaches back to the drive",
  spaced.map((r) => r.path),
  ["D:\\Ilham\\Project\\TEDI - terax-ai\\src\\app.ts"],
);
check("keeps the short match as a fallback", spaced[0]?.fallback?.path, "terax-ai\\src\\app.ts");
check(
  "does not glue two paths together",
  findFileRefs("C:\\a\\x.ts:1 and src\\b.ts:2").map((r) => r.path),
  ["C:\\a\\x.ts", "src\\b.ts"],
);

console.log("\n[not a file reference]");
check("url is left to the web-links addon", refs("see http://localhost:5173/src/main.ts"), []);
check("version number", refs("vite v7.1.3 ready in 312 ms"), []);
check("UNC share is never probed", refs("\\\\server\\share\\a.txt"), []);

console.log("\n[resolution against the shell cwd]");
check("relative", candidatePaths("src\\a.ts", "D:/p"), ["D:/p/src/a.ts"]);
check("dot-relative", candidatePaths("./a.ts", "/home/me"), ["/home/me/a.ts"]);
check("windows absolute", candidatePaths("C:\\x\\a.ts", "D:/p"), ["C:/x/a.ts"]);
check("posix-rooted tries both", candidatePaths("/src/main.ts", "D:/p"), [
  "/src/main.ts",
  "D:/p/src/main.ts",
]);
check("no cwd, relative", candidatePaths("a.ts", null), []);

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall file-link checks passed");
