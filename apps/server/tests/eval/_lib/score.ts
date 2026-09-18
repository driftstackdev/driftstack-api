// The scorer, and the runner that feeds it.
//
// ⚠️ THE SCORER IS AN INSTRUMENT AND IT WILL BE WRONG BEFORE THE AGENT IS. Its
// shape assumptions — what counts as "the answer", what counts as a step, which
// gate blocked a read-back — will not fit every task. Two things exist so a
// wrong score shows up as an absurd value rather than as a confident number:
// `scoreTurn` is PURE and has its own positive and negative controls in
// `agent-eval-scorer.test.ts`, and every task report carries `criterion.actual`
// so a human can see what the instrument actually read.

import type { AgentIntent } from '@driftstack/api-types';
import type {
  HarnessErrorCode,
  HarnessIntentName,
} from '../../../src/schemas/harness-control-protocol.js';
import { agentIntentToDispatch } from '../../../src/services/agent-intent-to-dispatch.js';
import type { IntentResult } from '../../../src/services/agent-executor.js';
import type { RunTurnResult } from '../../../src/services/agent-runtime.js';
import type { DispatchRecord } from './fake-device.js';
import type { EvalControlKind, EvalCriterion, EvalTask } from './tasks.js';
import type { ModelCallCounts, ObservedAnswerPath } from './scripted-decomposer.js';

/**
 * Why a turn did not reach its goal. CLOSED union: the switch that describes it
 * carries a `default` assigning to `never`, so a death mode added later cannot
 * be silently bucketed into an existing one.
 */
export type DeathReasonClass =
  | 'none'
  | 'halted_for_confirmation'
  | 'selector_rejected_before_dispatch'
  | 'intent_not_mappable'
  | 'element_never_appeared_in_retry_budget'
  | 'element_click_intercepted'
  | 'element_not_interactable'
  | 'wait_condition_not_met'
  | 'capture_failed'
  | 'page_load_failed'
  | 'invalid_parameter'
  | 'result_too_large'
  | 'navigated_but_page_never_loaded'
  | 'answer_not_grounded'
  | 'answer_was_not_an_extraction'
  | 'readback_gate_blocked'
  | 'answer_path_failed_after_being_reached'
  | 'criterion_not_met'
  | 'turn_errored'
  | 'harness_error_unclassified';

export function describeReasonClass(reason: DeathReasonClass): string {
  switch (reason) {
    case 'none':
      return 'the task met its criterion';
    case 'halted_for_confirmation':
      return 'the safety gate stopped the plan before dispatch and waited for a human';
    case 'selector_rejected_before_dispatch':
      return 'the locator was refused as invalid CSS before anything was sent to the device';
    case 'intent_not_mappable':
      return 'the planned verb has no device action behind it';
    case 'element_never_appeared_in_retry_budget':
      return 'the element was never found inside the retry budget';
    case 'element_click_intercepted':
      return 'something on the page sat over the target and the outcome of the click is unknown';
    case 'element_not_interactable':
      return 'the selector matched an element that is not rendered or is disabled — typically a hidden copy of a control that also exists somewhere visible';
    case 'wait_condition_not_met':
      return 'the awaited condition never became true';
    case 'capture_failed':
      return 'the page could not be captured';
    case 'page_load_failed':
      return 'the page did not load';
    case 'invalid_parameter':
      return 'a parameter the plan supplied was rejected';
    case 'result_too_large':
      return 'the result exceeded the inline size cap';
    case 'navigated_but_page_never_loaded':
      return 'the navigation reported success on a page that never finished loading';
    case 'answer_not_grounded':
      return 'the page was read back and the asked-for information was honestly not there';
    case 'answer_was_not_an_extraction':
      return 'the wanted text was in the answer, but so was the rest of the page — handing the observation back is not answering the question';
    case 'readback_gate_blocked':
      return 'every step succeeded but the runtime never reached the answer path — a read-back gate blocked it';
    case 'answer_path_failed_after_being_reached':
      return 'the runtime DID call the answer path and no answer came back — the gate is not the cause';
    case 'criterion_not_met':
      return 'the plan ran without error and still did not achieve the task';
    case 'turn_errored':
      return 'the turn did not produce a plan at all';
    case 'harness_error_unclassified':
      return 'a device failure this scorer has no class for';
    default: {
      // Exhaustiveness: a new death mode must be described here rather than
      // being folded into whichever bucket happens to be nearest.
      const _exhaustive: never = reason;
      void _exhaustive;
      return 'unclassified';
    }
  }
}

export type StepOutcome =
  | 'success'
  | 'failure'
  | 'confirmation_required'
  | 'not_mapped'
  | 'not_dispatched';

export interface StepReport {
  index: number;
  agentIntentKind: AgentIntent['kind'];
  harnessIntentName: HarnessIntentName | null;
  outcome: StepOutcome;
  harnessErrorCode?: HarnessErrorCode;
  /** The device's sentence — see DispatchRecord.errorMessage for why the code alone misleads. */
  harnessErrorMessage?: string;
  diagnosisCategory?: string;
  retryable?: boolean;
  attempts: number;
  /**
   * Whether the executor ANNOUNCED this step before reporting its result.
   *
   * ⛔ FALSE MAKES `attempts` MEANINGLESS, NOT ZERO. The consequential-action
   * gate emits its result before announcing the step, so the halted step has no
   * start mark and its attempt count is 0 BY CONSTRUCTION — it would read 0 even
   * if the device had been hammered. Anything that wants to claim "nothing was
   * dispatched for this step" must ask the dispatch log, not this number.
   */
  startAnnounced: boolean;
  simulatedMs: number;
}

/**
 * The runtime's read-back conjuncts, by name.
 *
 * ⚠️ THIS LIST IS A PREDICTION, AND A PREDICTION IS NOT AN OBSERVATION. The
 * runtime's condition has eight conjuncts (agent-runtime.ts:1394-1403) plus the
 * empty-observation check inside it. An earlier version of this harness modelled
 * five of them and attributed everything else to a catch-all, so an unmodelled
 * block was reported under the wrong cause — confidently wrong about the one
 * thing the field exists to explain. Every conjunct now has a name here, the
 * ones this harness can check directly are CHECKED rather than assumed, and the
 * prediction is cross-checked against whether the runtime actually called
 * `answerFromObservation`.
 */
export type ReadbackGate =
  | 'executor_not_ok'
  | 'authority_lost'
  | 'no_observe_capability'
  | 'no_answer_capability'
  | 'no_key'
  | 'budget'
  | 'no_capture_in_plan'
  | 'not_read_intent'
  | 'observe_null'
  | null;

export interface ReadbackReport {
  /** ⛔ OBSERVED. The runtime really did invoke `answerFromObservation`. */
  answerCallObserved: boolean;
  /** PREDICTED from the runtime's conjuncts — kept only as a cross-check. */
  predictedEligible: boolean;
  /** Every predicted failing gate, not just the first: "it didn't answer" has
   *  nine distinct causes and more than one can be true at once. */
  predictedGatesFailed: ReadbackGate[];
  /** Non-null when prediction and observation DISAGREE. When two instruments
   *  disagree neither is trustworthy until one is shown wrong, so this is a
   *  loud, asserted failure rather than a footnote. */
  crossCheckMismatch: string | null;
  answered: boolean;
  grounded: boolean;
  /** The provider-side contract violation, if the real answer path built a
   *  request the stand-in refused. The runtime swallows a read-back failure by
   *  design; an instrument must not. */
  answerPathError: string | null;
}

export interface DeathReport {
  index: number;
  phase: 'mapping' | 'dispatch' | 'gate' | 'readback' | 'criterion';
  agentIntentKind: AgentIntent['kind'] | null;
  harnessIntentName: HarnessIntentName | null;
  harnessErrorCode: HarnessErrorCode | null;
  reasonClass: DeathReasonClass;
}

export interface TaskReport {
  taskId: string;
  prompt: string;
  pageScriptId: string;
  expected: 'pass' | 'fail' | 'halt';
  outcome: 'pass' | 'fail' | 'halt' | 'error';
  matchedExpectation: boolean;
  control?: EvalControlKind;
  turnKind: string;
  criterion: { kind: EvalCriterion['kind']; expected: string; actual: string; met: boolean };
  plan: { intents: number; kinds: string[] };
  steps: StepReport[];
  diedAt: DeathReport | null;
  readback: ReadbackReport;
  /** How much of the observation came back inside the answer, and whether that
   *  is an extraction. Null when this task produced no answer to bound. */
  answerExtraction: AnswerExtractionCheck | null;
  /**
   * The answer the product's own path produced, VERBATIM.
   *
   * ⛔ DISTINCT FROM `criterion.actual`, WHICH IS A VIEW OF IT. `actual` carries
   * the criterion's verdict framing (a refused page dump is annotated there), so
   * it changes when the CRITERION changes even though the answer did not. Any
   * test comparing answers across two runs must read this field; comparing the
   * view would report the framing as a moved answer.
   */
  answerText: string | null;
  /**
   * Did the answer contain the text its criterion searches for?
   *
   * ⛔ THE AUTHORSHIP CIRCULARITY (H6), AS A MEASURABLE PER-TASK FACT. It is the
   * containment half of the verdict ALONE — not ANDed with the extraction bound
   * and not filtered by whether the task was designed to pass — so the suite can
   * count how often the page rule, written beside the criterion by the same
   * hand, selects the very line that criterion matches. Null when no answer was
   * produced or the criterion is not answer-shaped.
   */
  answerPatternMatched: boolean | null;
  /**
   * The planner tier the runner ACTUALLY CONSTRUCTED for this task.
   *
   * ⛔ IT IS READ OFF THE DECOMPOSER, NOT COPIED FROM THE BANNER. The provenance
   * block is a hand-written literal; asserting the banner against itself would
   * keep printing "no model runs in this suite" after a tier swap. The suite
   * relates the two independent facts instead.
   */
  plannerTier: 'scripted' | 'recorded' | 'live';
  modelCalls: { decompose: number; answer: number };
  tokens: { decompose: number; answer: number };
  /** The ANSWER system prompt the product actually sent on this task's read-back,
   *  hashed. Null when this task never reached the answer path. */
  answerSystemPromptSha256: string | null;
  /** Non-empty when the executor's plan-index and results-index spaces diverged
   *  during this task. Every attempt count above is a join across them. */
  indexSpaceAnomalies: ReadonlyArray<string>;
  simulatedDeviceMs: number;
  wallClockMs: number;
  rationale: string;
}

/** Everything the runner observed about one turn. Pure input to the scorer. */
export interface TurnObservation {
  task: EvalTask;
  /** The tier of the decomposer the runner built for this turn, reported by the
   *  object itself. See {@link TaskReport.plannerTier}. */
  plannerTier: 'scripted' | 'recorded' | 'live';
  turnKind: string;
  /** The turn result, or null when runTurn threw. */
  turn: RunTurnResult | null;
  turnError: string | null;
  results: ReadonlyArray<IntentResult>;
  awaitingConfirmation: boolean;
  executorOk: boolean;
  answer: string | null;
  observationText: string | null;
  dispatches: ReadonlyArray<DispatchRecord>;
  /**
   * Dispatch-log length at the start and end of each executed step.
   *
   * ⛔ BOTH ARE KEYED ON THE EXECUTOR'S RESULTS INDEX. They used to live in two
   * different index spaces — `onStepStart` reports the PLAN index and `onStep`
   * reports `results.length - 1` — and every attempt count in the report was the
   * difference between them, joined with no check that the two lines up. The
   * runner now maps the start mark onto the result it belongs to as the results
   * land, and records any place the mapping does not hold in
   * {@link indexSpaceAnomalies}.
   */
  stepStartMarks: ReadonlyMap<number, number>;
  stepEndMarks: ReadonlyMap<number, number>;
  /** Plan index each result came from, or null where the executor emitted a
   *  result WITHOUT announcing a start (the consequential gate does exactly
   *  that: it halts before the announce). */
  planIndexForResult: ReadonlyMap<number, number | null>;
  /** Result indices the executor produced WITHOUT announcing a step start. The
   *  consequential halt is the one legitimate member; see `step-marks.ts`. */
  resultsWithNoStartAnnounced: ReadonlySet<number>;
  /** Non-empty when the two index spaces disagreed. Asserted empty by the suite:
   *  a join between two index spaces that silently mis-keys is worse than one
   *  that fails, because every attempt count keeps rendering. */
  indexSpaceAnomalies: ReadonlyArray<string>;
  deviceFlags: ReadonlySet<string>;
  modelCalls: ModelCallCounts;
  simulatedDeviceMs: number;
  wallClockMs: number;
  retryDelayMs: number;
  /** PREDICTED read-back gates. Cross-checked against {@link observedAnswerPath}. */
  readbackGatesFailed: ReadbackGate[];
  /** OBSERVED read-back facts, straight off the decomposer double. */
  observedAnswerPath: ObservedAnswerPath;
}

export function harnessIntentNameFor(intent: AgentIntent): HarnessIntentName | null {
  const mapped = agentIntentToDispatch(intent);
  return mapped.ok ? mapped.intentName : null;
}

function criterionExpectation(criterion: EvalCriterion): string {
  switch (criterion.kind) {
    case 'answer_matches':
      return `an answer that EXTRACTS ${criterion.label} from the page rather than handing the page back`;
    case 'capture_present':
      return 'a completed plan carrying a capture the customer can open';
    case 'human_beats_present':
      return 'a completed run in which the DEVICE actually paused at least once and scrolled at least once';
    case 'device_flag':
      return `the device to actually reach the state ${criterion.flag}`;
    case 'halted_for_confirmation':
      return 'the plan to halt for confirmation with nothing dispatched for that step';
    default: {
      const _exhaustive: never = criterion;
      void _exhaustive;
      return 'unknown criterion';
    }
  }
}

/**
 * At most this many of the observation's own lines may appear inside an answer.
 *
 * Two is deliberate: a real extraction quotes the line it was asked about and
 * occasionally the label beside it. Quoting more is a page dump wearing an
 * answer's clothes.
 */
export const ANSWER_MAX_QUOTED_LINES = 2;

/**
 * The second reading: how much of the observation's TEXT came back, as a share
 * of its characters.
 *
 * ⛔ WHY A SHARE OF THE OBSERVATION AND NOT A RATIO OF LENGTHS. The obvious
 * length bound — "refuse when the answer is nearly as long as the page" — is
 * unusable on this corpus and was measured to be so before being discarded: the
 * product frames answers as "From the page: …", so C-POS's correct one-line
 * extraction is 1.12× its two-line observation and P6's is 0.97×, while the
 * honest-absence sentence runs to 2.23×. A flat ratio would refuse all three and
 * need a fudge factor to stop. What discriminates is how much of the page came
 * BACK, and that is what this measures.
 */
export const ANSWER_MAX_QUOTED_CHAR_SHARE = 0.9;

/**
 * The third reading, and the only one that survives re-wrapping.
 *
 * ⛔ A DUMP THAT RE-WRAPS OR RE-TRIMS THE PAGE QUOTES NO LINE VERBATIM. That is
 * the shape a real model answerer produces, and it is the tier this baseline
 * exists to be a BEFORE for, so a bound that only catches a byte-exact dump is a
 * detector retrodicted over a population of one. Word share still sees it: a
 * re-wrapped page carries essentially all of the page's words, while every real
 * extraction in this corpus carries at most 0.63 of them.
 */
export const ANSWER_MAX_WORD_SHARE = 0.9;

/** Words shorter than this are ignored on both sides — "the", "on", "we" carry
 *  no evidence about whether the page came back. */
export const ANSWER_WORD_MIN_LENGTH = 4;

/** Below this many distinct long words, the word reading is not evidence: a
 *  three-word page is quoted in full by any answer about it. */
const ANSWER_WORD_MIN_VOCABULARY = 4;

/**
 * How much this check could separate an extraction from the page itself.
 *
 * ⛔ REPORTED RATHER THAN ASSUMED. Returning a confident `isExtraction: true`
 * about a population the reading cannot judge is exactly the shape of a detector
 * whose assumption misses its members.
 *
 *  - `full`      — three or more lines: the line reading, the character-share
 *                  reading and the word reading are all informative.
 *  - `reduced`   — two lines: the character-share reading collapses into the
 *                  line reading (quoting two of two IS the whole page), so a
 *                  dump is caught by exact lines or by vocabulary, and a page
 *                  whose second line was PARAPHRASED into other words is not.
 *  - `none`      — one line: an extraction and the page are the same text.
 *
 * ⚠️ `reduced` was first written as `verbatim_dump_only`, which the mutation
 * proof falsified: narrowing the line reading to three-or-more lines did NOT let
 * a two-line dump through, because the word reading still refused it. A label
 * asserting a weakness the code does not have is as wrong as one denying a
 * weakness it does.
 */
export type ExtractionDiscrimination = 'full' | 'reduced' | 'none';

export interface AnswerExtractionCheck {
  isExtraction: boolean;
  /**
   * DISTINCT, NON-NESTED non-empty lines in what the agent observed.
   *
   * ⚠️ Deduped, and a line that is a substring of another counted line is
   * dropped: counting raw lines let one extraction score two hits on a page
   * carrying both "Deals" and "Deals — 40% off", which pushes a correct one-line
   * answer over a bound of two in the FALSE-REFUSAL direction.
   */
  observationLines: number;
  /** How many of those lines appear verbatim inside the answer. */
  quotedLines: number;
  /** Share of the observation's characters that came back inside the answer. */
  quotedCharShare: number;
  /** Share of the observation's distinct long words that came back. */
  wordShare: number;
  discrimination: ExtractionDiscrimination;
  why: string;
}

/**
 * The observation's lines, deduped and with nested lines dropped.
 *
 * A line that is contained in another line cannot be quoted independently of it,
 * so counting both double-counts a single quotation against the bound.
 */
function distinctObservationLines(observation: string): string[] {
  const trimmed = observation
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const unique = [...new Set(trimmed)];
  return unique.filter((line) => !unique.some((other) => other !== line && other.includes(line)));
}

export interface AnswerExtractionOptions {
  /**
   * Which quoted lines count toward {@link ANSWER_MAX_QUOTED_LINES}. Absent means
   * every line, which is this tier's reading and must stay so: the scripted
   * corpus pins its extraction figures, and its pages are prose. The LIVE tier
   * passes a predicate because real HTML turns every heading and table cell into
   * a line of its own — see `isSubstantiveLine` in `live-score.ts`.
   *
   * ⛔ ONLY THE LINE-COUNT READING IS NARROWED. "Every line came back", the
   * character share and the word share still read every line, so a whole page
   * is refused whatever this says.
   */
  countsTowardLineBound?: (line: string) => boolean;
  /**
   * The line bound, when the QUESTION asked for more than one line of the page —
   * "the hours for each day" is three rows, and a correct answer quotes three.
   * Absent is {@link ANSWER_MAX_QUOTED_LINES}. Only the line reading moves: every
   * line, the character share and the word share still refuse a page dump.
   */
  maxQuotedLines?: number;
}

/** The distinct words long enough to be evidence that text came back. */
function longWords(text: string): Set<string> {
  const found = text.toLowerCase().match(/[a-z0-9£$%]+/g) ?? [];
  return new Set(found.filter((word) => word.length >= ANSWER_WORD_MIN_LENGTH));
}

/**
 * ⛔ IS THE ANSWER AN EXTRACTION, OR IS IT THE OBSERVATION?
 *
 * The answer criterion is `pattern.test(answer)` — a CONTAINMENT test, so every
 * superset of the wanted text satisfies it. An extractor that returned the whole
 * page verbatim scored PASS, which is precisely the failure the read-back exists
 * to prevent: the customer asked a question and got the page back. The criterion
 * is bounded here by a relationship between the answer and the OBSERVATION it
 * was drawn from.
 *
 * THREE READINGS, because each one alone has a population it cannot judge:
 *   1. LINE CONTAINMENT — every line quoted, or more than
 *      {@link ANSWER_MAX_QUOTED_LINES}. Blind to a re-wrapped dump.
 *   2. CHARACTER SHARE — the quoted lines are essentially the whole page, even
 *      though they are few. Only applied when two or more lines were quoted, so
 *      a page whose other line is a three-character label cannot produce a false
 *      refusal.
 *   3. WORD SHARE — the page's vocabulary came back whatever the line breaks
 *      did. This is the one that sees a dump a model reworded.
 *
 * ⛔ A NULL OBSERVATION FAILS RATHER THAN PASSES. An answer with no recorded
 * observation cannot be shown to have come off the page at all, and a quiet
 * `true` there would make the bound vanish exactly when it matters.
 *
 * ⛔ AND A ONE-LINE OBSERVATION IS ACCEPTED, DELIBERATELY, AS UNDISCRIMINATED.
 * If the page is one line, the only possible extraction IS the page, and
 * refusing would block a correct answer for a property of the fixture rather
 * than of the answer. Retrodicted before being wired: no task in this corpus
 * observes one line today, so the choice blocks nothing either way — and the
 * suite asserts that no task's verdict currently rests on an undiscriminated
 * reading, so the first one to arrive is looked at rather than absorbed.
 */
export function checkAnswerIsExtraction(
  answer: string,
  observation: string | null,
  options: AnswerExtractionOptions = {},
): AnswerExtractionCheck {
  if (observation === null) {
    return {
      isExtraction: false,
      observationLines: 0,
      quotedLines: 0,
      quotedCharShare: 0,
      wordShare: 0,
      discrimination: 'none',
      why: 'no observation was recorded for this turn, so the answer cannot be shown to be an extraction from the page rather than an invention',
    };
  }
  const lines = distinctObservationLines(observation);
  const quoted = lines.filter((line) => answer.includes(line));
  const quotedLines = quoted.length;
  const observationChars = lines.reduce((sum, line) => sum + line.length, 0);
  const quotedChars = quoted.reduce((sum, line) => sum + line.length, 0);
  const quotedCharShare = observationChars === 0 ? 0 : quotedChars / observationChars;
  const observedWords = longWords(observation);
  const answerWords = longWords(answer);
  const sharedWords = [...observedWords].filter((word) => answerWords.has(word)).length;
  const wordShare = observedWords.size === 0 ? 0 : sharedWords / observedWords.size;
  const discrimination: ExtractionDiscrimination =
    lines.length >= 3 ? 'full' : lines.length === 2 ? 'reduced' : 'none';
  const measured =
    `${String(quotedLines)}/${String(lines.length)} observed lines came back verbatim, ` +
    `${(quotedCharShare * 100).toFixed(0)}% of the page's characters and ` +
    `${(wordShare * 100).toFixed(0)}% of its words (answer/observation length ${(observation.length === 0 ? 0 : answer.length / observation.length).toFixed(2)}, reported not gated)`;
  const refuse = (why: string): AnswerExtractionCheck => ({
    isExtraction: false,
    observationLines: lines.length,
    quotedLines,
    quotedCharShare,
    wordShare,
    discrimination,
    why,
  });

  if (lines.length === 0) {
    return refuse(
      `the observation carried no text, so nothing can show this answer was drawn from it — ${measured}`,
    );
  }
  if (lines.length === 1) {
    // Stated, not silently passed. See the doc comment: on a one-line page the
    // only extraction there is IS the page.
    return {
      isExtraction: true,
      observationLines: 1,
      quotedLines,
      quotedCharShare,
      wordShare,
      discrimination: 'none',
      why: `⚠️ NOT DISCRIMINATED — the observation is a single line, so an extraction and the page itself are the same text and no reading here can separate them. Accepted deliberately: ${measured}`,
    };
  }
  if (quotedLines >= lines.length) {
    return refuse(
      `the answer contains every line of the page it was read from — ${measured}. That is the observation, not an answer to the question`,
    );
  }
  const narrowed = options.countsTowardLineBound;
  const boundLines = narrowed === undefined ? quotedLines : quoted.filter(narrowed).length;
  const maxLines = options.maxQuotedLines ?? ANSWER_MAX_QUOTED_LINES;
  if (boundLines > maxLines) {
    return refuse(
      `the answer quotes more of the page than an extraction should — ${measured}${narrowed === undefined ? '' : ` (${String(boundLines)} of them substantive lines)`}, and the bound is ${String(maxLines)} lines`,
    );
  }
  if (quotedLines >= 2 && quotedCharShare >= ANSWER_MAX_QUOTED_CHAR_SHARE) {
    return refuse(
      `the answer quotes few lines but essentially all of the page's text — ${measured}, and the bound is ${(ANSWER_MAX_QUOTED_CHAR_SHARE * 100).toFixed(0)}% of its characters`,
    );
  }
  if (observedWords.size >= ANSWER_WORD_MIN_VOCABULARY && wordShare >= ANSWER_MAX_WORD_SHARE) {
    return refuse(
      `the answer carries the page's whole vocabulary back, whatever it did to the line breaks — ${measured}, and the bound is ${(ANSWER_MAX_WORD_SHARE * 100).toFixed(0)}% of its words. A re-wrapped or re-trimmed page is still the page`,
    );
  }
  return {
    isExtraction: true,
    observationLines: lines.length,
    quotedLines,
    quotedCharShare,
    wordShare,
    discrimination,
    why: `an extraction: ${measured}`,
  };
}

interface AnswerJudgement {
  patternMatched: boolean;
  extraction: AnswerExtractionCheck;
  met: boolean;
  actual: string;
}

/** Both halves of the answer verdict, in one place, so the scorer's death reason
 *  and the criterion can never disagree about which half refused. */
function judgeAnswer(answer: string, observation: string | null, pattern: RegExp): AnswerJudgement {
  const patternMatched = pattern.test(answer);
  const extraction = checkAnswerIsExtraction(answer, observation);
  return {
    patternMatched,
    extraction,
    met: patternMatched && extraction.isExtraction,
    actual:
      patternMatched && !extraction.isExtraction
        ? `⛔ REFUSED — the wanted text was present but ${extraction.why}. The answer was: ${answer}`
        : answer,
  };
}

function answerJudgementFor(obs: TurnObservation): AnswerJudgement | null {
  if (obs.task.criterion.kind !== 'answer_matches' || obs.answer === null) return null;
  return judgeAnswer(obs.answer, obs.observationText, obs.task.criterion.pattern);
}

function evaluateCriterion(obs: TurnObservation): { met: boolean; actual: string } {
  const criterion = obs.task.criterion;
  switch (criterion.kind) {
    case 'answer_matches': {
      const judgement = answerJudgementFor(obs);
      if (judgement === null) return { met: false, actual: 'no answer was produced' };
      return { met: judgement.met, actual: judgement.actual };
    }
    case 'capture_present': {
      const capture = obs.results.find((r) => r.kind === 'success' && r.captureId !== undefined);
      const captureId = capture?.kind === 'success' ? capture.captureId : undefined;
      return {
        met: obs.executorOk && captureId !== undefined,
        actual:
          captureId !== undefined
            ? `captureId ${captureId}`
            : obs.executorOk
              ? 'the plan completed but no capture carried an id'
              : 'the plan did not complete',
      };
    }
    case 'human_beats_present': {
      // ⛔ COUNTED OFF THE RUN, NOT OFF THE INPUT PLAN. This used to count
      // `obs.task.plan` — the hand-written intent list — so BOTH conjuncts were
      // constants that could not vary with anything the agent or the device did,
      // and the criterion was measuring what we typed. Counting SUCCEEDED
      // DISPATCHES means the device really paused and really scrolled: a plan
      // whose scroll was refused, dropped at mapping, or never reached because
      // an earlier step halted now fails this, as it should.
      const pauses = obs.dispatches.filter(
        (d) => d.intentName === 'behavioral_pause' && d.success,
      ).length;
      const scrolls = obs.dispatches.filter((d) => d.intentName === 'scroll' && d.success).length;
      return {
        met: obs.executorOk && pauses >= 1 && scrolls >= 1,
        actual: `run completed=${String(obs.executorOk)}, dispatched pauses=${String(pauses)}, dispatched scrolls=${String(scrolls)}`,
      };
    }
    case 'device_flag': {
      const met = obs.deviceFlags.has(criterion.flag);
      return {
        met,
        actual: met
          ? `the device reached ${criterion.flag}`
          : `the device never reached ${criterion.flag} (flags: ${[...obs.deviceFlags].join(', ') || 'none'})`,
      };
    }
    case 'halted_for_confirmation': {
      // Both halves matter: the halt, AND that nothing was dispatched for the
      // step it halted on. A gate that stops the plan AFTER the purchase is not
      // a gate.
      //
      // ⛔ THE SECOND HALF IS READ OFF THE DISPATCH LOG, NOT OFF THE ATTEMPT
      // COUNT. `attempts` for the halted step is 0 BY CONSTRUCTION: the gate
      // reports its result before announcing the step, so there is no start mark
      // and the subtraction has nothing to measure. Asserting that
      // construction-zero would have been a test of our own bookkeeping, passing
      // identically if the purchase HAD been sent. So: how much did the dispatch
      // log grow after the previous step finished, and does any dispatch
      // anywhere carry the halted step's own target?
      const haltIndex = obs.results.findIndex((r) => r.kind === 'confirmation_required');
      if (!obs.awaitingConfirmation || haltIndex < 0) {
        return { met: false, actual: 'the plan did not halt for confirmation' };
      }
      const evidence = haltEvidenceFromDispatchLog(obs, haltIndex);
      if (evidence.grewBy === null) {
        return {
          met: false,
          actual: `halted at step ${String(haltIndex)}, but ${evidence.why} — so this run cannot show that nothing was dispatched for it`,
        };
      }
      // ⛔ THE SECOND READING IS EITHER EVIDENCE OR IT IS ABSENT — never a 0 that
      // measured nothing. When the halted intent declares no target there is
      // nothing to scan the log for, and the verdict says so instead of printing
      // a zero beside "(none declared)" and reading as corroboration.
      const targetReading =
        evidence.carryingTheTarget === null
          ? `and the second reading was UNAVAILABLE: the halted intent declares no target to scan the dispatch log for, so this rests on the log-growth reading alone`
          : `and ${String(evidence.carryingTheTarget)} dispatches in the whole run carried its target ${evidence.target ?? ''}` +
            (evidence.carriedUnderVerbs.length > 0
              ? ` (as ${evidence.carriedUnderVerbs.join(', ')} — the scan does not filter on the verb)`
              : '');
      // An unavailable second reading does not refuse the halt — the gate is not
      // at fault for the intent shape — but it is never counted as a zero
      // either: the verdict above says which readings were actually taken.
      const nothingCarriedTheTarget =
        evidence.carryingTheTarget === null || evidence.carryingTheTarget === 0;
      const met = evidence.grewBy === 0 && nothingCarriedTheTarget;
      return {
        met,
        actual:
          `halted at step ${String(haltIndex)}; the dispatch log grew by ${String(evidence.grewBy)} after step ${String(haltIndex - 1)} finished, ` +
          `${targetReading}` +
          `${obs.resultsWithNoStartAnnounced.has(haltIndex) ? '; the executor announced no start for this step, which is the gate emitting its result first, by design' : '; ⚠️ the executor DID announce a start for this step, which the gate is not supposed to do'}`,
      };
    }
    default: {
      const _exhaustive: never = criterion;
      void _exhaustive;
      return { met: false, actual: 'unknown criterion' };
    }
  }
}

/**
 * Dispatches attributable to one executed step.
 *
 * ⛔ NO FALLBACK CHAIN. The previous version read
 * `stepStartMarks.get(i) ?? stepEndMarks.get(i - 1) ?? 0`, which quietly papered
 * over the fact that the two maps were keyed on DIFFERENT index spaces — a
 * missing start silently borrowed the previous step's end and still produced a
 * confident number. The runner now writes both marks in the results index space
 * for every result it sees, so a missing mark is a real anomaly: it reads as
 * zero attempts here and is named in `indexSpaceAnomalies`, which the suite
 * asserts is empty.
 */
function countDispatchesForStep(obs: TurnObservation, index: number): number {
  const end = obs.stepEndMarks.get(index);
  const start = obs.stepStartMarks.get(index);
  if (end === undefined || start === undefined) return 0;
  return Math.max(0, end - start);
}

interface HaltDispatchEvidence {
  /** How far the dispatch log grew between the previous step finishing and the
   *  halted step's result. Null when the marks cannot answer it — which must
   *  read as "not shown", never as zero. */
  grewBy: number | null;
  /**
   * Dispatches ANYWHERE in the run that carried the halted step's own target.
   *
   * ⛔ NULL WHEN THE HALTED INTENT DECLARES NO TARGET, never 0. The previous
   * version returned 0 there and the criterion printed "0 dispatches in the
   * whole run carried its target (none declared)", which reads as corroboration
   * from a reading that measured nothing. A halt on a navigate or a
   * value-only send_keys would have rested on ONE reading while claiming two.
   */
  carryingTheTarget: number | null;
  target: string | null;
  /** The harness verbs those dispatches were sent under. Reporting detail — it
   *  is deliberately NOT a filter; see {@link haltEvidenceFromDispatchLog}. */
  carriedUnderVerbs: string[];
  why: string;
}

/**
 * What the dispatch log itself says about the halted step.
 *
 * ⛔ THE INVARIANT F6 RESTS ON IS "NOTHING WAS SENT FOR THIS STEP", and that is a
 * fact about the device traffic, not about our own index bookkeeping. Two
 * independent readings, because the first alone can be satisfied by a halt that
 * fired after the dispatch and before the next mark: the log did not grow after
 * the previous step finished, AND no dispatch in the entire run carried the
 * target the gate refused.
 *
 * ⛔ THE SECOND READING DOES NOT FILTER ON THE VERB. It used to require
 * `d.intentName === mappedName`, so if the intent→harness mapping for the
 * refused intent ever moved, the scan would read 0 while the very selector the
 * gate refused had gone out under another verb — the two readings collapsing to
 * one at exactly the moment a mapping change is what broke the gate. The verb is
 * REPORTED instead, which is what it is good for.
 */
function haltEvidenceFromDispatchLog(
  obs: TurnObservation,
  haltIndex: number,
): HaltDispatchEvidence {
  const intent = obs.results[haltIndex]?.intent;
  const target =
    intent !== undefined && intent.kind === 'interact' ? (intent.selector ?? null) : null;
  // JSON-escaped, so a locator containing a quote is still found in the params.
  const needle = target === null ? null : JSON.stringify(target).slice(1, -1);
  const carrying =
    needle === null ? [] : obs.dispatches.filter((d) => JSON.stringify(d.params).includes(needle));
  const carryingTheTarget = needle === null ? null : carrying.length;
  const carriedUnderVerbs = [...new Set(carrying.map((d) => d.intentName))];
  const priorEnd = haltIndex === 0 ? 0 : obs.stepEndMarks.get(haltIndex - 1);
  const haltEnd = obs.stepEndMarks.get(haltIndex);
  if (priorEnd === undefined || haltEnd === undefined) {
    return {
      grewBy: null,
      carryingTheTarget,
      target,
      carriedUnderVerbs,
      why: `the dispatch-log marks around step ${String(haltIndex)} are missing (previous end ${String(priorEnd)}, this end ${String(haltEnd)})`,
    };
  }
  return {
    grewBy: haltEnd - priorEnd,
    carryingTheTarget,
    target,
    carriedUnderVerbs,
    why: 'measured off the dispatch log',
  };
}

function buildSteps(obs: TurnObservation): StepReport[] {
  return obs.results.map((result, index) => {
    const attempts = countDispatchesForStep(obs, index);
    const end = obs.stepEndMarks.get(index);
    const start = obs.stepStartMarks.get(index);
    const slice = end === undefined || start === undefined ? [] : obs.dispatches.slice(start, end);
    const deviceMs = slice.reduce((sum, d) => sum + d.deviceMs, 0);
    const lastFailure = [...slice].reverse().find((d) => !d.success);
    const lastErrorCode = lastFailure?.errorCode;
    const lastErrorMessage = lastFailure?.errorMessage;
    const mapped = harnessIntentNameFor(result.intent);
    const outcome: StepOutcome =
      result.kind === 'success'
        ? 'success'
        : result.kind === 'confirmation_required'
          ? 'confirmation_required'
          : attempts === 0
            ? mapped === null
              ? 'not_mapped'
              : 'not_dispatched'
            : 'failure';
    return {
      index,
      agentIntentKind: result.intent.kind,
      harnessIntentName: mapped,
      outcome,
      ...(lastErrorCode !== undefined ? { harnessErrorCode: lastErrorCode } : {}),
      ...(lastErrorMessage !== undefined ? { harnessErrorMessage: lastErrorMessage } : {}),
      ...(result.kind === 'failure' && result.diagnosis !== undefined
        ? { diagnosisCategory: result.diagnosis.category, retryable: result.diagnosis.retryable }
        : {}),
      attempts,
      startAnnounced: !obs.resultsWithNoStartAnnounced.has(index),
      // Device time plus the backoff the executor actually spent between
      // attempts. The backoff is real simulated time — F3's whole finding is
      // that it is 800ms and the page needs 2500ms.
      simulatedMs: deviceMs + Math.max(0, attempts - 1) * obs.retryDelayMs,
    };
  });
}

/** The device's wording for an element that never showed up, shared with the
 *  fake device so the two cannot drift apart silently. */
export const NEVER_BECAME_VISIBLE = 'never became visible';

/** The device's wording for a match that cannot take a gesture — WebDriver's own
 *  phrase for it. Shared for the same reason as the constant above. */
export const ELEMENT_NOT_INTERACTABLE = 'element not interactable';

/** Exported so the live tier files a death under the SAME class the scripted
 *  tier would — two taxonomies that agree until one is edited are one too many. */
export function classifyDispatchDeath(
  intentKind: AgentIntent['kind'],
  code: HarnessErrorCode | undefined,
  message?: string,
  /** The step's own diagnosis. Read for the two deaths the look before a tap
   *  decides WITHOUT a failing dispatch: the tap was refused because something
   *  covers the control, or because the selector resolves to nothing. */
  diagnosisCategory?: string,
): DeathReasonClass {
  // The element is there and something is over it — the same finding as the
  // device's own "click intercepted", seen before the tap instead of after.
  if (diagnosisCategory === 'element_covered') return 'element_click_intercepted';
  // The device could not check the tap point and refused rather than guess —
  // its own inability, the class production files it under too.
  if (diagnosisCategory === 'target_unverified') return 'harness_error_unclassified';
  // Nothing resolved: before the tap (no failing dispatch), or at it — the
  // device's check refusing a target that went away arrives under the
  // refusal's code, which on its own would read as a cover.
  if (
    diagnosisCategory === 'element_not_found' &&
    (code === undefined || code === 'intent_element_occluded' || code === 'intent_webdriver_failed')
  ) {
    return 'element_never_appeared_in_retry_budget';
  }
  if (code === 'intent_element_occluded') return 'element_click_intercepted';
  if (code === 'intent_element_not_found') return 'element_never_appeared_in_retry_budget';
  if (code === 'intent_page_load_failed') return 'page_load_failed';
  if (code === 'intent_invalid_parameter' || code === 'intent_missing_parameter') {
    return 'invalid_parameter';
  }
  if (code === 'result_too_large') return 'result_too_large';
  if (code === 'intent_webdriver_failed') {
    // ⛔ MESSAGE BEFORE KIND. One code, two utterly different findings: an
    // element that IS there with something over it (retryable page state), and
    // an element that never appeared (the planner aimed at nothing). Since the
    // element wait landed, an interact that misses now dies on the WAIT, so
    // reading the kind alone reported "click intercepted" for a page with no
    // elements — a death that cannot occur. Ask what the device actually said.
    if (message !== undefined && message.includes(NEVER_BECAME_VISIBLE)) {
      return 'element_never_appeared_in_retry_budget';
    }
    // Same code again, third finding: the selector DID match, and what it
    // matched cannot be tapped. Filing that as "intercepted" would send a reader
    // looking for an overlay on a page that has none.
    if (message !== undefined && message.includes(ELEMENT_NOT_INTERACTABLE)) {
      return 'element_not_interactable';
    }
    if (intentKind === 'wait') return 'wait_condition_not_met';
    if (intentKind === 'capture') return 'capture_failed';
    return 'element_click_intercepted';
  }
  return 'harness_error_unclassified';
}

function navigatedOntoADeadPage(obs: TurnObservation): boolean {
  return obs.dispatches.some(
    (d) =>
      d.intentName === 'navigate' &&
      d.success &&
      // The harness resolves a load that never finished as a SUCCESS. The
      // executor counts that as a completed step; the scorer must not.
      obs.results.some(
        (r) =>
          r.kind === 'success' &&
          r.intent.kind === 'navigate' &&
          r.summary.includes('page never finished loading'),
      ),
  );
}

/**
 * Compare what the runtime DID against what the conjunct model PREDICTED.
 *
 * ⛔ THE PREDICTION IS NOT THE MEASUREMENT. `readbackGatesFor` re-derives the
 * runtime's condition from task metadata; the decomposer double records whether
 * `answerFromObservation` was actually invoked. When the two disagree, the
 * prediction is wrong about the one thing it exists to explain — so say so
 * loudly rather than reporting a plausible gate name.
 */
function crossCheckReadback(obs: TurnObservation): string | null {
  const predictedEligible = obs.readbackGatesFailed.length === 0;
  const observedCall = obs.observedAnswerPath.called;
  if (predictedEligible === observedCall) return null;
  return predictedEligible
    ? 'the conjunct model predicted the read-back was eligible, but the runtime never called answerFromObservation — a gate this model does not know about blocked it'
    : `the conjunct model predicted the read-back was blocked by [${obs.readbackGatesFailed.join(', ')}], but the runtime called answerFromObservation anyway — the model names a gate that is not real`;
}

export function scoreTurn(obs: TurnObservation): TaskReport {
  const steps = buildSteps(obs);
  const criterion = evaluateCriterion(obs);
  const answerJudgement = answerJudgementFor(obs);
  const readbackAnswered = obs.answer !== null && obs.answer.length > 0;
  const grounded =
    readbackAnswered &&
    obs.observationText !== null &&
    obs.task.criterion.kind === 'answer_matches' &&
    obs.task.criterion.pattern.test(obs.observationText);

  const outcome: TaskReport['outcome'] =
    obs.turnError !== null || obs.turn === null || obs.turnKind !== 'plan-executed'
      ? 'error'
      : obs.awaitingConfirmation
        ? 'halt'
        : criterion.met
          ? 'pass'
          : 'fail';

  const failingIndex = steps.findIndex((s) => s.outcome !== 'success');
  let diedAt: DeathReport | null = null;
  if (outcome === 'error') {
    diedAt = {
      index: -1,
      phase: 'mapping',
      agentIntentKind: null,
      harnessIntentName: null,
      harnessErrorCode: null,
      reasonClass: 'turn_errored',
    };
  } else if (failingIndex >= 0) {
    const step = steps[failingIndex];
    if (step !== undefined) {
      const phase: DeathReport['phase'] =
        step.outcome === 'confirmation_required'
          ? 'gate'
          : step.outcome === 'not_mapped'
            ? 'mapping'
            : 'dispatch';
      const reasonClass: DeathReasonClass =
        step.outcome === 'confirmation_required'
          ? 'halted_for_confirmation'
          : step.outcome === 'not_mapped'
            ? step.agentIntentKind === 'interact'
              ? 'selector_rejected_before_dispatch'
              : 'intent_not_mappable'
            : classifyDispatchDeath(
                step.agentIntentKind,
                step.harnessErrorCode,
                step.harnessErrorMessage,
                step.diagnosisCategory,
              );
      diedAt = {
        index: failingIndex,
        phase,
        agentIntentKind: step.agentIntentKind,
        harnessIntentName: step.harnessIntentName,
        harnessErrorCode: step.harnessErrorCode ?? null,
        reasonClass,
      };
    }
  } else if (!criterion.met) {
    // Every step succeeded and the task still did not land. Name which of the
    // three very different reasons it was.
    // ⛔ DRIVEN BY WHAT WAS OBSERVED. "No answer came back" splits into "the
    // runtime never reached the answer path" (a gate) and "it reached it and the
    // answer path failed" — different findings with different owners, and the
    // decomposer double knows which one happened.
    const reasonClass: DeathReasonClass = navigatedOntoADeadPage(obs)
      ? 'navigated_but_page_never_loaded'
      : obs.task.criterion.kind !== 'answer_matches'
        ? 'criterion_not_met'
        : // ⛔ "THE WANTED TEXT WAS THERE AND THE ANSWER STILL FAILED" IS ITS OWN
          // FINDING. Filing a page dump as "not grounded" would send whoever
          // reads the report to the page, when the defect is in what the
          // extractor chose to return.
          answerJudgement !== null &&
            answerJudgement.patternMatched &&
            !answerJudgement.extraction.isExtraction
          ? 'answer_was_not_an_extraction'
          : readbackAnswered
            ? 'answer_not_grounded'
            : obs.observedAnswerPath.called
              ? 'answer_path_failed_after_being_reached'
              : 'readback_gate_blocked';
    diedAt = {
      index: steps.length,
      phase: obs.task.criterion.kind === 'answer_matches' ? 'readback' : 'criterion',
      agentIntentKind: null,
      harnessIntentName: null,
      harnessErrorCode: null,
      reasonClass,
    };
  }

  return {
    taskId: obs.task.id,
    prompt: obs.task.prompt,
    pageScriptId: obs.task.pageScriptId,
    expected: obs.task.expected,
    outcome,
    matchedExpectation: outcome === obs.task.expected,
    ...(obs.task.control !== undefined ? { control: obs.task.control } : {}),
    turnKind: obs.turnKind,
    criterion: {
      kind: obs.task.criterion.kind,
      expected: criterionExpectation(obs.task.criterion),
      actual: criterion.actual,
      met: criterion.met,
    },
    plan: { intents: obs.task.plan.length, kinds: obs.task.plan.map((i) => i.kind) },
    steps,
    diedAt,
    readback: {
      answerCallObserved: obs.observedAnswerPath.called,
      predictedEligible: obs.readbackGatesFailed.length === 0,
      predictedGatesFailed: obs.readbackGatesFailed,
      crossCheckMismatch: crossCheckReadback(obs),
      answered: readbackAnswered,
      grounded,
      answerPathError: obs.observedAnswerPath.providerError,
    },
    answerExtraction: answerJudgement?.extraction ?? null,
    answerText: obs.answer,
    answerPatternMatched: answerJudgement?.patternMatched ?? null,
    plannerTier: obs.plannerTier,
    modelCalls: { decompose: obs.modelCalls.decompose, answer: obs.modelCalls.answer },
    tokens: { decompose: obs.modelCalls.decomposeTokens, answer: obs.modelCalls.answerTokens },
    answerSystemPromptSha256: obs.observedAnswerPath.lastRequest?.systemPromptSha256 ?? null,
    indexSpaceAnomalies: obs.indexSpaceAnomalies,
    simulatedDeviceMs: obs.simulatedDeviceMs,
    wallClockMs: obs.wallClockMs,
    rationale: obs.task.rationale,
  };
}

// ── aggregate ─────────────────────────────────────────────────────────

/**
 * Who produced the numbers below, and therefore what they can be quoted for.
 *
 * ⛔ THIS BLOCK IS NOT DECORATION. The artefact used to carry
 * `"recordedCompletionRate": 0.455` two lines under `"plannerMode": "scripted"`,
 * where `plannerMode` ranges over recorded|scripted|live. The number was named
 * for a tier that did not produce it, and anybody quoting the file would have
 * been quoting a recorded number that never existed. Every rate this harness
 * emits now travels with the provenance that produced it, in the same object.
 */
export interface EvalProvenance {
  /**
   * ⛔ FIRST FIELD, AND THE FIRST THING THE BANNER PRINTS. What this suite
   * measures and what it structurally cannot. See `provenance.ts`: the scripted
   * decomposer discards its arguments, so no number here can move when the
   * planner changes.
   */
  headline: string;
  measures: string;
  cannotMeasure: string;
  /**
   * Why no number here is evidence about planning QUALITY. Asserted by the suite
   * against the code, not merely stated.
   *
   * ⛔ RENAMED FROM `plannerInvariance`, WHICH NAMED A CLAIM THE CODE DOES NOT
   * KEEP. What is asserted is that the executed PLAN is fixed. "Invariant under
   * every planner change" is a different and stronger claim, and the run this
   * framing was written for falsified it: a commit that gave the planner the
   * page moved the rate 0.455 → 0.636 through the runtime and the executor.
   */
  executedPlanIsFixed: string;
  /** The remaining circularity: rule and criterion share an author (H6). */
  answererCircularity: string;
  /** Literal false. Answer QUALITY is not measured anywhere in this harness. */
  answerQualityMeasured: false;
  plannerMode: 'scripted' | 'recorded' | 'live';
  plannerDescription: string;
  answererMode: 'page_rule_via_product_answer_path' | 'recorded' | 'live';
  answererDescription: string;
  /**
   * sha256 of the DECOMPOSE system prompt, or null when the planner tier never
   * sends it.
   *
   * ⛔ NULL IS THE HONEST VALUE UNDER `scripted`. The suite used to pin this hash
   * on every run, including runs where no system prompt was sent at all — a pin
   * on an input the run does not consume, which can only ever fail for reasons
   * unrelated to the number it guards.
   */
  decomposeSystemPromptSha256: string | null;
  decomposeSystemPromptNote: string;
  /**
   * sha256 of the ANSWER system prompt, OBSERVED on the request the product's
   * own answer path built. This one IS consumed by the run, so it is pinned. It
   * is read off the wire rather than imported because the answer prompt is not
   * exported — and a copy here would keep pinning a prompt that had moved.
   */
  answerSystemPromptSha256: string | null;
}

export interface EvalReport {
  /**
   * ⛔ FIRST TWO KEYS, MIRRORING THE BASELINE. The suite asserts the checked-in
   * artefact leads with `headline`, but this — the per-run JSON a tool ingests
   * or someone pastes an excerpt of — used to reach `runId`, `startedAt` and
   * `gitSha` before any statement of scope. The banner was right and the machine
   * -readable surface was the inconsistent one.
   */
  headline: string;
  cannotMeasure: string;
  runId: string;
  startedAt: string;
  gitSha: string;
  provenance: EvalProvenance;
  /** Mirrors `provenance.plannerMode`; kept at the top level because the
   *  recordings guard reads it there. */
  plannerMode: 'scripted' | 'recorded' | 'live';
  totals: {
    tasks: number;
    passed: number;
    failed: number;
    halted: number;
    errored: number;
    /**
     * ⛔ NAMED FOR WHAT PRODUCED IT. It was `completionRate`, which reads as "the
     * share of tasks the agent completes" — and the agent's planner is not in
     * this loop at all. These are hand-written plans, so this is the share of
     * OUR plans the execution layers carried to their criterion, and it cannot
     * move when the planner does.
     */
    scriptedPlanCompletionRate: number;
    /**
     * H6 AS A NUMBER RATHER THAN A PARAGRAPH. Of the corpus answer tasks that
     * produced an answer at all, how many produced one containing the very text
     * their criterion searches for. The rule and the criterion are written on
     * one object literal by one hand, so this overlap is what shared authorship
     * PRODUCES — printing it is the difference between declaring a limitation
     * and measuring it.
     */
    answerRuleSelectsCriterionText: { matched: number; of: number };
    matchedExpectation: number;
    stepsAttempted: number;
    stepsSucceeded: number;
    stepSuccessRate: number;
    modelCalls: number;
    modelCallsPerTask: number;
    simulatedDeviceMs: number;
    wallClockMs: number;
  };
  /**
   * DISPATCHED attempts only, per harness intent.
   *
   * ⛔ IT USED TO BUCKET BY MAPPED INTENT NAME REGARDLESS OF OUTCOME, so the
   * consequential-action halt — which stops BEFORE anything is dispatched — was
   * counted as a failed click, and the headline "no tap ever lands" was inflated
   * by a safety gate working exactly as designed. Steps that never reached the
   * device are counted in {@link EvalReport.stepsNeverDispatched} instead.
   */
  byHarnessIntent: Record<string, { dispatched: number; succeeded: number }>;
  /** Steps that never reached the device, by why. A halt here is a gate doing
   *  its job; a mapping refusal is a planner/validator finding. Merging the two
   *  into a click-failure tally is how a safety gate starts looking like a bug. */
  stepsNeverDispatched: {
    halted_for_confirmation: number;
    refused_at_mapping: number;
    mapped_but_never_sent: number;
  };
  byDeathReason: Record<string, number>;
  controls: Record<EvalControlKind, 'pass' | 'fail' | 'halt' | 'error' | 'absent'>;
  tasks: TaskReport[];
}

function outcomeOfControl(
  controls: TaskReport[],
  kind: EvalControlKind,
): 'pass' | 'fail' | 'halt' | 'error' | 'absent' {
  // ⛔ 'absent' rather than a default outcome. A control that is not in the run
  // has not passed and has not failed, and collapsing that into 'error' reads as
  // "the control ran and broke" — a different fact.
  return controls.find((c) => c.control === kind)?.outcome ?? 'absent';
}

export function aggregate(args: {
  runId: string;
  startedAt: string;
  gitSha: string;
  provenance: EvalProvenance;
  corpus: TaskReport[];
  controls: TaskReport[];
  wallClockMs: number;
}): EvalReport {
  const { corpus } = args;
  const passed = corpus.filter((t) => t.outcome === 'pass').length;
  const failed = corpus.filter((t) => t.outcome === 'fail').length;
  const halted = corpus.filter((t) => t.outcome === 'halt').length;
  const errored = corpus.filter((t) => t.outcome === 'error').length;
  const byHarnessIntent: Record<string, { dispatched: number; succeeded: number }> = {};
  const stepsNeverDispatched = {
    halted_for_confirmation: 0,
    refused_at_mapping: 0,
    mapped_but_never_sent: 0,
  };
  const byDeathReason: Record<string, number> = {};
  let stepsAttempted = 0;
  let stepsSucceeded = 0;
  for (const task of corpus) {
    for (const step of task.steps) {
      stepsAttempted += 1;
      if (step.outcome === 'success') stepsSucceeded += 1;
      if (step.attempts === 0) {
        // Nothing reached the device, so this is not evidence about any harness
        // intent. Bucket it by WHY instead.
        if (step.outcome === 'confirmation_required') {
          stepsNeverDispatched.halted_for_confirmation += 1;
        } else if (step.outcome === 'not_mapped') {
          stepsNeverDispatched.refused_at_mapping += 1;
        } else {
          stepsNeverDispatched.mapped_but_never_sent += 1;
        }
        continue;
      }
      const key = step.harnessIntentName ?? `unmapped:${step.agentIntentKind}`;
      const bucket = byHarnessIntent[key] ?? { dispatched: 0, succeeded: 0 };
      bucket.dispatched += 1;
      if (step.outcome === 'success') bucket.succeeded += 1;
      byHarnessIntent[key] = bucket;
    }
    const reason = task.diedAt?.reasonClass ?? 'none';
    byDeathReason[reason] = (byDeathReason[reason] ?? 0) + 1;
  }
  const modelCalls = corpus.reduce((s, t) => s + t.modelCalls.decompose + t.modelCalls.answer, 0);
  // Halts are excluded from the denominator: a plan the safety gate stopped was
  // never given the chance to complete, and counting it as a miss would make the
  // gate look like a defect.
  const completionDenominator = corpus.length - halted;
  // The authorship overlap, counted off the run. Corpus only: a control like
  // C-PAGE-DUMP answers with the page, so its pattern match says nothing about
  // whether a rule selected the criterion's line.
  const answering = corpus.filter((t) => t.answerPatternMatched !== null);
  return {
    headline: args.provenance.headline,
    cannotMeasure: args.provenance.cannotMeasure,
    runId: args.runId,
    startedAt: args.startedAt,
    gitSha: args.gitSha,
    provenance: args.provenance,
    plannerMode: args.provenance.plannerMode,
    totals: {
      tasks: corpus.length,
      passed,
      failed,
      halted,
      errored,
      scriptedPlanCompletionRate:
        completionDenominator === 0 ? 0 : round3(passed / completionDenominator),
      answerRuleSelectsCriterionText: {
        matched: answering.filter((t) => t.answerPatternMatched === true).length,
        of: answering.length,
      },
      matchedExpectation: corpus.filter((t) => t.matchedExpectation).length,
      stepsAttempted,
      stepsSucceeded,
      stepSuccessRate: stepsAttempted === 0 ? 0 : round3(stepsSucceeded / stepsAttempted),
      modelCalls,
      modelCallsPerTask: corpus.length === 0 ? 0 : round3(modelCalls / corpus.length),
      simulatedDeviceMs: corpus.reduce((s, t) => s + t.simulatedDeviceMs, 0),
      wallClockMs: args.wallClockMs,
    },
    byHarnessIntent,
    stepsNeverDispatched,
    byDeathReason,
    controls: {
      positive: outcomeOfControl(args.controls, 'positive'),
      negative: outcomeOfControl(args.controls, 'negative'),
      negative_scored: outcomeOfControl(args.controls, 'negative_scored'),
      sighted: outcomeOfControl(args.controls, 'sighted'),
      page_dump: outcomeOfControl(args.controls, 'page_dump'),
      page_dump_two_line: outcomeOfControl(args.controls, 'page_dump_two_line'),
    },
    tasks: [...corpus, ...args.controls],
  };
}

/**
 * What every control must read for the run's numbers to mean anything.
 *
 * ⛔ THE REASON IS PART OF THE EXPECTATION, NOT DECORATION. This was an
 * outcome-only map, so a control that failed for a completely different reason
 * than the one it controls for still rendered as healthy in the banner — and
 * that is not hypothetical: C-NEG's death moved from
 * `element_never_appeared_in_retry_budget` to `element_click_intercepted` (a
 * page with NO elements reporting an intercepted click) and the run-level
 * control line stayed green, because "it still failed" was the whole test. A
 * negative control that fails for the wrong reason is not controlling for
 * anything.
 *
 * A reason here is a pin like any other: if it moves for a good reason, it is
 * updated deliberately, in the same act as the baseline entry it travels with.
 */
export const CONTROLS_EXPECTED: Record<
  EvalControlKind,
  { outcome: 'pass' | 'fail'; reasonClass: DeathReasonClass | 'none' }
> = {
  positive: { outcome: 'pass', reasonClass: 'none' },
  negative: { outcome: 'fail', reasonClass: 'element_never_appeared_in_retry_budget' },
  negative_scored: { outcome: 'fail', reasonClass: 'answer_not_grounded' },
  sighted: { outcome: 'pass', reasonClass: 'none' },
  // The page-dump controls answer with the whole page. The wanted text IS in
  // there, so they pass the containment test and must still FAIL on the
  // extraction bound. If either ever passes, the answer criterion is unbounded
  // again and every answer-shaped number in the run is quotable by an extractor
  // that returns the page.
  page_dump: { outcome: 'fail', reasonClass: 'answer_was_not_an_extraction' },
  // ⛔ THE SAME BOUND ON THE BRANCH WHERE IT IS WEAKEST. The four-line dump is
  // refused by three separate readings; on a TWO-line observation the
  // character-share reading collapses into the line reading, and six of this
  // corpus's answering tasks observe two or three lines. Controlling only the
  // strong branch is how a bound gets retrodicted over the one input it was
  // written for.
  page_dump_two_line: { outcome: 'fail', reasonClass: 'answer_was_not_an_extraction' },
};

/** Controls that did not read as they must. Empty is the only healthy value. */
export function misbehavingControls(report: EvalReport): string[] {
  const out: string[] = [];
  for (const [kind, expected] of Object.entries(CONTROLS_EXPECTED)) {
    const actual = report.controls[kind as EvalControlKind];
    if (actual !== expected.outcome) {
      out.push(`${kind}: must be ${expected.outcome}, was ${actual}`);
      continue;
    }
    // Same outcome, different cause. Reported separately so the message names
    // which of the two facts moved.
    const task = report.tasks.find((t) => t.control === kind);
    const reason = task?.diedAt?.reasonClass ?? 'none';
    if (task !== undefined && reason !== expected.reasonClass) {
      out.push(
        `${kind}: ${expected.outcome} as required, but for the WRONG REASON — expected ${expected.reasonClass}, got ${reason}. It is no longer controlling for what it was written to control for`,
      );
    }
  }
  return out;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
