// The cutover's cohort roster and the census's cohort roster are two constants
// naming one vocabulary (plan §8's C0–C4). The service comment on
// `CUTOVER_COHORTS` says this file keeps them in agreement; this is that file.
// A cohort added to one and not the other would let a dry run name a cohort the
// census cannot count, or the census count one the cutover refuses by name.

import { describe, expect, it } from 'vitest';
import { AI_CREDITS_COHORTS } from '../../src/db/ai-credits-report-repo.js';
import { CUTOVER_COHORTS } from '../../src/services/credit-cutover.js';

describe('the cutover cohort roster agrees with the census cohort roster', () => {
  it('names exactly the same cohorts, in the same order', () => {
    expect([...CUTOVER_COHORTS]).toEqual([...AI_CREDITS_COHORTS]);
  });

  it('C0 is first and is the only Phase-1 cohort', () => {
    expect(CUTOVER_COHORTS[0]).toBe('C0');
    expect(CUTOVER_COHORTS.slice(1)).toEqual(['C1', 'C2', 'C3', 'C4']);
  });
});
