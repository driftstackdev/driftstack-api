// R9 — the two provokable constants, and what replaced them.
//
// THE FINDING. Every gap the executor chose was a constant. A retryable failure
// re-fired the identical action at exactly +400 ms, twice; the first intent of a
// new session re-fired at exactly +1500 ms, eight times. A site that can induce
// one cheap failure — a single 500 on a resource a step depends on — reads both
// numbers off two timestamps in under a second, with no page instrumentation of
// any kind. And they were the same numbers in every session of every customer,
// so they also linked two sessions that shared nothing else.
//
// ⛔ WHAT IS BEING ASSERTED, AND WHAT IS NOT. The discriminating quantity is
// whether two spacings are EXACTLY EQUAL and whether two sessions produce the
// same sequence — both of which a decorrelated per-attempt draw destroys. A
// drawn gap is still a machine's gap, the distribution is narrow and it is ours;
// nothing here is evidence that anything is hidden, and no arm below claims it.
//
// ⛔ EVERY ARM HAS ITS MUTATION HALF IN THE SAME FILE. "These two gaps differ"
// passes trivially against an executor that sleeps for random nonsense, so each
// arm that asserts a difference also asserts the BAND, and the arm that asserts
// the band runs against a source fixed at its ends.

import { describe, expect, it } from 'vitest';
import {
  ControlPlaneAgentExecutor,
  DRAWN_GAP_MAX_FACTOR,
  DRAWN_GAP_MIN_FACTOR,
  drawGapMs,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import {
  parseIntentResult,
  type ParsedIntentResult,
} from '../../src/services/harness-control-codec.js';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';
import {
  LONGEST_DISPATCH_DEADLINE_MS,
  LONGEST_TURN_THE_CONSTANTS_PERMIT_MS,
} from '../../src/services/agent-turn-bounds.js';
import { AGENT_TURN_CLAIM_TTL_SECONDS } from '../../src/services/agent-turn-stop-channel.js';

const RETRY_DELAY_MS = 400;
const ESTABLISH_DELAY_MS = 1_500;

/** A device that fails every dispatch with `code`, so the retry budget is spent
 *  in full and every gap is observable. */
function alwaysFails(code: 'intent_webdriver_failed' | 'intent_session_not_established') {
  return {
    dispatch: (d: IntentDispatch): Promise<ParsedIntentResult> =>
      Promise.resolve(
        parseIntentResult(
          {
            type: 'intentResult',
            sessionId: d.sessionId,
            intentId: d.intentId,
            success: false,
            durationMs: 1,
            errorCode: code,
          },
          d.intentName,
        ),
      ),
  } satisfies IntentDispatcher;
}

/** Run one plan and return every gap the executor slept, in order. */
async function gapsFor(opts: {
  sessionId: string;
  code: 'intent_webdriver_failed' | 'intent_session_not_established';
  makeRandom?: (sessionId: string) => () => number;
}): Promise<number[]> {
  const slept: number[] = [];
  let n = 0;
  const exec = new ControlPlaneAgentExecutor(
    alwaysFails(opts.code),
    () => `int_${String((n += 1))}`,
    {
      retryDelayMs: RETRY_DELAY_MS,
      sessionEstablishRetryDelayMs: ESTABLISH_DELAY_MS,
      // The look is off: the subject is the RETRY gap, and a look would add its
      // own traffic to a device that answers every dispatch with a failure.
      preTapLookTimeoutMs: 0,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      ...(opts.makeRandom !== undefined ? { makeRandom: opts.makeRandom } : {}),
    },
  );
  const intents: AgentIntent[] = [{ kind: 'capture', capture: 'screenshot' }];
  await exec.execute({
    sessionId: opts.sessionId,
    agentSessionId: opts.sessionId,
    plan: { kind: 'plan', intents, tokensConsumed: 0 },
  });
  return slept;
}

describe('R9 — drawGapMs: a drawn gap is inside a band nobody widens', () => {
  it('the band is exactly the configured delay times the two factors, at both ends', () => {
    expect(drawGapMs(400, () => 0)).toBe(Math.round(400 * DRAWN_GAP_MIN_FACTOR));
    // The draw is over [0, 1), so the top of the band is approached, never met.
    expect(drawGapMs(400, () => 0.999999)).toBeLessThanOrEqual(
      Math.round(400 * DRAWN_GAP_MAX_FACTOR),
    );
    expect(drawGapMs(400, () => 0.999999)).toBeGreaterThan(400);
  });

  it('⛔ a source that answers nonsense does NOT widen the band — it reads as the middle', () => {
    // The one failure mode a "gap" must not have is an unbounded sleep inside a
    // customer's turn. `random` is injected, so this is reachable.
    const middle = Math.round(400 * ((DRAWN_GAP_MIN_FACTOR + DRAWN_GAP_MAX_FACTOR) / 2));
    for (const broken of [
      () => Number.NaN,
      () => Number.POSITIVE_INFINITY,
      () => -1,
      () => 1,
      () => 1e9,
      () => {
        throw new Error('a broken entropy source');
      },
    ]) {
      expect(drawGapMs(400, broken)).toBe(middle);
    }
  });

  it('a zero or negative base draws nothing — "disabled" stays disabled', () => {
    expect(drawGapMs(0, () => 0.9)).toBe(0);
    expect(drawGapMs(-5, () => 0.9)).toBe(0);
  });
});

describe('R9 — two retries of one step are not equally spaced', () => {
  // ⛔ THESE TWO ARMS DRAW FROM A SEEDED GENERATOR, NOT THE DEFAULT ONE. Each
  // asserts that consecutive draws from a band of a few hundred whole
  // milliseconds are unequal, and with the default per-process generator that
  // is true only with probability: two draws coincide about once in every few
  // hundred runs, and a true statement about the executor then reads as a red
  // on CI (it did, 2026-09-21, in the executor's own retry arm). A fixed
  // sequence proves the same thing every time; the DEFAULT derivation is held
  // separately below, where the property asserted is that two SESSIONS differ.
  const seeded = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  it('CRITICAL the general retry budget produces gaps that differ, inside the band', async () => {
    const gaps = await gapsFor({
      sessionId: 'agt_r9_a',
      code: 'intent_webdriver_failed',
      makeRandom: () => seeded(11),
    });
    expect(gaps).toHaveLength(2); // the default two retries
    const low = Math.round(RETRY_DELAY_MS * DRAWN_GAP_MIN_FACTOR);
    const high = Math.round(RETRY_DELAY_MS * DRAWN_GAP_MAX_FACTOR);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(low);
      expect(gap).toBeLessThanOrEqual(high);
    }
    expect(gaps[0], 'two identical spacings are the whole detector').not.toBe(gaps[1]);
  });

  it('CRITICAL the cold-start budget produces EIGHT gaps and no two consecutive ones are equal', async () => {
    const gaps = await gapsFor({
      sessionId: 'agt_r9_b',
      code: 'intent_session_not_established',
      makeRandom: () => seeded(23),
    });
    // Eight cold-start gaps, then the step falls through to the GENERAL retry
    // budget (the failure is still classified retryable), which spends its own
    // two. Both budgets are drawn, each around its own base.
    expect(gaps).toHaveLength(10);
    const coldStart = gaps.slice(0, 8);
    const general = gaps.slice(8);
    const inBand = (value: number, base: number): void => {
      expect(value).toBeGreaterThanOrEqual(Math.round(base * DRAWN_GAP_MIN_FACTOR));
      expect(value).toBeLessThanOrEqual(Math.round(base * DRAWN_GAP_MAX_FACTOR));
    };
    for (const gap of coldStart) inBand(gap, ESTABLISH_DELAY_MS);
    for (const gap of general) inBand(gap, RETRY_DELAY_MS);
    // ⛔ "+1500 ms, eight times" was the finding, in those words.
    expect(new Set(coldStart).size).toBeGreaterThan(1);
    for (let index = 1; index < coldStart.length; index += 1) {
      expect(coldStart[index], `gap ${String(index)} repeated its predecessor`).not.toBe(
        coldStart[index - 1],
      );
    }
    expect(general[0]).not.toBe(general[1]);
  });

  it('⛔ MUTATION ARM: with the draw pinned to one value, the gaps ARE equal again — so the draw is what separates them', async () => {
    // This is the pre-R9 executor's observable behaviour, reproduced through
    // the seam. If it ever stops producing equal gaps, the arms above are
    // passing for some reason other than the draw.
    const gaps = await gapsFor({
      sessionId: 'agt_r9_c',
      code: 'intent_session_not_established',
      makeRandom: () => () => 0.5,
    });
    // Two values, because two budgets: eight identical cold-start gaps and two
    // identical general ones — exactly the shape a site could read.
    expect(new Set(gaps.slice(0, 8)).size).toBe(1);
    expect(new Set(gaps.slice(8)).size).toBe(1);
  });
});

describe('R9 — two sessions do not share a rhythm', () => {
  it('CRITICAL the DEFAULT derivation gives two session ids different sequences', async () => {
    // ⛔ THE PRODUCT'S OWN SEEDING, not an injected one. A test that fixed the
    // source would be asserting its own fixture; the property is about what
    // ships.
    const first = await gapsFor({ sessionId: 'agt_one', code: 'intent_session_not_established' });
    const second = await gapsFor({ sessionId: 'agt_two', code: 'intent_session_not_established' });
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(first, 'two sessions sharing a sequence is a cross-session join key').not.toEqual(
      second,
    );
  });

  it('a session keeps ONE rhythm: the same id, twice in one process, draws the same sequence', async () => {
    // The generator is per session and is created once, so a second step of the
    // same session continues the sequence rather than restarting it — which is
    // what makes "the same person" a coherent claim about one session and
    // nothing more. Two separate executors are two separate processes' worth of
    // state, so each starts its own session sequence from the same seed.
    const a = await gapsFor({ sessionId: 'agt_same', code: 'intent_webdriver_failed' });
    const b = await gapsFor({ sessionId: 'agt_same', code: 'intent_webdriver_failed' });
    expect(a).toEqual(b);
  });
});

describe('R9 — the arithmetic outside this file that the bound feeds', () => {
  it('CRITICAL re-derived: the longest gap still fits inside the stop claim TTL margin', () => {
    // `agent-turn-bounds.ts` composes the longest turn as hard stop + ONE
    // dispatch deadline + read-back + answer stream. The tail past the hard stop
    // is really that dispatch deadline PLUS the retry gap that follows it,
    // because `runIntent` sleeps the gap and THEN asks the hard stop. The gap
    // was never a term in that sum — it was absorbed by the margin — and this
    // arm is the re-derivation R9 owes, rather than an assumption that a drawn
    // gap changes nothing.
    const worstGapBefore = ESTABLISH_DELAY_MS;
    const worstGapAfter = Math.round(ESTABLISH_DELAY_MS * DRAWN_GAP_MAX_FACTOR);
    expect(worstGapAfter).toBeGreaterThan(worstGapBefore);

    const margin = AGENT_TURN_CLAIM_TTL_SECONDS * 1000 - LONGEST_TURN_THE_CONSTANTS_PERMIT_MS;
    // The margin exists for exactly this class of unmodelled term. The growth
    // is under a second against a margin of minutes, so the composition in
    // `agent-turn-bounds.ts` does not gain a term — stated as arithmetic, not
    // as a hope.
    expect(worstGapAfter - worstGapBefore).toBeLessThan(margin / 10);
    expect(margin).toBeGreaterThan(0);
    // Non-vacuity: the terms this is compared against are real numbers, not
    // zeroes from a mis-imported module.
    expect(LONGEST_DISPATCH_DEADLINE_MS).toBeGreaterThan(0);
  });
});
