// W243.D — drift-guard for /docs/cost-monitoring. Pins the doc's
// claims about the /v1/account/cost endpoint shape + threshold-state
// enum to the live implementation. Any drift in the breakdown keys,
// the threshold values, or the billing_cycle param surfaces here.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = join(__dirname, '..', '..', '..', '..');
const DOC_PATH = join(
  REPO,
  'apps',
  'marketing-site',
  'src',
  'pages',
  'docs',
  'cost-monitoring.astro',
);
const COST_ROUTE = join(REPO, 'apps', 'server', 'src', 'routes', 'account-cost.ts');
const COST_ESTIMATOR = join(REPO, 'apps', 'server', 'src', 'lib', 'cost-estimator.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('W243.D cost-monitoring doc parity', () => {
  const doc = read(DOC_PATH);
  const route = read(COST_ROUTE);
  const estimator = read(COST_ESTIMATOR);

  it('pins endpoint to /v1/account/cost with billing_cycle param', () => {
    expect(route).toContain(`'/v1/account/cost'`);
    expect(route).toMatch(/billing_cycle:\s*z\s*\.\s*string/);
    expect(doc).toMatch(/\/v1\/account\/cost\?billing_cycle=YYYY-MM/);
  });

  it('breakdown keys match the live serialiser', () => {
    for (const key of [
      'computeCents',
      'storageCents',
      'egressCents',
      'emailCents',
      'llmCents',
      'totalCents',
      'thresholdState',
    ]) {
      expect(route).toContain(`${key}:`);
      expect(doc).toContain(key);
    }
  });

  it('threshold-state enum matches lib/cost-estimator ThresholdState', () => {
    expect(estimator).toMatch(
      /export type ThresholdState\s*=\s*'under-soft'\s*\|\s*'between-soft-and-hard'\s*\|\s*'over-hard'/,
    );
    for (const state of ['under-soft', 'between-soft-and-hard', 'over-hard']) {
      expect(doc).toContain(state);
    }
  });

  it('does not surface operator-tuned threshold cent values to customers', () => {
    // Doc should explicitly state threshold values are NOT in the response.
    expect(doc).toMatch(/Threshold numeric values are not part of the customer\s+response/);
    // And the route should not include softCents / hardCents in the customer payload.
    expect(route).not.toMatch(/softCents:\s*summary/);
    expect(route).not.toMatch(/hardCents:\s*summary/);
  });

  it('synthesises a zero breakdown for fresh accounts (200, not 404)', () => {
    expect(route).toMatch(/Not 404 — for a fresh account/);
    expect(doc).toMatch(/synthesised zero-breakdown[\s\S]*?no 404/i);
  });
});
