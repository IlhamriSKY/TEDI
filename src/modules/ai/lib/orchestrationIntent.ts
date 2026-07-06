/** Orchestration-intent detection: should step 0 be pinned to a `run_subagents`
 *  fan-out for a given user message? Pinning is the model-agnostic way to get
 *  RELIABLE auto-delegation: a soft prompt mandate is followed by strong
 *  instruction-tuned models but ignored by many others, which reach for the easy
 *  inline tools (read/grep/list) instead. Restricting step 0 to the spawn tool
 *  removes that choice - the same principle as opencode's orchestrator.
 *
 *  A study VERB alone is deliberately NOT enough: it fired on single-file work
 *  ("pahami fungsi ini", "explain this line") and forcing a multi-subagent
 *  fan-out there was the biggest latency complaint. Force it only when the user
 *  EXPLICITLY asks for sub-agents, or pairs a study verb with a BREADTH cue (the
 *  mandate's own "more than one file" bar). Otherwise the model decides - the
 *  soft prompt mandate still nudges capable models to delegate.
 *
 *  Pure (regex only, no imports) so it stays unit-testable under node/tsx.
 *  ponytail: keyword heuristic, not intent parsing; EN + ID; tighten if it misfires. */

const EXPLICIT_SUBAGENT_INTENT = /sub[-\s]?agents?|orchestrat\w*/i;

const STUDY_VERB_INTENT = new RegExp(
  [
    "stud(?:y|ies)",
    "explor\\w*",
    "understand",
    "audit",
    "trace",
    "analy[sz]e\\w*",
    "investigat\\w*",
    "map\\s+out",
    // Indonesian
    "pelajari",
    "eksplor\\w*",
    "telusuri",
    "pahami",
    "tinjau",
    "petakan",
    "analis\\w*",
    "selidiki",
  ].join("|"),
  "i",
);

const BREADTH_INTENT = new RegExp(
  [
    // Word-bounded: these are substrings of common unrelated words (report,
    // reporting, projected, wholesale, ecosystem, proyeksi, sistematis), so a
    // bare match would force a fan-out on plainly single-file work - the exact
    // regression this module exists to prevent.
    "\\bprojects?\\b",
    "\\brepo(?:sitory)?\\b",
    "\\bwhole\\b",
    "\\bsystem\\b",
    "\\bsistem\\b",
    "\\bproyek\\b",
    // Distinctive enough to leave unbounded.
    "code\\s?base",
    "entire",
    "overall",
    "architecture",
    "subsystem",
    "\\bacross\\b",
    "end.to.end",
    "everything",
    "all\\s+the",
    // Indonesian
    "menyeluruh",
    "seluruh",
    "\\bsemua\\b",
    "keseluruhan",
    "arsitektur",
    "antar\\s?file",
    "lintas",
  ].join("|"),
  "i",
);

/** True when step 0 should be pinned to a run_subagents fan-out. Strips the
 *  injected `<env>` block FIRST: it carries the workspace path (which can
 *  literally contain "Project"), so BREADTH_INTENT would otherwise match on
 *  every turn. */
export function wantsForcedFanout(userText: string): boolean {
  const t = userText.replace(/<env>[\s\S]*?<\/env>/gi, " ");
  if (EXPLICIT_SUBAGENT_INTENT.test(t)) return true;
  return STUDY_VERB_INTENT.test(t) && BREADTH_INTENT.test(t);
}
