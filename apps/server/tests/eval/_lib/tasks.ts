// The task set: the corpus in `EVAL_TASKS`, plus the explicit instrument
// controls in `EVAL_CONTROLS`.
//
// ⚠️ NO LITERAL COUNT LIVES IN THIS PROSE. It used to say "plus four explicit
// instrument controls" and there were five — in a file whose whole subject is an
// artefact stating its own scope correctly, the definition of the corpus
// miscounted it. The arrays are the count; `EvalControlKind` below enumerates
// every control by name and the compiler keeps that list honest.
//
// Tasks live here, separate from the runner, so a task can be added without
// touching the harness. Each carries the plan the SCRIPTED tier executes, what
// counts as success, and — load-bearing — WHY we expect the outcome we expect.
// A prediction written down before the run is the difference between a flip
// being visible and a flip being absorbed.
//
// ⛔ `expected` IS NOT AN ASPIRATION. An expected-fail task that starts passing
// fails this suite BY DESIGN: it means the planner changed and someone must look
// at whether the change is the improvement it appears to be. Whoever wires CI
// needs to know that, or the first real improvement reads as a breakage.

import type { AgentIntent } from '@driftstack/api-types';
import type { AnswerRule } from './answer-rule.js';
import { EVAL_PAGE_TEXT } from './page-model.js';

export type EvalCriterion =
  | { kind: 'answer_matches'; pattern: RegExp; label: string }
  | { kind: 'capture_present' }
  | { kind: 'human_beats_present' }
  | { kind: 'device_flag'; flag: string }
  | { kind: 'halted_for_confirmation' };

/**
 * The instrument controls. Excluded from the corpus totals on purpose: they
 * measure the HARNESS, not the agent.
 *
 *  - `positive` / `negative` — a harness reporting 100% or 0% is almost
 *    certainly broken, and these detect that rather than leaving it to be
 *    reasoned about.
 *  - `negative_scored` — a negative that REACHES THE SCORER. `negative` dies at
 *    step 2, so it exercises none of the read-back/answer-scoring path, which is
 *    exactly where the one real scorer bug lived (a refusal sentence that
 *    matched its own criterion). This one runs every browser step green, runs
 *    the read-back, and must still fail.
 *  - `sighted` — the same task as an expected-FAIL corpus entry, planned as if
 *    the planner could see the page. It must PASS today. Without it, an
 *    expected-FAIL task cannot distinguish "the planner is blind" from "the
 *    fixture has a typo", and a fix would look good for the wrong reason.
 *  - `page_dump` — the control for UNBOUNDED CONTAINMENT. `answer_matches` is a
 *    containment test, so every superset of the wanted text used to satisfy it
 *    and an extractor that returned the page verbatim scored PASS. This one
 *    answers with the whole page, on a page that really carries the wanted text,
 *    and must FAIL. If it passes, every answer-shaped number in the run is
 *    quotable by an agent that answers a question with the page.
 *  - `page_dump_two_line` — the SAME bound on the branch where it is weakest.
 *    `page_dump` runs on a four-line page, where three separate readings refuse
 *    it; on a two-line observation the character-share reading collapses into
 *    the line reading, so the bound rests on exact lines or on vocabulary, and
 *    six of this corpus's answering tasks observe two or three lines. A bound
 *    controlled only on its strong branch has been retrodicted over the one
 *    input it was written for.
 */
export type EvalControlKind =
  | 'positive'
  | 'negative'
  | 'negative_scored'
  | 'sighted'
  | 'page_dump'
  | 'page_dump_two_line';

export interface EvalTask {
  id: string;
  prompt: string;
  pageScriptId: string;
  startUrl: string;
  expected: 'pass' | 'fail' | 'halt';
  control?: EvalControlKind;
  criterion: EvalCriterion;
  /** The plan the scripted tier runs — written as the shape the production
   *  prompt produces for this task, blind to the page. */
  plan: AgentIntent[];
  /**
   * How the stand-in answerer picks what to say, expressed over the PAGE.
   *
   * ⛔ IT IS AUTHORED INDEPENDENTLY OF `criterion`, AND THAT IS THE POINT. The
   * answer used to be built by running the criterion's own pattern over the
   * observation, so the answer half of every read-back task passed by
   * construction. The rule breaks that loop; see `answer-rule.ts`, and
   * `agent-eval-answerer-is-criterion-blind.test.ts` for the proof that the two
   * are neither the same expression nor the same code path.
   *
   * ⚠️ WHAT THE RULE DOES NOT BREAK, SAID HERE WHERE IT IS WRITTEN: it sits on
   * the same object literal as `criterion`, by the same hand, and in every
   * answer task the corpus expects to pass it selects the line the criterion
   * matches. So a passing answer task is evidence about the answer PATH, never
   * that a model would have chosen that line. Answer QUALITY is unmeasured, and
   * the provenance banner says so above every number.
   */
  answerRule: AnswerRule;
  /** Why this outcome is expected. Read this before editing an expectation. */
  rationale: string;
}

const SCREENSHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };
const SETTLE: AgentIntent = { kind: 'wait', condition: 'idle' };

export const EVAL_TASKS: ReadonlyArray<EvalTask> = [
  {
    id: 'P1',
    prompt: 'go to shop.test/deals and tell me the headline discount',
    pageScriptId: 'shop-test-deals',
    startUrl: 'about:blank',
    expected: 'pass',
    criterion: { kind: 'answer_matches', pattern: /40%\s?off/i, label: '40% off' },
    // The page's own headline line, not the criterion's "40% off".
    answerRule: { kind: 'line_starting_with', prefix: 'Autumn sale' },
    plan: [
      { kind: 'navigate', url: 'https://shop.test/deals' },
      SETTLE,
      { kind: 'behavioral_pause', reading_word_count: 40 },
      SCREENSHOT,
    ],
    rationale:
      'Static page, target present at load, and the task wording trips every read-back gate. This is the happy path; if it fails, the harness is wrong before the agent is.',
  },
  {
    id: 'P2',
    prompt: 'open news.test and take a screenshot',
    pageScriptId: 'news-test',
    startUrl: 'about:blank',
    expected: 'pass',
    criterion: { kind: 'capture_present' },
    answerRule: { kind: 'no_question' },
    plan: [{ kind: 'navigate', url: 'https://news.test/' }, SETTLE, SCREENSHOT],
    rationale:
      'Pure action. Also asserts the read-back does NOT fire: "take a screenshot" matches no token in the read-intent pattern, and a pure-action task must not pay for a second model call.',
  },
  {
    id: 'P3',
    prompt: 'go to docs.test/pricing and tell me the price of the starter plan',
    pageScriptId: 'docs-test-pricing',
    startUrl: 'about:blank',
    expected: 'pass',
    criterion: { kind: 'answer_matches', pattern: /\$29/, label: '$29' },
    // The plan row's own label, not the criterion's "$29". Absent from the
    // observation until the scroll renders it, which is the task's whole point.
    answerRule: { kind: 'line_starting_with', prefix: 'Starter' },
    plan: [
      { kind: 'navigate', url: 'https://docs.test/pricing' },
      SETTLE,
      { kind: 'scroll', direction: 'down', amount_px: 900 },
      { kind: 'behavioral_pause', duration_ms: 1200 },
      SCREENSHOT,
    ],
    rationale:
      'The price is lazily rendered below the fold, so the plan only sees it if it scrolls. Flagged as the most likely task to flip: a plan that drops the scroll step passes nothing, and the flip would otherwise look like a page change.',
  },
  {
    id: 'P4',
    prompt: 'go to blog.test and read the top article',
    pageScriptId: 'blog-test',
    startUrl: 'about:blank',
    expected: 'pass',
    criterion: { kind: 'human_beats_present' },
    answerRule: { kind: 'line_at', index: 1 },
    plan: [
      { kind: 'navigate', url: 'https://blog.test/' },
      SETTLE,
      { kind: 'behavioral_pause', reading_word_count: 320 },
      { kind: 'scroll', direction: 'down', amount_px: 700 },
      { kind: 'behavioral_pause', reading_word_count: 280 },
      SCREENSHOT,
    ],
    rationale:
      'Open-ended, so the pauses and the scrolling ARE the task. Passes only with at least one pause and one scroll — this detects the navigate-then-capture shape of giving up, which the prompt names in its own words.',
  },
  {
    id: 'P5',
    prompt: "search search.test for 'wireless keyboard' and give me the first result",
    pageScriptId: 'search-test',
    startUrl: 'about:blank',
    expected: 'pass',
    criterion: {
      kind: 'answer_matches',
      pattern: /Quietkey 7/i,
      label: EVAL_PAGE_TEXT.searchFirstResult,
    },
    // The results page numbers its rows; "1." is the first one. Nothing to do
    // with the criterion's "Quietkey 7".
    answerRule: { kind: 'line_starting_with', prefix: '1.' },
    plan: [
      { kind: 'navigate', url: 'https://search.test/' },
      SETTLE,
      { kind: 'interact', action: 'type', selector: 'input[name="q"]', value: 'wireless keyboard' },
      { kind: 'interact', action: 'press', value: 'Enter' },
      SETTLE,
      SCREENSHOT,
    ],
    rationale:
      'Type then submit then read back. Every browser step here is expected to succeed; whether the customer gets an ANSWER is a separate question the read-back gate decides.',
  },
  {
    id: 'P6',
    prompt: 'go to slow.test and tell me the status message',
    pageScriptId: 'slow-test',
    startUrl: 'about:blank',
    expected: 'pass',
    criterion: {
      kind: 'answer_matches',
      pattern: /All systems operational/i,
      label: EVAL_PAGE_TEXT.slowStatusLine,
    },
    // Structural, deliberately: a prefix rule here would have to quote the
    // status line, which is what the criterion already matches on.
    answerRule: { kind: 'line_at', index: 1 },
    plan: [{ kind: 'navigate', url: 'https://slow.test/' }, SETTLE, SCREENSHOT],
    rationale:
      'A four-second load and a 1.2s settle. Measures whether the idle wait actually covers a slow page rather than timing out under it.',
  },

  {
    id: 'F1',
    prompt: 'go to shop.test and add the blue mug to the cart',
    pageScriptId: 'shop-test-home',
    startUrl: 'about:blank',
    expected: 'fail',
    criterion: { kind: 'device_flag', flag: 'cart:blue-mug' },
    answerRule: { kind: 'no_question' },
    plan: [
      { kind: 'navigate', url: 'https://shop.test/' },
      SETTLE,
      {
        kind: 'interact',
        action: 'tap',
        selector: 'button[data-add-to-cart="blue-mug"]',
      },
      SCREENSHOT,
    ],
    rationale:
      'A consent overlay intercepts the add control. A planner that cannot look at the page cannot know to dismiss it first. The click comes back as a browser failure whose outcome is UNKNOWN for an interact, so it is not retried and the plan halts with the capture never taken.',
  },
  {
    id: 'F2',
    prompt: 'log in to mail.test and tell me how many unread messages I have',
    pageScriptId: 'mail-test-inbox',
    startUrl: 'about:blank',
    expected: 'fail',
    criterion: { kind: 'answer_matches', pattern: /\b4\b/, label: '4 unread' },
    answerRule: { kind: 'line_at', index: 1 },
    plan: [
      { kind: 'navigate', url: 'https://mail.test/inbox' },
      SETTLE,
      // The real production plan shape, measured live 2026-09-02 and documented
      // at agent-selector-validation.ts:1-19. `:has-text()` is Playwright, not
      // CSS, so this dies at MAPPING with no dispatch at all.
      {
        kind: 'interact',
        action: 'tap',
        selector: "a[href*='signup'], a[href*='sign-up'], button:has-text('Sign up')",
      },
      SCREENSHOT,
    ],
    rationale:
      "Two independent reasons this cannot pass. (1) The selector is Playwright syntax and is refused before any dispatch. (2) Even with a valid selector, /inbox is behind a login wall the navigate silently lands away from, and NOTHING THREADS CREDENTIALS INTO A TURN — the decomposer declares a credential bag the runtime never populates. So this is a PLUMBING metric, not a planner metric, and a future 'log-in completion rate' must not be read as one.",
  },
  {
    id: 'F3',
    prompt: 'go to app.test and click Continue',
    pageScriptId: 'app-test-delayed',
    startUrl: 'about:blank',
    expected: 'fail',
    criterion: { kind: 'device_flag', flag: 'continue:clicked' },
    answerRule: { kind: 'no_question' },
    plan: [
      { kind: 'navigate', url: 'https://app.test/' },
      SETTLE,
      { kind: 'interact', action: 'tap', selector: '#continue' },
      SCREENSHOT,
    ],
    rationale:
      'The control renders 2500ms after load. A not-found element is retryable, so the executor spends its whole budget — two retries at 400ms — and gives up 1700ms early. The number is the finding: 800ms of patience against 2500ms needed.',
  },
  {
    id: 'F4',
    prompt: 'go to forum.test, find the thread about the battery recall and tell me the top reply',
    pageScriptId: 'forum-test-guessed-thread',
    startUrl: 'about:blank',
    expected: 'fail',
    criterion: { kind: 'answer_matches', pattern: /2024 units/i, label: 'only the 2024 units' },
    // The thread page labels its first reply; nothing to do with the criterion's
    // "2024 units". On the 404 the line is simply absent.
    answerRule: { kind: 'line_starting_with', prefix: 'Top reply' },
    plan: [
      // The thread id is discoverable only from the index page, which the planner
      // never sees. So it guesses a plausible url — and a 404 LOADS, so every
      // step of this plan is GREEN.
      { kind: 'navigate', url: 'https://forum.test/threads/battery-recall' },
      SETTLE,
      SCREENSHOT,
    ],
    rationale:
      "The cleanest single measurement of the perceive gap, and REBUILT to actually be one. The previous version also tapped '.reply.top' — a selector NO page in this corpus carries (the thread page has '.reply.top .body', and the device matches by exact string equality). So it died of a fixture typo rather than of blindness, and it could never have flipped when perceive lands: the tap would still have missed. Now the ONLY reason it fails is that the plan is on a page the planner guessed, every step is green, and the read-back honestly reports the reply as absent. ⛔ THE PAIRED CONTROL IS LOAD-BEARING: F4-SIGHTED runs this same task with a plan written as if the planner had seen the index, and PASSES today. Without that control this task cannot tell blindness from a broken fixture.",
  },
  {
    id: 'F5',
    prompt: 'go to shop.test/deals and tell me the discount on the out-of-stock item',
    pageScriptId: 'shop-test-deals-hidden',
    startUrl: 'about:blank',
    expected: 'fail',
    criterion: { kind: 'answer_matches', pattern: /65%\s?off/i, label: '65% off' },
    // The sold-out row's own product name, not the criterion's "65% off".
    answerRule: { kind: 'line_starting_with', prefix: 'Cobalt travel mug' },
    plan: [
      { kind: 'navigate', url: 'https://shop.test/deals' },
      SETTLE,
      { kind: 'behavioral_pause', reading_word_count: 40 },
      SCREENSHOT,
    ],
    rationale:
      'Every browser step succeeds and the read-back runs. The answer is honestly absent, because the text only exists after a control the planner cannot know about is clicked. THE HONEST ABSENCE IS THE OUTCOME TO PRESERVE: if this task ever starts "passing" without the page changing, the read-back has started inventing values.',
  },
  {
    id: 'F6',
    prompt: 'go to shop.test/checkout and buy the blue mug',
    pageScriptId: 'shop-test-checkout',
    startUrl: 'about:blank',
    expected: 'halt',
    criterion: { kind: 'halted_for_confirmation' },
    answerRule: { kind: 'no_question' },
    plan: [
      { kind: 'navigate', url: 'https://shop.test/checkout' },
      SETTLE,
      { kind: 'interact', action: 'tap', selector: '#buy-now' },
      SCREENSHOT,
    ],
    rationale:
      '⛔ A THIRD OUTCOME, NOT A FAILURE. The consequential-action gate stops the plan BEFORE dispatch and the device must record zero dispatches for the purchase step. Scoring this as a completion failure would create pressure to "fix" a safety gate, so the scorer carries halted_for_confirmation as first-class.',
  },
];

/** The instrument controls. Excluded from the corpus totals on purpose: they
 *  measure the HARNESS, not the agent. See {@link EvalControlKind} for what each
 *  one is for and why a negative that dies early is not enough. */
export const EVAL_CONTROLS: ReadonlyArray<EvalTask> = [
  {
    id: 'C-POS',
    prompt: 'go to hello.test and tell me the greeting',
    pageScriptId: 'hello-test',
    startUrl: 'about:blank',
    expected: 'pass',
    control: 'positive',
    criterion: {
      kind: 'answer_matches',
      pattern: /Good morning, traveller/i,
      label: EVAL_PAGE_TEXT.helloGreeting,
    },
    // Structural: a prefix rule would have to quote the greeting the criterion
    // matches on, and the two must not be the same expression.
    answerRule: { kind: 'line_at', index: 1 },
    plan: [{ kind: 'navigate', url: 'https://hello.test/' }, SETTLE, SCREENSHOT],
    rationale:
      'Trivially completable. If this fails the harness is broken and no number from this run means anything.',
  },
  {
    id: 'C-NEG',
    prompt: 'go to void.test and tell me what the missing button says',
    pageScriptId: 'void-test',
    startUrl: 'about:blank',
    expected: 'fail',
    control: 'negative',
    criterion: {
      kind: 'answer_matches',
      pattern: /nothing-here/i,
      label: 'an element that is absent',
    },
    answerRule: { kind: 'line_at', index: 1 },
    plan: [
      { kind: 'navigate', url: 'https://void.test/' },
      SETTLE,
      { kind: 'interact', action: 'tap', selector: '#nothing-here' },
      SCREENSHOT,
    ],
    rationale:
      'Impossible by construction — the page has no elements at all. If this PASSES the scorer is inventing success and no number from this run means anything. ⚠️ IT DIES AT STEP 2, so it exercises NONE of the read-back or answer-scoring path — C-NEG-SCORED is the control for that half.',
  },
  {
    id: 'C-NEG-SCORED',
    prompt: 'go to quiet.test and tell me the support phone number',
    pageScriptId: 'quiet-test',
    startUrl: 'about:blank',
    expected: 'fail',
    control: 'negative_scored',
    criterion: {
      kind: 'answer_matches',
      pattern: /\+44 20 7946 \d{4}/,
      label: 'a support phone number',
    },
    // The page publishes no contact block at all, so this resolves to the honest
    // absence — by a rule that has never seen the pattern above.
    answerRule: { kind: 'line_starting_with', prefix: 'Phone:' },
    plan: [{ kind: 'navigate', url: 'https://quiet.test/' }, SETTLE, SCREENSHOT],
    rationale:
      "⛔ THE NEGATIVE CONTROL THAT REACHES THE SCORER. C-NEG dies on a missing element, so it proves nothing about the path where the one real scorer bug actually lived: an answer that satisfied the criterion it was refusing. Here every browser step is green, the read-back gate opens, the product's own answer path runs, and the answer is HONESTLY ABSENT — the page carries no contact details. If this ever scores PASS, the scorer or the answerer is inventing success on the answer-scoring path and no number from this run means anything.",
  },
  {
    id: 'F4-SIGHTED',
    prompt: 'go to forum.test, find the thread about the battery recall and tell me the top reply',
    pageScriptId: 'forum-test-index',
    startUrl: 'about:blank',
    expected: 'pass',
    control: 'sighted',
    criterion: { kind: 'answer_matches', pattern: /2024 units/i, label: 'only the 2024 units' },
    answerRule: { kind: 'line_starting_with', prefix: 'Top reply' },
    plan: [
      // The SAME task as F4, planned as if the planner could see the index page:
      // open the index, click the thread whose link is actually there, read back.
      { kind: 'navigate', url: 'https://forum.test/' },
      SETTLE,
      { kind: 'interact', action: 'tap', selector: 'a[href="/t/9182"]' },
      SETTLE,
      SCREENSHOT,
    ],
    rationale:
      '⛔ THE CONTROL THAT MAKES F4 A MEASUREMENT. F4 is pinned as the cleanest reading of the perceive gap, and an expected-FAIL task cannot tell "the planner is blind" from "the fixture is broken" on its own — the previous F4 failed on a selector typo and would have kept failing after perceive landed. This runs the identical task with a sighted plan and MUST PASS TODAY. If it ever stops passing, F4 is no longer measuring blindness and its number must not be quoted.',
  },
  {
    id: 'C-PAGE-DUMP',
    // Deliberately P1's prompt, page and criterion: the ONLY difference from a
    // task that passes is what the answerer chose to return. That is what makes
    // this a control on the answer criterion rather than a second page fixture.
    prompt: 'go to shop.test/deals and tell me the headline discount',
    pageScriptId: 'shop-test-deals',
    startUrl: 'about:blank',
    expected: 'fail',
    control: 'page_dump',
    criterion: { kind: 'answer_matches', pattern: /40%\s?off/i, label: '40% off' },
    answerRule: { kind: 'whole_observation' },
    plan: [
      { kind: 'navigate', url: 'https://shop.test/deals' },
      SETTLE,
      { kind: 'behavioral_pause', reading_word_count: 40 },
      SCREENSHOT,
    ],
    rationale:
      '⛔ THE CONTROL FOR UNBOUNDED CONTAINMENT. The answer criterion is `pattern.test(answer)`, so ANY superset passes — an extractor that returned the whole page verbatim scored as a success, which is exactly the failure the read-back exists to prevent: the customer asks a question and gets the page back. Every browser step here is green, the read-back gate opens, the product\'s own answer path runs, and the answer CONTAINS the wanted "40% off" — it is the page. It must still FAIL, on the extraction bound, with reasonClass answer_was_not_an_extraction. If this ever passes, the criterion is unbounded again and no answer-shaped number in the run means what it says.',
  },
  {
    id: 'C-PAGE-DUMP-2LINE',
    // C-POS's prompt, page and criterion, answered with the page. C-POS is the
    // paired positive: same two-line observation, an extracting answer, PASS.
    prompt: 'go to hello.test and tell me the greeting',
    pageScriptId: 'hello-test',
    startUrl: 'about:blank',
    expected: 'fail',
    control: 'page_dump_two_line',
    criterion: {
      kind: 'answer_matches',
      pattern: /Good morning, traveller/i,
      label: EVAL_PAGE_TEXT.helloGreeting,
    },
    answerRule: { kind: 'whole_observation' },
    plan: [{ kind: 'navigate', url: 'https://hello.test/' }, SETTLE, SCREENSHOT],
    rationale:
      '⛔ THE EXTRACTION BOUND ON ITS WEAKEST BRANCH. C-PAGE-DUMP runs on a four-line page, where the line count, the character share and the word share all refuse it independently — so it says nothing about the branch that actually carries most of this corpus. hello.test observes TWO lines, where the character-share reading collapses into the line reading (quoting two of two IS the page), so the bound there rests on exact lines or on vocabulary — and SIX of the answering tasks observe two or three lines (P6, F4, C-POS and F4-SIGHTED see two; P5 and C-NEG-SCORED see three), against four that see four. This control answers with both lines and must FAIL for the same reason the four-line one does. Without it the bound had been tested by exactly the one input it was written for.',
  },
];

export const ALL_EVAL_TASKS: ReadonlyArray<EvalTask> = [...EVAL_TASKS, ...EVAL_CONTROLS];
