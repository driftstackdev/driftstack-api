// What each tier of this eval proves, in ONE place.
//
// It lives on its own so the scripted report can say it without importing the
// live runner, and so the two reports and the README cannot drift into
// describing the same number two different ways.

/** What each tier proves. Rendered into BOTH tiers' reports and the README, so
 *  the two numbers cannot be read as the same kind of thing. */
export const TIERS_EXPLAINED = [
  'SCRIPTED tier — hand-written plans, a stand-in answerer, a virtual clock. It proves the EXECUTOR and the ANSWER PATH: the retry and patience fences, the verb mapping and its selector refusal, the wire codec, the result mapper, the confirmation gate, the read-back gate. It is deterministic, it pins an outcome and a death reason per task, and it GATES regressions. It says nothing about planning: the plans are ours.',
  'LIVE tier — the real planner (real system prompt, real request assembly, real streaming parser, a real model) driving the same runtime, executor and device, given only the customer words. It measures PLANNING QUALITY. It is nondeterministic, costs money, is strictly opt-in, reports pass COUNTS over repetitions, writes no baseline, and NEVER gates anything.',
] as const;
