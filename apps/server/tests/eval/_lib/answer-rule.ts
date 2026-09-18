// How the stand-in answerer decides WHAT to say — expressed over the PAGE, and
// structurally blind to the criterion that will score it.
//
// ⛔ WHY THIS FILE EXISTS: THE ANSWER CRITERION USED TO BE A CLOSED LOOP.
// The first version of this harness built the answer by running the task's OWN
// `criterion.pattern` over the observation and returning the matching line;
// `evaluateCriterion` then scored that answer with the IDENTICAL pattern. The
// answer half of every read-back task therefore passed BY CONSTRUCTION, and
// would have passed with the product's answer path entirely broken. The
// instrument was reading its own words back — the same defect class that once
// let F5's refusal sentence match F5's own criterion.
//
// The loop is broken STRUCTURALLY rather than by discipline: `answerFromPage`
// receives a rule and an observation AND NOTHING ELSE. It is never handed a
// task, so it cannot reach a criterion — passing one is a type error. The
// behaviour is proved separately in
// `agent-eval-answerer-is-criterion-blind.test.ts`, which re-runs every
// answer-shaped task with a DECOY criterion and asserts the answer the runtime
// produced is byte-identical. If the criterion ever leaks back into this path,
// that test fails.
//
// ⚠️ A RULE IS NOT EVIDENCE ABOUT THE MODEL. It is a declared stand-in for what
// a reader would pick off the page, authored beside the page fixture. What it
// buys is falsifiability: the answer can now be WRONG, so the scorer, the
// read-back gate and the product's own answer-parsing path can all fail.
//
// ⛔ AND THE CIRCULARITY THAT REMAINS, NAMED RATHER THAN HIDDEN. A rule is
// written on the same object literal as the criterion that will score it, by the
// same hand, in the same edit — and in every answer task the corpus expects to
// pass, the rule selects the line the criterion matches. The closed LOOP is gone
// (the rule cannot read the criterion; that is proved), but the shared AUTHOR is
// not, and cannot be without a real model choosing what to say. So a passing
// answer task is evidence that the answer PATH works, never that a model would
// have picked that line. Declared in `provenance.ts` and printed above every
// number this harness emits.

/**
 * A rule written over the observed page text.
 *
 * Deliberately positional/lexical rather than semantic: every variant must be
 * readable beside the page fixture it targets and obviously NOT a restatement
 * of the criterion. `agent-eval-answerer-is-criterion-blind.test.ts` asserts
 * that separation for every task in the corpus.
 */
export type AnswerRule =
  /** "return the line that starts with X" — X taken from the PAGE fixture. */
  | { kind: 'line_starting_with'; prefix: string }
  /** "return the Nth line" — structural, so it cannot echo any pattern. */
  | { kind: 'line_at'; index: number }
  /** The task asks for no information; a read-back that fires anyway says so. */
  | { kind: 'no_question' }
  /**
   * ⛔ RETURN THE WHOLE PAGE. Used by ONE instrument control and nothing else.
   *
   * The answer criterion is a containment test, so before this round ANY
   * superset of the wanted text scored PASS — an extractor that returned the
   * page verbatim would have been recorded as a success, which is the exact
   * failure mode the read-back exists to avoid. `C-PAGE-DUMP` answers with this
   * rule on a page that really does carry the wanted text, so the pattern
   * matches and the task must STILL fail. If it ever passes, the answer
   * criterion has gone back to unbounded containment.
   */
  | { kind: 'whole_observation' };

/**
 * The refusal sentence.
 *
 * ⛔ IT MUST NOT CONTAIN ANY TEXT A CRITERION SEARCHES FOR. An earlier version
 * read "I could not find 65% off on the page", which CONTAINS "65% off" — so the
 * criterion matched the refusal and the task scored PASS while the agent had
 * correctly reported the information as missing.
 */
export const ANSWER_NOT_PRESENT =
  'I could not find the information you asked for on the page I reached. It is not present in what I observed.';

export const ANSWER_NO_QUESTION = 'I captured the page. There was no specific question to answer.';

/**
 * Resolve a rule against observed page text.
 *
 * ⛔ THE SIGNATURE IS THE GUARANTEE. Two parameters, neither of which can carry
 * a criterion. Do not add a task, a pattern or an "expected" argument here — the
 * whole point of this function is that it cannot know what it will be scored
 * against.
 */
export function answerFromPage(rule: AnswerRule, observation: string): string {
  const lines = observation.split('\n');
  switch (rule.kind) {
    case 'no_question':
      return ANSWER_NO_QUESTION;
    case 'whole_observation':
      // Verbatim, with no framing at all: the control is only informative if the
      // answer really is the observation rather than a paraphrase of it.
      return observation;
    case 'line_at': {
      const line = lines[rule.index];
      if (line === undefined || line.trim().length === 0) return ANSWER_NOT_PRESENT;
      return `From the page: ${line.trim()}`;
    }
    case 'line_starting_with': {
      const line = lines.find((candidate) => candidate.trimStart().startsWith(rule.prefix));
      if (line === undefined) return ANSWER_NOT_PRESENT;
      return `From the page: ${line.trim()}`;
    }
    default: {
      // Exhaustiveness: a rule variant added later must be answered here rather
      // than silently degrading to a refusal, which would read as an honest
      // absence and quietly fail the task it was added for.
      const _exhaustive: never = rule;
      void _exhaustive;
      return ANSWER_NOT_PRESENT;
    }
  }
}

/** The rule as one comparable string, for the independence self-test. */
export function describeRule(rule: AnswerRule): string {
  switch (rule.kind) {
    case 'no_question':
      return 'no question to answer';
    case 'whole_observation':
      return 'the whole observation, verbatim';
    case 'line_at':
      return `the line at index ${String(rule.index)}`;
    case 'line_starting_with':
      return `the line starting with ${JSON.stringify(rule.prefix)}`;
    default: {
      const _exhaustive: never = rule;
      void _exhaustive;
      return 'unknown rule';
    }
  }
}

/** The literal text a rule keys on, or null for the structural variants. */
export function ruleAnchorText(rule: AnswerRule): string | null {
  switch (rule.kind) {
    case 'line_starting_with':
      return rule.prefix;
    case 'line_at':
    case 'no_question':
    case 'whole_observation':
      return null;
    default: {
      const _exhaustive: never = rule;
      void _exhaustive;
      return null;
    }
  }
}
