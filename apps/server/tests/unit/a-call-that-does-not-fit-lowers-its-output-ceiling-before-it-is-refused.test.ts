// The fit ladder (§4.5, M4): a model call that will not fit what its task has
// left is made smaller before it is refused, and it is made smaller in a fixed
// order.
//
// The order is the answer, not an implementation detail. A call refused at once
// costs the customer their turn; a call admitted over the task's room would let
// one turn spend another's credit. So the ladder gives up the cheapest thing
// first: the unused tail of the reply, then the oldest history, and only then
// the call itself.
//
// ⛔ THE RUNG THAT IS NOT HERE IS `count_tokens` (M4). The provider documents
// that call's result as an estimate, and the owner's rule is an exact count or
// an upper bound — never an estimate. Rung 3 takes its place, and these arms
// prove it does the job the missing rung was there for: a 288 KB CJK history,
// which no reservation could ever cover, is trimmed to something that fits
// rather than refused outright.
//
// ⛔ EVERY ADMITTING RUNG'S BOUND FITS THE ROOM IT WAS GIVEN. That is the one
// property the database re-checks in the admission statement, so an arm that
// only asserted "rung 2 was chosen" would prove nothing about money.

import { describe, expect, it } from 'vitest';
import { CREDIT_RATE_CARD_V1, type CreditRates } from '@driftstack/api-types';
import {
  CALL_OUTPUT_CEILING,
  CALL_OUTPUT_FLOOR,
  admittedBound,
  fitCall,
  type CallFitDecision,
} from '../../src/services/credit-call-fit.js';

/** The launch card's Sonnet 5 row: input 400, output 2,000, 1-hour write 800. */
const RATES: CreditRates = CREDIT_RATE_CARD_V1.models['claude-sonnet-5'];

/** A small body: 1,000 bytes cached for an hour, 500 uncached. */
const SMALL = { oneHourRegionBytes: 1_000, fiveMinuteRegionBytes: 0, uncachedRegionBytes: 500 };

/** What SMALL's input half costs: 1,000×800 + 500×400 + 2,048 framing × 800. */
const SMALL_INPUT_MICRO = 1_000 * 800 + 500 * 400 + 2_048 * 800;
/** What SMALL costs at a plan call's full ceiling. */
const SMALL_AT_CEILING = SMALL_INPUT_MICRO + 8_192 * 2_000;

function plan(roomMicro: number, historyBytes = 0, regions = SMALL): CallFitDecision {
  return fitCall({ purpose: 'plan', roomMicro, regions, rates: RATES, historyBytes });
}

describe('a call that does not fit lowers its output ceiling before it is refused', () => {
  it('CRITICAL the arithmetic these arms are written against is the card the database seeds, not a number retyped here — a rate that drifted would make every expectation below agree with itself and with nothing else', () => {
    expect(RATES.inputMicroPerToken).toBe(400);
    expect(RATES.outputMicroPerToken).toBe(2_000);
    expect(RATES.cacheWrite1hMicroPerToken).toBe(800);
    expect(CALL_OUTPUT_CEILING).toEqual({ plan: 8_192, answer: 4_096 });
    expect(CALL_OUTPUT_FLOOR).toEqual({ plan: 1_024, answer: 512 });
  });

  it('CRITICAL rung 1: a call that fits at the full ceiling is admitted at the full ceiling, and its bound is the one the admission statement will commit', () => {
    const decision = plan(60_000_000);
    expect(decision.rung).toBe('ceiling');
    if (decision.rung !== 'ceiling') throw new Error('unreachable');
    expect(decision.maxOutputTokens).toBe(8_192);
    expect(decision.bound.boundMicro).toBe(SMALL_AT_CEILING);
    expect(decision.bound.inputBoundMicro).toBe(SMALL_INPUT_MICRO);
    // The bound counts one token per BYTE of body, plus the framing allowance.
    expect(decision.bound.inputBoundTokens).toBe(1_000 + 500 + 2_048);
  });

  it('CRITICAL the ceiling rung is inclusive: a bound equal to the room fits. An exclusive comparison here would refuse the last call of every task that spent its reservation exactly, which is the common case and not an edge one', () => {
    expect(plan(SMALL_AT_CEILING).rung).toBe('ceiling');
    expect(plan(SMALL_AT_CEILING - 1).rung).toBe('lower_output');
  });

  it('CRITICAL rung 2: one microcredit short of the ceiling lowers max_tokens by one token, and the bound that comes back FITS — the ladder never hands up a bound the admission would refuse', () => {
    const room = SMALL_AT_CEILING - 1;
    const decision = plan(room);
    expect(decision.rung).toBe('lower_output');
    if (decision.rung !== 'lower_output') throw new Error('unreachable');
    expect(decision.maxOutputTokens).toBe(8_191);
    expect(decision.bound.boundMicro).toBe(SMALL_INPUT_MICRO + 8_191 * 2_000);
    expect(decision.bound.boundMicro).toBeLessThanOrEqual(room);
  });

  it('CRITICAL rung 2 stops at the floor: a room that would buy only 1,023 output tokens does NOT admit a call at 1,023. A reply cut off mid-sentence is a turn the customer paid for and did not get, so the ladder moves on instead', () => {
    // room − input = 1,023 × 2,000 exactly, so the largest ceiling that fits is 1,023.
    const room = SMALL_INPUT_MICRO + 1_023 * 2_000;
    expect(plan(room).rung).not.toBe('lower_output');
    expect(plan(room + 2_000).rung).toBe('lower_output');
    const atFloor = plan(room + 2_000);
    if (atFloor.rung !== 'lower_output') throw new Error('unreachable');
    expect(atFloor.maxOutputTokens).toBe(1_024);
  });

  it('CRITICAL rung 3 asks for a BYTE budget, and asks for enough: the budget it returns, rebuilt and asked again, is admitted rather than sent round the ladder a second time', () => {
    // 288 KB of history — 96,000 characters of CJK — which no reservation could
    // ever cover at any output ceiling. This is the case M4 says the byte bound
    // fails without a third rung.
    const big = {
      oneHourRegionBytes: 0,
      fiveMinuteRegionBytes: 0,
      uncachedRegionBytes: 288_000,
    };
    const room = 60_000_000;
    const first = plan(room, 288_000, big);
    expect(first.rung).toBe('trim_history');
    if (first.rung !== 'trim_history') throw new Error('unreachable');
    expect(first.dropBytes).toBe(147_216);
    expect(first.historyByteBudget).toBe(288_000 - 147_216);

    // The caller rebuilds to exactly the budget it was given and asks again.
    const rebuilt = plan(room, first.historyByteBudget, {
      ...big,
      uncachedRegionBytes: first.historyByteBudget,
    });
    expect(rebuilt.rung, 'the trim asked for too few bytes and the ladder looped').toBe(
      'lower_output',
    );
    if (rebuilt.rung !== 'lower_output') throw new Error('unreachable');
    expect(rebuilt.maxOutputTokens).toBe(1_024);
    expect(rebuilt.bound.boundMicro).toBeLessThanOrEqual(room);
  });

  it('CRITICAL rung 3 always shrinks, so the ladder terminates. A trim that returned the budget it was given would be an infinite rebuild loop in the turn runtime, and nothing in the loop itself would ever error', () => {
    let historyBytes = 288_000;
    let rounds = 0;
    let decision = plan(60_000_000, historyBytes, {
      oneHourRegionBytes: 0,
      fiveMinuteRegionBytes: 0,
      uncachedRegionBytes: historyBytes,
    });
    while (decision.rung === 'trim_history') {
      expect(decision.historyByteBudget, 'the budget did not shrink').toBeLessThan(historyBytes);
      historyBytes = decision.historyByteBudget;
      rounds += 1;
      expect(rounds, 'the ladder did not settle').toBeLessThan(10);
      decision = plan(60_000_000, historyBytes, {
        oneHourRegionBytes: 0,
        fiveMinuteRegionBytes: 0,
        uncachedRegionBytes: historyBytes,
      });
    }
    expect(rounds).toBe(1);
  });

  it('CRITICAL an ANSWER call never reaches the trim rung, however much history it is offered: it carries no history window, and trimming the question to afford the answer would answer a question nobody asked', () => {
    // One microcredit under an answer call's own floor (512 output tokens), and
    // well under a plan call's (1,024). The plan trims; the answer refuses.
    const room = SMALL_INPUT_MICRO + 512 * 2_000 - 1;
    const answer = fitCall({
      purpose: 'answer',
      roomMicro: room,
      regions: SMALL,
      rates: RATES,
      historyBytes: 200_000,
    });
    const asPlan = plan(room, 200_000);
    expect(asPlan.rung).toBe('trim_history');
    expect(answer.rung).toBe('refuse');
  });

  it('CRITICAL rung 4 refuses at NO charge and says what would have been needed, so the caller can tell "this task is out of credits" from "this request can never run on credits at all"', () => {
    const decision = plan(SMALL_INPUT_MICRO + 1_024 * 2_000 - 1, 0);
    expect(decision.rung).toBe('refuse');
    if (decision.rung !== 'refuse') throw new Error('unreachable');
    expect(decision.neededMicro).toBe(SMALL_INPUT_MICRO + 1_024 * 2_000);
    expect(decision.shortfallMicro).toBe(1);
  });

  it('CRITICAL a body whose input alone outlasts the room is refused even with history to give: the framing allowance cannot be trimmed, so no budget reaches a fit and an endless trim loop is the alternative', () => {
    // Room equal to the floor's output exactly: not one byte of input fits.
    const decision = plan(1_024 * 2_000, 500_000);
    expect(decision.rung).toBe('refuse');
  });

  it('CRITICAL nothing is droppable, nothing is asked for: a plan call with no history reaches rung 4 at the same room where one with history is trimmed', () => {
    const room = 4_686_399;
    expect(plan(room, 0).rung).toBe('refuse');
    expect(plan(room, 500).rung).toBe('trim_history');
  });

  it('CRITICAL the bound handed to the admission is the one the ladder chose, recorded as measured from BYTES — `token_count` is not a basis this system writes (M4), and a call recorded under it would claim an exactness nobody established', () => {
    const admitted = admittedBound(plan(60_000_000));
    expect(admitted).toEqual({
      inputBoundTokens: 3_548,
      inputBoundMicro: SMALL_INPUT_MICRO,
      maxOutputTokens: 8_192,
      boundMicro: SMALL_AT_CEILING,
      basis: 'region_bytes',
    });
    expect(admittedBound(plan(1_024 * 2_000, 0)), 'a refusal must admit nothing').toBeNull();
    expect(admittedBound(plan(4_686_399, 500)), 'a trim must admit nothing').toBeNull();
  });

  it('CRITICAL a room this task cannot have is a fault, not a quietly clamped zero: a non-integer or unsafe room means the caller computed it wrong, and a silent floor would charge against a number nobody chose', () => {
    expect(() => plan(1.5)).toThrow(RangeError);
    expect(() => plan(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
    expect(() =>
      fitCall({
        purpose: 'plan',
        roomMicro: 10,
        regions: SMALL,
        rates: RATES,
        historyBytes: -1,
      }),
    ).toThrow(RangeError);
  });

  it('CRITICAL a rate card whose order is broken is refused rather than priced: "the dearest rate this region can be billed at" is only true while read ≤ input ≤ 5-minute ≤ 1-hour, and a card that broke it would make every bound below an under-count', () => {
    expect(() =>
      fitCall({
        purpose: 'plan',
        roomMicro: 60_000_000,
        regions: SMALL,
        rates: { ...RATES, cacheWrite1hMicroPerToken: 1 },
        historyBytes: 0,
      }),
    ).toThrow(RangeError);
  });

  it('⛔ CRITICAL a call whose REPLY CONTROLS are large is priced in the 1-hour region, not at the plain input rate. The plan text puts `output_config` in R3; the decomposer spreads the reply controls ahead of `system` and the provider renders them inside the cached prefix, so counted the plan’s way the "bound" is an under-count and not a bound at all', () => {
    // The same 40,000 bytes, twice: once counted the way this module requires
    // (rendered ahead of the 1-hour block, so R1), once the way §4.5's R3 row
    // reads. If the second is ever cheaper, the bound has stopped bounding.
    const asWritten = plan(60_000_000, 0, {
      oneHourRegionBytes: 40_000,
      fiveMinuteRegionBytes: 0,
      uncachedRegionBytes: 0,
    });
    const asPlanText = plan(60_000_000, 0, {
      oneHourRegionBytes: 0,
      fiveMinuteRegionBytes: 0,
      uncachedRegionBytes: 40_000,
    });
    if (asWritten.rung === 'trim_history' || asWritten.rung === 'refuse') {
      throw new Error('unreachable');
    }
    if (asPlanText.rung === 'trim_history' || asPlanText.rung === 'refuse') {
      throw new Error('unreachable');
    }
    expect(asWritten.bound.inputBoundMicro).toBe(40_000 * 800 + 2_048 * 800);
    expect(asPlanText.bound.inputBoundMicro).toBe(40_000 * 400 + 2_048 * 800);
    expect(
      asWritten.bound.inputBoundMicro - asPlanText.bound.inputBoundMicro,
      'counting the reply controls at the plain input rate under-counts them by half',
    ).toBe(40_000 * 400);
  });

  it('CRITICAL the framing allowance is priced at the DEAREST rate, because the tokens it stands for — role markers, block boundaries, the tool-use scaffolding — are rendered inside the cached prefix. It is not the JSON envelope: the envelope is bytes, and bytes are already counted', () => {
    const empty = plan(60_000_000, 0, {
      oneHourRegionBytes: 0,
      fiveMinuteRegionBytes: 0,
      uncachedRegionBytes: 0,
    });
    if (empty.rung !== 'ceiling') throw new Error('unreachable');
    expect(empty.bound.inputBoundMicro).toBe(2_048 * 800);
    expect(empty.bound.inputBoundTokens).toBe(2_048);
  });

  it('CRITICAL a card with a FREE OUTPUT rate is refused here rather than three statements later: `credit_model_calls_bound` requires a bound strictly above its input half, so such a card would kill the admission on a constraint instead of answering it', () => {
    expect(() =>
      fitCall({
        purpose: 'plan',
        roomMicro: 60_000_000,
        regions: SMALL,
        rates: { ...RATES, outputMicroPerToken: 0 },
        historyBytes: 0,
      }),
    ).toThrow(RangeError);
  });

  it('CRITICAL a card with a free input rate cannot reach the trim rung silently: dropping bytes from the cheapest region would save nothing, and this module is not told which region the history is in, so it fails loudly instead of asking for a trim that never helps', () => {
    const free = { ...RATES, inputMicroPerToken: 0, cacheReadMicroPerToken: 0 };
    expect(() =>
      fitCall({
        purpose: 'plan',
        roomMicro: 1_024 * 2_000 + 1,
        regions: { oneHourRegionBytes: 10_000, fiveMinuteRegionBytes: 0, uncachedRegionBytes: 0 },
        rates: free,
        historyBytes: 5_000,
      }),
    ).toThrow(RangeError);
  });
});
