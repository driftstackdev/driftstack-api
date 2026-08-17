// The annual price a customer is actually billed must follow from the monthly
// price and the discount the site publishes — not from a literal nobody rechecks.
//
// Measured when this landed: every reference to `annualUsd` in the whole
// repository was a literal regex quoting the number (three source-text pins in
// marketing-site, seven in marketing-pricing-adr-004-parity). Nothing derived
// it. A pin freezes what the number IS; it cannot say whether the number is
// RIGHT. Change a monthly price and update the pins to match — exactly what a
// maintainer does during a repricing — and a stale or miscomputed `annualUsd`
// ships green: the pricing page renders `{fmtUsd(tier.annualUsd)} yearly`
// straight from this field.
//
// ⚠️ The rule is NOT `annualUsd === annualMonthlyEquivalentUsd × 12`, despite a
// comment in pricing.ts having said so of "every tier". Measured across the
// ladder, that holds for the three self-hosted SKUs and fails for all six API
// tiers by exactly $2:
//
//   solo_manual   79/mo → eq 63,   annual 758   (63 × 12 = 756)
//   api_scale   1499/mo → eq 1199, annual 14_390 (1199 × 12 = 14_388)
//
// The $2 is a rounding artifact, not an error. `annualUsd` is the true annual
// total (monthly × 12, less the published discount); `annualMonthlyEquivalentUsd`
// is that total divided back down for display and floored to a whole dollar. So
// the two real invariants are the two below, and the discount rate is read out
// of ANNUAL_DISCOUNT_LABEL rather than typed here — retitling the offer without
// repricing, or repricing without retitling the offer, both fail.

import { describe, expect, it } from 'vitest';
import { ANNUAL_DISCOUNT_LABEL, API_TIERS, SELF_HOSTED_SKUS } from '../../src/data/pricing';

interface PricedEntry {
  ladder: string;
  id: string;
  monthlyUsd: number | null;
  annualMonthlyEquivalentUsd: number | null;
  annualUsd: number | null;
}

function roster(): PricedEntry[] {
  const rows: PricedEntry[] = [];
  for (const t of API_TIERS)
    rows.push({
      ladder: 'API_TIERS',
      id: t.id,
      monthlyUsd: t.monthlyUsd,
      annualMonthlyEquivalentUsd: t.annualMonthlyEquivalentUsd,
      annualUsd: t.annualUsd,
    });
  for (const s of SELF_HOSTED_SKUS)
    rows.push({
      ladder: 'SELF_HOSTED_SKUS',
      id: s.id,
      monthlyUsd: s.monthlyUsd,
      annualMonthlyEquivalentUsd: s.annualMonthlyEquivalentUsd,
      annualUsd: s.annualUsd,
    });
  return rows;
}

/** The discount the site advertises, taken from the label the site shows. */
function publishedDiscountRate(): number {
  const pct = /(\d+)\s*%\s*off/i.exec(ANNUAL_DISCOUNT_LABEL)?.[1];
  expect(
    pct,
    `ANNUAL_DISCOUNT_LABEL ("${ANNUAL_DISCOUNT_LABEL}") no longer states a percentage`,
  ).toBeDefined();
  return 1 - Number(pct) / 100;
}

describe('annual pricing figures are derived, not asserted', () => {
  it('CRITICAL the roster and the published rate are real, so a pass is measured against real data', () => {
    const rows = roster();
    expect(rows.length, 'the pricing ladders are empty — the import is broken').toBeGreaterThan(8);
    expect(
      rows.filter((r) => r.annualUsd !== null).length,
      'no annually-priced entry found — the checks below would be vacuous',
    ).toBeGreaterThanOrEqual(8);
    // The rate must come out of the label, and the label must be the real one.
    expect(publishedDiscountRate()).toBeCloseTo(0.8, 10);
  });

  it('CRITICAL annualUsd applies the discount the site publishes, on every priced entry', () => {
    const rate = publishedDiscountRate();
    const wrong = roster()
      .filter((r) => r.monthlyUsd !== null && r.monthlyUsd > 0 && r.annualUsd !== null)
      .filter((r) => r.annualUsd !== Math.round(r.monthlyUsd! * 12 * rate))
      .map(
        (r) =>
          `${r.ladder}/${r.id}: annualUsd ${r.annualUsd} but ${r.monthlyUsd}/mo at ` +
          `${ANNUAL_DISCOUNT_LABEL} is ${Math.round(r.monthlyUsd! * 12 * rate)}`,
      );
    expect(
      wrong,
      'the yearly total billed does not match the monthly price and the advertised discount',
    ).toEqual([]);
  });

  it('CRITICAL the displayed "/mo" figure is that same annual total divided back down', () => {
    const wrong = roster()
      .filter((r) => r.annualUsd !== null && r.annualMonthlyEquivalentUsd !== null)
      .filter((r) => r.annualMonthlyEquivalentUsd !== Math.floor(r.annualUsd! / 12))
      .map(
        (r) =>
          `${r.ladder}/${r.id}: shows ${r.annualMonthlyEquivalentUsd}/mo but ` +
          `${r.annualUsd}/yr floors to ${Math.floor(r.annualUsd! / 12)}/mo`,
      );
    expect(
      wrong,
      'the pricing card renders both figures together — "$X/mo · billed $Y yearly" must agree',
    ).toEqual([]);
  });

  it('CRITICAL both rules reject a wrong figure (they are not satisfied by anything)', () => {
    const rate = publishedDiscountRate();
    // Rule 1 arithmetic, exercised on a deliberately wrong triple.
    expect(Math.round(79 * 12 * rate)).toBe(758);
    expect(758).not.toBe(Math.round(99 * 12 * rate));
    // Rule 2 arithmetic: eq*12 is NOT the rule, and floor(annual/12) is.
    expect(Math.floor(758 / 12)).toBe(63);
    expect(63 * 12).not.toBe(758);
    expect(Math.floor(9_600 / 12)).toBe(800);
  });
});
