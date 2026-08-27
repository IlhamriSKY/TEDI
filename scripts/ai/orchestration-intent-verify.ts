/**
 * Self-check for the loosened forced-fan-out gate (wantsForcedFanout).
 * Run: `npx tsx scripts/ai/orchestration-intent-verify.ts`.
 *
 * The rule: force a run_subagents fan-out only when the user EXPLICITLY asks for
 * sub-agents, or pairs a study verb with a breadth (multi-file) cue. A study verb
 * ALONE must NOT force it (that was the latency complaint), and the injected
 * <env> block (which carries the workspace path, often containing "Project")
 * must NOT make it fire on its own.
 */
import { wantsForcedFanout } from "../../src/modules/ai/lib/orchestrationIntent";

let failed = 0;
function expect(text: string, want: boolean): void {
  const got = wantsForcedFanout(text);
  if (got !== want) {
    console.error(`  FAIL: wantsForcedFanout(${JSON.stringify(text)}) = ${got}, want ${want}`);
    failed++;
  } else {
    console.log(`  ok: ${want ? "FORCE " : "skip  "} <- ${JSON.stringify(text)}`);
  }
}

const ENV = "<env>\nworkspace_root: D:/Ilham/Project/laragon/www/TEDI - terax-ai\nactive_terminal_cwd: D:/x\n</env>\n\n";

console.log("[explicit] user names sub-agents -> always force");
expect("use sub-agents to build this", true);
expect("gunakan subagent untuk ini", true);
expect("orchestrate this migration", true);

console.log("\n[verb + breadth] force");
expect("pelajari seluruh proyek ini", true);
expect("audit the whole codebase", true);
expect("study the architecture end-to-end", true);
expect("analisa arsitektur sistem ini", true);

console.log("\n[verb only] narrow -> do NOT force (the latency fix)");
expect("pahami fungsi ini", false);
expect("explain this line", false);
expect("explore this file", false);
expect("pelajari ai-native tedi", false); // no explicit breadth word

console.log("\n[no intent] plain requests -> skip");
expect("fix the typo in header.tsx", false);
expect("apa isi file ini?", false);

console.log("\n[substring false-positives] breadth cue inside an unrelated word -> must NOT force");
expect("analyze this crash report", false); // repo <- report
expect("audit the reporting module for bugs", false); // repo <- reporting
expect("analyze the projected revenue for Q3", false); // project <- projected
expect("analyze wholesale pricing", false); // whole <- wholesale
expect("analisa ekosistem ini", false); // sistem <- ekosistem
expect("lihat proyeksi keuangan lalu analisa", false); // proyek <- proyeksi
// ...but the bounded words still match as whole words.
expect("audit the whole codebase", true);
expect("pelajari seluruh proyek ini", true);
expect("analisa arsitektur sistem ini", true);
expect("study the reporting system across teams", true); // 'system'/'across' as real words

console.log("\n[env immunity] the injected <env> path contains 'Project' but must not force on its own");
expect(ENV + "fix the typo in header.tsx", false);
expect(ENV + "pahami fungsi ini", false);
// ...and a genuine force still fires even with the env prefix present.
expect(ENV + "audit the whole codebase", true);

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nALL PASS");
