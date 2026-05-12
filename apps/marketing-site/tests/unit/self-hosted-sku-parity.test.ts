// W300.B — drift guard for marketing self-hosted SKUs. The
// /self-hosted page reads from SELF_HOSTED_SKUS in pricing.ts.
// Verify every SKU id matches a real tier in pricing.ts (so the
// page renders) and that the marketing copy doesn't invent a SKU
// that isn't in the data module.

import { describe, expect, it } from 'vitest';
import { API_TIERS, SELF_HOSTED_SKUS } from '../../src/data/pricing';

describe('W300.B /self-hosted SKU parity', () => {
  it('SELF_HOSTED_SKUS has at least 3 entries', () => {
    expect(SELF_HOSTED_SKUS.length).toBeGreaterThanOrEqual(3);
  });

  it('every API_TIERS entry with tierType=self_hosted has a SELF_HOSTED_SKUS counterpart', () => {
    const selfHostedTiers = API_TIERS.filter((t) => t.tierType === 'self_hosted').map((t) => t.id);
    const skuIds = new Set(SELF_HOSTED_SKUS.map((s) => s.id));
    const missing = selfHostedTiers.filter((id) => !skuIds.has(id));
    expect(missing).toEqual([]);
  });

  it('every SKU id starts with self_hosted_ (no naming drift)', () => {
    const offenders = SELF_HOSTED_SKUS.map((s) => s.id).filter(
      (id) => !id.startsWith('self_hosted_'),
    );
    expect(offenders).toEqual([]);
  });
});
