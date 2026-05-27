// Drift-guard: the thresholdState values documented in
// api/cost-monitoring.md must match the ThresholdState union the cost
// engine actually emits.
//
// Why: the doc documented the middle state as `between` (example + table)
// while the engine emits `between-soft-and-hard` (cost-estimator.ts:111),
// so a customer branching on `thresholdState === 'between'` never matched.
// This customer doc had no parity test, so the drift was silent. Pins the
// three documented states to the union members extracted from source.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const DOC = readFileSync(resolve(REPO, 'apps/docs/src/pages/api/cost-monitoring.md'), 'utf8');
const ESTIMATOR = readFileSync(resolve(REPO, 'apps/server/src/lib/cost-estimator.ts'), 'utf8');

/** Members of the `ThresholdState` union, extracted from source. */
function thresholdStates(): string[] {
  const m = ESTIMATOR.match(/export type ThresholdState =([^;]+);/);
  const body = m?.[1];
  if (body === undefined) return [];
  const out: string[] = [];
  for (const x of body.matchAll(/'([a-z-]+)'/g)) {
    const v = x[1];
    if (v !== undefined) out.push(v);
  }
  return out;
}

describe('api/cost-monitoring.md thresholdState ↔ ThresholdState union parity', () => {
  const states = thresholdStates();

  it('extracts the three-member union from source (sanity)', () => {
    expect(states).toEqual(['under-soft', 'between-soft-and-hard', 'over-hard']);
  });

  it('every emitted thresholdState value is documented in the doc', () => {
    const missing = states.filter((s) => !DOC.includes(`\`${s}\``) && !DOC.includes(`"${s}"`));
    expect(
      missing,
      `states documented nowhere in cost-monitoring.md: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it("does not document the stale bare 'between' value (the drift this guard closes)", () => {
    // The middle state is 'between-soft-and-hard'; a bare `between` token
    // (backtick cell or JSON string) would be the regression.
    expect(DOC).not.toMatch(/`between`/);
    expect(DOC).not.toMatch(/"thresholdState": "between"/);
  });
});
