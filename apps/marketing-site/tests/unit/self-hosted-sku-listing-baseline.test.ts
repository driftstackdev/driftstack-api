// W322.B — drift guard for SELF_HOSTED_SKUS data module. The
// /self-hosted page renders three SKUs (Solo / Pro / Enterprise)
// sourced from this constant. Pins:
//   • exactly three SKUs in canonical Solo → Pro → Enterprise order
//   • Solo + Pro are 3-month minimum term; Enterprise is 12-month
//   • Enterprise carries source-escrow; lower tiers don't
//   • CTA hrefs all point at sales@driftstack.dev (the contact
//     surface for self-hosted, not a self-service checkout)

import { describe, expect, it } from 'vitest';
import { SELF_HOSTED_SKUS } from '../../src/data/pricing';

describe('W322.B SELF_HOSTED_SKUS listing baseline', () => {
  it('lists exactly three SKUs', () => {
    expect(SELF_HOSTED_SKUS.length).toBe(3);
  });

  it('ordered Solo → Pro → Enterprise', () => {
    expect(SELF_HOSTED_SKUS.map((s) => s.id)).toEqual([
      'self_hosted_solo',
      'self_hosted_pro',
      'self_hosted_enterprise',
    ]);
  });

  it('Solo + Pro require 3-month minimum term', () => {
    const solo = SELF_HOSTED_SKUS.find((s) => s.id === 'self_hosted_solo');
    const pro = SELF_HOSTED_SKUS.find((s) => s.id === 'self_hosted_pro');
    expect(solo?.minimumTermMonths).toBe(3);
    expect(pro?.minimumTermMonths).toBe(3);
  });

  it('Enterprise requires 12-month minimum term + source escrow', () => {
    const ent = SELF_HOSTED_SKUS.find((s) => s.id === 'self_hosted_enterprise');
    expect(ent?.minimumTermMonths).toBe(12);
    expect(ent?.sourceEscrow).toBe(true);
  });

  it('Solo + Pro have a fixed monthly price; Enterprise is annual-only', () => {
    const solo = SELF_HOSTED_SKUS.find((s) => s.id === 'self_hosted_solo');
    const pro = SELF_HOSTED_SKUS.find((s) => s.id === 'self_hosted_pro');
    const ent = SELF_HOSTED_SKUS.find((s) => s.id === 'self_hosted_enterprise');
    expect(typeof solo?.monthlyUsd).toBe('number');
    expect(typeof pro?.monthlyUsd).toBe('number');
    expect(ent?.monthlyUsd).toBeNull();
  });

  it('every SKU CTA points at sales@driftstack.dev (no self-service checkout)', () => {
    for (const sku of SELF_HOSTED_SKUS) {
      expect(sku.ctaHref).toMatch(/^mailto:sales@driftstack\.dev/);
    }
  });
});
