// Drift guard: customer cost docs must match the live threshold taxonomy,
// compute-only aggregator and concurrency-only billing posture.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const DOC = read('apps/docs/src/pages/api/cost-monitoring.md');
const ESTIMATOR = read('apps/server/src/lib/cost-estimator.ts');
const AGGREGATOR = read('apps/server/src/services/cost-aggregator.ts');
const USAGE = read('apps/server/src/services/usage.ts');

function read(path: string): string {
  return readFileSync(resolve(REPO, path), 'utf8');
}

function thresholdStates(): string[] {
  const source = ESTIMATOR.match(/export type ThresholdState =([^;]+);/)?.[1] ?? '';
  return [...source.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!);
}

describe('cost-monitoring docs ↔ runtime truth', () => {
  it('documents every emitted threshold state and no stale bare between value', () => {
    const states = thresholdStates();
    expect(states).toEqual(['under-soft', 'between-soft-and-hard', 'over-hard']);
    expect(
      states.filter((state) => !DOC.includes(`\`${state}\``) && !DOC.includes(`"${state}"`)),
    ).toEqual([]);
    expect(DOC).not.toMatch(/`between`|"thresholdState": "between"/);
  });

  it('pins compute-only aggregation and four reserved zero response fields', () => {
    expect(AGGREGATOR).toMatch(/const sessionMinutes = totals\.totals\.session_minute \?\? 0/);
    for (const input of [
      'storageGbMonths: 0',
      'egressGb: 0',
      'emailSends: 0',
      'llmInputTokens: 0',
      'llmOutputTokens: 0',
    ]) {
      expect(AGGREGATOR).toContain(input);
    }
    for (const field of ['storageCents', 'egressCents', 'emailCents', 'llmCents']) {
      expect(DOC).toContain(`"${field}": 0`);
    }
  });

  it('pins fixed/concurrency-only browser subscriptions and non-invoice estimate semantics', () => {
    expect(USAGE).toMatch(/All TIER_QUOTAS values are now `null` \(unmetered\) across every/);
    expect(DOC).toMatch(
      /browser subscriptions are fixed-price and enforced by\s+concurrent-session capacity/i,
    );
    expect(DOC).toMatch(
      /It is not\s+the amount charged to you, a Stripe invoice, or a NowPayments receipt/,
    );
    expect(DOC).toMatch(/Do not use it as an invoice total/);
    expect(DOC).toMatch(/Stripe-issued invoices[\s\S]*NowPayments receipt, for payment truth/);
  });

  it('pins the separate LLM monthly budget and the Driftstack-set threshold effect', () => {
    expect(DOC).toMatch(/Its 10 cents per\s+turn counts against your bundled-LLM monthly budget/);
    expect(DOC).toMatch(
      /not included\s+in this estimate or separately itemized on your Stripe invoice/,
    );
    expect(DOC).toMatch(/compares the estimate with thresholds\s+Driftstack sets/);
    expect(DOC).toMatch(
      /does not add an\s+invoice item, email a customer billing warning, rate-limit/,
    );
    expect(DOC).not.toMatch(/coming soon|will move to nightly|future billing/i);
  });
});
