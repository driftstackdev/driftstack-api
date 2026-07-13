// Drift-guard: the admin cost-badge color maps must key on the real
// ThresholdState union values, not the stale `between`.
//
// Why: `cost-estimator.ts` emits the middle state as
// `between-soft-and-hard`, but the admin cost page + per-account detail
// page both keyed their STATE_BADGE map with `between` — so an account in
// the soft-warn state looked up an undefined key and fell through to the
// gray default badge instead of amber. Fixed 2026-05-27; this pins it so
// the badge maps can't drift back (the value already recurred across the
// doc + two UI pages once).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const ESTIMATOR = readFileSync(resolve(REPO, 'apps/server/src/lib/cost-estimator.ts'), 'utf8');

function read(rel: string): string {
  return readFileSync(resolve(REPO, rel), 'utf8');
}

// The pages that render a thresholdState badge keyed by the emitted value.
const BADGE_PAGES = [
  'apps/admin-panel/src/pages/cost.astro',
  'apps/admin-panel/src/pages/shells/account-detail.astro',
];

describe('admin cost-badge keys ↔ ThresholdState union', () => {
  it('the ThresholdState union still has the three expected members (sanity)', () => {
    const m = ESTIMATOR.match(/export type ThresholdState =([^;]+);/);
    const body = m?.[1] ?? '';
    for (const v of ['under-soft', 'between-soft-and-hard', 'over-hard']) {
      expect(body, `ThresholdState must include '${v}'`).toContain(`'${v}'`);
    }
  });

  for (const page of BADGE_PAGES) {
    it(`${page}: badge map keys on 'between-soft-and-hard', not the stale 'between'`, () => {
      const src = read(page);
      // The page references the middle state somewhere (badge map).
      expect(src, `${page} should reference the canonical middle state`).toContain(
        'between-soft-and-hard',
      );
      // No bare `between:` map key (the regression). Layout classes like
      // `justify-between` use a hyphen, never `between:` as an object key.
      expect(src, `${page} must not key a badge on bare 'between'`).not.toMatch(
        /\bbetween:\s*'bg-/,
      );
    });
  }
});
