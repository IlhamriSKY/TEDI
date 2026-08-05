/** Should step 0 be pinned to a `run_subagents` fan-out? Pinning is the
 *  model-agnostic way to get reliable delegation: a soft prompt mandate is
 *  ignored by many models, which reach for the inline tools instead.
 *
 *  A study VERB alone is NOT enough - it fired on single-file work ("explain
 *  this line") and forcing a fan-out there was the biggest latency complaint.
 *  Force only on an EXPLICIT sub-agent ask, or a study verb plus a BREADTH cue.
 *
 *  Pure regex, no imports, so it stays testable under node/tsx. Keyword
 *  heuristic (EN + ID), not intent parsing; tighten if it misfires. */

const EXPLICIT_SUBAGENT_INTENT = /sub[-\s]?agents?|orchestrat\w*/i;

const SUBAGENT_MENTION = "(?:sub[-\\s]?agents?|orchestrat\\w*)";

/** Mentioning sub-agents is not the same as asking for them. Without this,
 *  "don't use subagents for this" and "why did that subagent fail?" both forced
 *  a fan-out, so any conversation ABOUT the feature triggered the feature.
 *
 *  Negations get a wide window (they can sit well before the mention), but
 *  interrogatives get a tight one: "how" legitimately appears in a real request
 *  like "study how the auth system works, use subagents", and a wide window
 *  there suppressed exactly the fan-outs the user asked for. */
const NEGATED_SUBAGENT_INTENT = new RegExp(
  [
    `\\b(?:no|not|don'?t|do not|without|avoid|skip|stop|never)\\b[^.!?]{0,40}\\b${SUBAGENT_MENTION}`,
    `\\b(?:why|what|which|how)\\b[^.!?]{0,12}\\b${SUBAGENT_MENTION}`,
    // Indonesian
    `\\b(?:jangan|tanpa|tidak|bukan|hindari)\\b[^.!?]{0,40}\\b${SUBAGENT_MENTION}`,
    `\\b(?:kenapa|mengapa|apa)\\b[^.!?]{0,12}\\b${SUBAGENT_MENTION}`,
  ].join("|"),
  "i",
);

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
    // "whole" is breadth ("audit the whole codebase") EXCEPT when it modifies a
    // single-unit noun ("analyze the whole file/function/line") - that is the
    // narrow one-liner this module must not fan out on. The noun, not the message
    // length, is what makes it narrow, so this replaced the old char-count floor.
    "\\bwhole\\b(?!\\s+(?:files?|functions?|funcs?|methods?|lines?|class(?:es)?|blocks?|words?|char(?:acter)?s?|selections?)\\b)",
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
  // A negated or interrogative mention overrides everything: forcing a fan-out
  // on "don't use subagents" is the worst possible reading of the request.
  if (NEGATED_SUBAGENT_INTENT.test(t)) return false;
  if (EXPLICIT_SUBAGENT_INTENT.test(t)) return true;
  // Forcing a fan-out only pays off when there is real breadth to divide. A
  // study verb ALONE ("pahami fungsi ini") is a single-file question; it must
  // also carry a breadth cue, which is what BREADTH_INTENT (word-bounded, and
  // "whole" narrowed off single-unit nouns) discriminates.
  return STUDY_VERB_INTENT.test(t) && BREADTH_INTENT.test(t);
}
