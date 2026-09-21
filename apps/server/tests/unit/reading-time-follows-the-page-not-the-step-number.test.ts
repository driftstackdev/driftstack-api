// READING TIME FOLLOWS THE PAGE, NOT THE STEP NUMBER.
//
// ⛔ THIS IS THE FEATURE'S PRIMARY FALSIFIABLE CLAIM, and it is the one a
// detector can check from outside. A policy whose "reading pause" is a function
// of the step index produces dwell times that correlate with position in the
// plan and not at all with how much there is to read — across a cohort, dwell
// time versus content length collapses to zero, which is a cleaner signal than
// any single pause. Following the page is the only version of this feature
// worth shipping; following the step number would be a delay with a name.
//
// ⛔ WHERE THE WORD COUNT COMES FROM, AND WHAT IT IS NOT. It is the digest the
// planner was shown — bounded at MAX_PAGE_DIGEST_CHARS — which the runtime
// already reads between segments. No extra device call, and a bound on the
// reading band that follows from a bound that already existed. It is NOT a
// whole-document word count, and nothing here claims a human reading speed:
// the rate is derived below from the BASE CEILING the executor actually applies
// (`PACE_STEP_CAP_MS / DRAWN_GAP_MAX_FACTOR`), so that the largest page this
// server can see still draws a base under it. ⛔ DERIVING AGAINST THE CAP
// INSTEAD IS THE TRAP: it clears a number nothing compares against, and every
// page past `ceiling / rate` words then draws the same base — the constant the
// drawn band exists to remove, reintroduced on exactly the long pages the
// reading beat is for. See the last describe in this file.
//
// ⚠️ AND A STATED APPROXIMATION: inside a segment that navigates, the count is
// still the page the segment was PLANNED against, because the server has not
// read the new one and will not spend a dispatch to. It is page-derived either
// way, which is the property; it is not the page now on screen.

import { describe, expect, it } from 'vitest';
import {
  PACE_STEP_CAP_MS,
  READING_FLOOR_MS,
  READING_MS_PER_WORD,
  countDigestWords,
  paceBaseCeilingMs,
  paceBeatFor,
} from '../../src/services/agent-pace.js';
import type { PacedBand } from '../../src/services/agent-pace.js';
import {
  DRAWN_GAP_MAX_FACTOR,
  MAX_PAGE_DIGEST_CHARS,
} from '../../src/services/agent-executor-control-plane.js';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import {
  budgetFor,
  draws,
  paceDevice,
  paceExecutor,
  pauseDurations,
} from './_helpers/pace-harness.js';

/** A plan whose FIRST step is a page arrival and whose later steps are not, so
 *  a step-index policy and a page policy give different answers. */
const PLAN: AgentIntent[] = [
  { kind: 'interact', action: 'tap', selector: '#one' },
  { kind: 'interact', action: 'tap', selector: '#two' },
  { kind: 'interact', action: 'tap', selector: '#three' },
];

async function firstReadingPause(
  words: number,
  sessionId: string,
  band: PacedBand = 'slow',
): Promise<number> {
  const d = paceDevice();
  await paceExecutor(d.dispatcher, {
    // A fixed draw, so the ONLY thing that differs between two runs below is
    // the page. With a moving draw the comparison would be about the generator.
    // 0.25 is under BOTH bands' reading frequency (medium pauses on about half
    // of the arrivals), and the second draw of 0.5 is the middle of the gap
    // band, so the pause that lands IS the base — which is what makes the
    // comparison below about the page and not about the draw.
    makeRandom: () => draws([0.25, 0.5]),
  }).execute({
    sessionId,
    agentSessionId: `agt_${sessionId}`,
    plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
    pace: budgetFor(band, 30_000, { pageWordCount: words }),
  });
  const [first] = pauseDurations(d.sent);
  expect(first, 'the run inserted no reading pause at all').toBeDefined();
  return first as number;
}

describe('reading time follows the page', () => {
  it('CRITICAL a longer page is read for longer — strictly monotone across four page sizes, at one fixed draw', async () => {
    const sizes = [20, 100, 250, 500];
    const times: number[] = [];
    for (const [index, words] of sizes.entries()) {
      times.push(await firstReadingPause(words, `ses_words_${String(index)}`));
    }
    for (let i = 1; i < times.length; i += 1) {
      expect(
        times[i],
        `a ${String(sizes[i])}-word page was not read for longer than a ${String(sizes[i - 1])}-word one`,
      ).toBeGreaterThan(times[i - 1] as number);
    }
  });

  it('CRITICAL the same page at a DIFFERENT position in the plan is read for the same time — position is not an input', () => {
    // Read off the policy directly, because the executor can only put a reading
    // beat where a page was arrived at; the claim is about the function.
    const page = { band: 'slow' as const, pageWordCount: 300, chance: 0 };
    const atSegmentStart = paceBeatFor({ ...page, step: 'tap', previous: null });
    const afterANavigate = paceBeatFor({ ...page, step: 'tap', previous: 'navigate' });
    expect(atSegmentStart?.beat).toBe('reading');
    expect(afterANavigate?.beat).toBe('reading');
    expect(afterANavigate?.baseMs).toBe(atSegmentStart?.baseMs);
    // And the same position with a DIFFERENT page is a different time, so the
    // equality above is not the function ignoring both inputs.
    const otherPage = paceBeatFor({ ...page, pageWordCount: 60, step: 'tap', previous: null });
    expect(otherPage?.baseMs).not.toBe(atSegmentStart?.baseMs);
  });

  it('CRITICAL a turn with NO page read yet takes no reading beat — a blind first segment is not a page of zero words', () => {
    const blind = paceBeatFor({
      band: 'slow',
      step: 'tap',
      previous: null,
      pageWordCount: null,
      chance: 0,
    });
    expect(blind).toBeNull();
    // …and the same position WITH a page does take one, so the null above is
    // about the missing count and not about the position.
    expect(
      paceBeatFor({ band: 'slow', step: 'tap', previous: null, pageWordCount: 10, chance: 0 })
        ?.beat,
    ).toBe('reading');
  });

  it('CRITICAL the rate is DERIVED from the digest cap: the largest page this server can produce still draws a base under the per-step cap, so the cap never becomes the usual answer', () => {
    // ⛔ WHY THIS MATTERS MORE THAN THE RATE ITSELF. If the biggest pages
    // saturated the cap, every long page in every session would produce the
    // same exact number — the policy would manufacture the constant a drawn
    // band exists to remove, and it would do it on exactly the pages worth
    // reading.
    //
    // ~6 characters per word is the conservative direction here: fewer
    // characters per word means MORE words out of the same cap, so a rate that
    // passes at 6 passes at any larger figure.
    //
    // ⛔ REVIEW CORRECTION: this arm used to compare the raw base against
    // PACE_STEP_CAP_MS — a comparison the executor never makes, because it
    // hands the draw `min(base, paceBaseCeilingMs(band, DRAWN_GAP_MAX_FACTOR))`.
    // Clearing the cap while saturating the CEILING is the same defect one
    // level down, and it is checked properly in "the reading rate clears the
    // ceiling the executor actually applies" below. What stays here is the
    // consequence that arm exists for: the drawn value cannot reach the cap.
    const mostWordsADigestCanHold = Math.ceil(MAX_PAGE_DIGEST_CHARS / 6);
    expect(
      Math.round(mostWordsADigestCanHold * READING_MS_PER_WORD.slow * DRAWN_GAP_MAX_FACTOR),
    ).toBeLessThan(PACE_STEP_CAP_MS.slow);
    // The floor is a real floor: a page with two words is still a page somebody
    // looked at, and is not read in nothing flat.
    expect(
      paceBeatFor({ band: 'slow', step: 'tap', previous: null, pageWordCount: 1, chance: 0 })
        ?.baseMs,
    ).toBe(READING_FLOOR_MS);
  });

  it('the word count comes off the digest, and an absent or empty digest is "no page", not "zero words"', () => {
    expect(countDigestWords(undefined)).toBeNull();
    expect(countDigestWords(null)).toBeNull();
    expect(countDigestWords('   \n  ')).toBeNull();
    expect(countDigestWords('one two three')).toBe(3);
    // Whitespace of every kind collapses, so a digest's newline-separated
    // element rows count as the tokens they are rather than as one long token
    // per line. (Eight here: the separator glyphs count too — the number is a
    // SIZE PROXY for the page, not a linguistic word count, and it is used as
    // one.)
    expect(countDigestWords('page: Shop\n#buy · button · "Buy now"')).toBe(8);
  });

  it('NEGATIVE CONTROL — a policy that read the STEP NUMBER would differ here, and this fixture can tell the two apart', async () => {
    // The same page, two plans whose reading beat falls at different plan
    // indices. A step-index policy gives two different times; the shipped one
    // gives the same.
    const d1 = paceDevice();
    await paceExecutor(d1.dispatcher, { makeRandom: () => draws([0.5]) }).execute({
      sessionId: 'ses_pos_a',
      agentSessionId: 'agt_pos_a',
      plan: {
        kind: 'plan',
        intents: [
          { kind: 'navigate', url: 'https://shop.test/a' },
          { kind: 'interact', action: 'tap', selector: '#x' },
        ],
        tokensConsumed: 0,
      },
      pace: budgetFor('slow', 30_000, { pageWordCount: 300 }),
    });
    const d2 = paceDevice();
    await paceExecutor(d2.dispatcher, { makeRandom: () => draws([0.5]) }).execute({
      sessionId: 'ses_pos_b',
      agentSessionId: 'agt_pos_b',
      plan: {
        kind: 'plan',
        intents: [
          { kind: 'interact', action: 'scroll', selector: 'body' },
          { kind: 'interact', action: 'scroll', selector: 'body' },
          { kind: 'navigate', url: 'https://shop.test/a' },
          { kind: 'interact', action: 'tap', selector: '#x' },
        ],
        tokensConsumed: 0,
      },
      pace: budgetFor('slow', 30_000, { pageWordCount: 300 }),
    });
    // The reading beat after the navigate is the LAST pause in each run.
    const a = pauseDurations(d1.sent).at(-1);
    const b = pauseDurations(d2.sent).at(-1);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(b).toBe(a);
  });
});

// ── REVIEW (S6, rhythm) — THE CEILING THE DERIVATION FORGOT ──────────────
//
// ⛔ THE DERIVATION ABOVE COMPARES THE WRONG TWO NUMBERS, and the arm that
// certifies it compares them too. It checks `maxWords × rate < PACE_STEP_CAP_MS`
// — but the executor never hands `maxWords × rate` to a draw. It hands
// `min(base, paceBaseCeilingMs(band, DRAWN_GAP_MAX_FACTOR))`, which is
// `PACE_STEP_CAP_MS / 1.45`, because the draw multiplies the base by up to
// DRAWN_GAP_MAX_FACTOR and the cap is what must not be REACHED. That ceiling is
// 6,206 ms on slow and 2,758 ms on medium — so the rate has to clear the
// CEILING at the largest digest, not the cap.
//
// ⛔ WHAT IT COSTS WHEN IT DOES NOT. Every page above the plateau point draws
// the SAME base, so reading time stops following the page exactly where there
// is most to read: the module's own `paceBaseCeilingMs` doc says clamping "piles
// every long page onto one exact number … the cap would manufacture the constant
// the policy is there to avoid", and a base ceiling does that one level down.
// The original monotonicity sweep ran [20, 100, 250, 500] words and never
// reached the plateau, so the property was certified over the half of the range
// where it holds — precision without recall.
describe('the reading rate clears the ceiling the executor actually applies', () => {
  const BANDS: readonly PacedBand[] = ['medium', 'slow'];
  // ~6 characters per word is the conservative direction: fewer characters per
  // word means MORE words out of the same cap.
  const mostWordsADigestCanHold = Math.ceil(MAX_PAGE_DIGEST_CHARS / 6);

  it('CRITICAL the largest digest this server can produce still draws a base under the BASE CEILING, in every band', () => {
    for (const band of BANDS) {
      const ceiling = paceBaseCeilingMs(band, DRAWN_GAP_MAX_FACTOR);
      expect(
        mostWordsADigestCanHold * READING_MS_PER_WORD[band],
        `${band}: the biggest page this server can produce saturates the base ceiling, so every long page reads for the same base`,
      ).toBeLessThanOrEqual(ceiling);
      // …and the ceiling is still doing its job: a base at it cannot reach the
      // per-step cap once the draw multiplies it.
      expect(Math.round(ceiling * DRAWN_GAP_MAX_FACTOR)).toBeLessThanOrEqual(
        PACE_STEP_CAP_MS[band],
      );
    }
  });

  it('CRITICAL reading time is strictly monotone across the WHOLE digest range, not just its small end', async () => {
    for (const band of BANDS) {
      const sizes = [20, 100, 250, 400, 550, mostWordsADigestCanHold];
      const times: number[] = [];
      for (const [index, words] of sizes.entries()) {
        times.push(await firstReadingPause(words, `ses_full_${band}_${String(index)}`, band));
      }
      for (let i = 1; i < times.length; i += 1) {
        expect(
          times[i],
          `${band}: a ${String(sizes[i])}-word page was not read for longer than a ${String(sizes[i - 1])}-word one — the base ceiling flattened the top of the range`,
        ).toBeGreaterThan(times[i - 1] as number);
      }
    }
  });

  it('NEGATIVE CONTROL — the floor really is a floor, so the monotonicity above is not the function ignoring its input at the bottom either', () => {
    for (const band of BANDS) {
      // Below the floor two different tiny pages read for the same time, which
      // is deliberate and is the one place the sweep above starts.
      const tiny = paceBeatFor({ band, step: 'tap', previous: null, pageWordCount: 1, chance: 0 });
      expect(tiny?.baseMs).toBe(READING_FLOOR_MS);
      const justAbove = Math.ceil(READING_FLOOR_MS / READING_MS_PER_WORD[band]) + 1;
      const above = paceBeatFor({
        band,
        step: 'tap',
        previous: null,
        pageWordCount: justAbove,
        chance: 0,
      });
      expect(above?.baseMs).toBeGreaterThan(READING_FLOOR_MS);
    }
  });
});
