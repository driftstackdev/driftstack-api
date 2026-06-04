// W973 — V-541.F cost-defaults cross-source invariant. Two-hundred-
// ninety-ninth in the drift-guard series. Pins the apps/server/src/
// lib/cost-defaults.ts production rate-card + tier-derived-threshold
// primitive:
//
//   V-541.F anchor — 'V-541.F — production defaults for cost rates +
//   tier thresholds'.
//
//   Pure-estimator framing — 'The estimator (V-658) is pure — it
//   accepts rates + thresholds as inputs so tests and tooling can
//   sweep alternative configurations. Production wiring needs
//   concrete defaults; before this module they lived as inline
//   literals in tests / fixtures, which drifts the "what we actually
//   deploy" from "what we test." Centralising them here means a rate
//   change is one edit + a runbook entry'.
//
//   Internal-accounting posture framing — 'rates are an internal
//   accounting concept (cost-to-serve); they do NOT drive customer
//   pricing. Pricing lives in packages/api-types (tier configs) +
//   the Stripe price-list. These numbers anchor the V-541 cost-
//   monitoring alerting only'.
//
//   DEFAULT_COST_RATES (EUR cents) 6-rate inventory:
//     - computeCentsPerMinute: 0.05 (Hetzner CCX13 fleet-averaged).
//     - storageCentsPerGbMonth: 1.5 (R2 €0.015/GB-month list).
//     - egressCentsPerGb: 5 (TURN €0.05/GB post-V-531-discount).
//     - emailCentsPerSend: 0.1 (Postmark transactional bulk).
//     - llmCentsPer1kInputTokens: 0.5 (Anthropic Claude Opus 4.7 $5/1M).
//     - llmCentsPer1kOutputTokens: 2.5 (Anthropic Claude Opus 4.7 $25/1M).
//
//   Source-spreadsheet framing — 'Source spreadsheet: docs/internal/
//   v541-cost-monitoring-design.md, Default rate card v1 (W44
//   review). Rates re-reviewed quarterly against actual invoices
//   from Hetzner / Cloudflare R2 / Postmark / OpenAI; bump this
//   constant + add an entry to the cost-monitoring runbook when a
//   sub-processor price changes meaningfully'.
//
//   TIER_MONTHLY_PRICE_CENTS (Partial<Record<AccountTier, number>>)
//     6-tier inventory:
//       - solo_manual: 7900 ($79/mo).
//       - team_manual: 24900 ($249/mo).
//       - agency_manual: 69900 ($699/mo).
//       - api_starter: 14900 ($149/mo).
//       - api_builder: 49900 ($499/mo).
//       - api_scale: 149900 ($1,499/mo).
//
//   deriveThresholdsFromMonthlyPrice formula — softCents = round(P
//     × 0.6), hardCents = round(P × 0.9).
//
//   Runbook-anchor framing — 'Soft = approaching the operator-
//   tolerated cost ceiling. Hard = 10% margin between cost-to-serve
//   and revenue. The runbook (docs/runbooks/cost-monitoring.md)
//   documents this rationale; tweaking the multipliers means editing
//   both this file AND the runbook so the operator's interpretation
//   stays in sync'.
//
//   DEFAULT_TIER_THRESHOLDS_DERIVED — Object.fromEntries(
//     Object.entries(TIER_MONTHLY_PRICE_CENTS).map(...derive)).
//
//   Derived-vs-hand-tuned framing — 'Compared with the in-estimator
//   DEFAULT_TIER_THRESHOLDS, this map is derived (price-driven)
//   rather than hand-tuned. Both are intentionally kept around: the
//   estimator's defaults exist so the pure module is self-contained,
//   this map exists so production wiring is anchored to tier
//   pricing'.
//
// stays in lockstep across apps/server/src/lib/cost-defaults.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COST_RATES,
  DEFAULT_TIER_THRESHOLDS_DERIVED,
  TIER_MONTHLY_PRICE_CENTS,
  deriveThresholdsFromMonthlyPrice,
} from '../../src/lib/cost-defaults.js';
import { TIER_PRICE_CENTS } from '../../src/routes/billing-crypto.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W973 V-541.F cost-defaults cross-source invariant', () => {
  // ─── V-541.F anchor ──────────────────────────────────────────

  it("CRITICAL apps/server/src/lib/cost-defaults.ts header pins V-541.F anchor — 'V-541.F — production defaults for cost rates + tier thresholds'. The V-541.F anchor is the policy provenance for centralising production rate-cards.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/V-541\.F — production defaults for cost rates \+ tier thresholds\./);
  });

  // ─── Pure-estimator framing ──────────────────────────────────

  it("CRITICAL pure-estimator framing — 'The estimator (V-658) is pure — it accepts rates + thresholds as inputs so tests and tooling can sweep alternative configurations. Production wiring needs concrete defaults; before this module they lived as inline literals in tests / fixtures, which drifts the what we actually deploy from what we test. Centralising them here means a rate change is one edit + a runbook entry'. The pure-V-658 + centralised-defaults design is the V-541.F + V-658 cross-source contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/The estimator \(V-658\) is pure — it accepts rates \+ thresholds as/);
    expect(p).toMatch(/inputs so tests and tooling can sweep alternative configurations\./);
    expect(p).toMatch(/Production wiring needs concrete defaults; before this module they/);
    expect(p).toMatch(/lived as inline literals in tests \/ fixtures, which drifts the/);
    expect(p).toMatch(/"what we actually deploy" from "what we test\."/);
    expect(p).toMatch(/Centralising them/);
    expect(p).toMatch(/here means a rate change is one edit \+ a runbook entry\./);
  });

  // ─── Internal-accounting posture framing ─────────────────────

  it("CRITICAL internal-accounting posture framing — 'rates are an internal accounting concept (cost-to-serve); they do NOT drive customer pricing. Pricing lives in packages/api-types (tier configs) + the Stripe price-list. These numbers anchor the V-541 cost-monitoring alerting only'. The cost-not-pricing + V-541-alerting-only design is the posture contract preventing rate misuse.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/Posture: rates are an internal accounting concept \(cost-to-serve\);/);
    expect(p).toMatch(/they do NOT drive customer pricing\. Pricing lives in/);
    expect(p).toMatch(/`packages\/api-types` \(tier configs\) \+ the Stripe price-list\. These/);
    expect(p).toMatch(/numbers anchor the V-541 cost-monitoring alerting only\./);
  });

  // ─── DEFAULT_COST_RATES source-spreadsheet framing ───────────

  it("CRITICAL DEFAULT_COST_RATES source-spreadsheet framing — 'V-541.F — production cost rates. Currency: EUR cents. Source spreadsheet: docs/internal/v541-cost-monitoring-design.md, Default rate card v1 (W44 review). Rates re-reviewed quarterly against actual invoices from Hetzner / Cloudflare R2 / Postmark / OpenAI; bump this constant + add an entry to the cost-monitoring runbook when a sub-processor price changes meaningfully'. The quarterly-review + invoice-anchor + runbook-update design is the rate-maintenance contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/V-541\.F — production cost rates\. Currency: EUR cents\./);
    expect(p).toMatch(/Source spreadsheet: `docs\/internal\/v541-cost-monitoring-design\.md`,/);
    expect(p).toMatch(/"Default rate card v1 \(W44 review\)\." Rates re-reviewed quarterly/);
    expect(p).toMatch(/against actual invoices from Hetzner \/ Cloudflare R2 \/ Postmark \//);
    expect(p).toMatch(/OpenAI; bump this constant \+ add an entry to the cost-monitoring/);
    expect(p).toMatch(/runbook when a sub-processor price changes meaningfully\./);
  });

  // ─── DEFAULT_COST_RATES 6-rate inventory ─────────────────────

  it('CRITICAL DEFAULT_COST_RATES has 6 rates with V-541.F-anchored values. The 6-rate set covers compute + storage + egress + email + LLM input + LLM output cost-to-serve dimensions.', () => {
    expect(DEFAULT_COST_RATES.computeCentsPerMinute).toBe(0.05);
    expect(DEFAULT_COST_RATES.storageCentsPerGbMonth).toBe(1.5);
    expect(DEFAULT_COST_RATES.egressCentsPerGb).toBe(5);
    expect(DEFAULT_COST_RATES.emailCentsPerSend).toBe(0.1);
    expect(DEFAULT_COST_RATES.llmCentsPer1kInputTokens).toBe(0.5);
    expect(DEFAULT_COST_RATES.llmCentsPer1kOutputTokens).toBe(2.5);
  });

  it("CRITICAL compute-rate framing — '// Hetzner CCX13 averaged across the fleet, divided by minutes-per-month.' + 0.05 cents/min. The Hetzner-CCX13-fleet-averaged framing is the compute-rate provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/Hetzner CCX13 averaged across the fleet, divided by minutes-per-month\./);
    expect(p).toMatch(/computeCentsPerMinute: 0\.05,/);
  });

  it("CRITICAL storage-rate framing — '// R2 €0.015/GB-month list price.' + 1.5 cents/GB-month. The R2-list-price framing is the storage-rate provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/R2 €0\.015\/GB-month list price\./);
    expect(p).toMatch(/storageCentsPerGbMonth: 1\.5,/);
  });

  it("CRITICAL egress-rate framing — '// TURN egress €0.05/GB after V-531 free-tier discount.' + 5 cents/GB. The V-531-discount framing is the egress-rate provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/TURN egress €0\.05\/GB after V-531 free-tier discount\./);
    expect(p).toMatch(/egressCentsPerGb: 5,/);
  });

  it("CRITICAL email-rate framing — '// Postmark transactional bulk rate, €0.001/send.' + 0.1 cents/send. The Postmark-bulk-rate framing is the email-rate provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/Postmark transactional bulk rate, €0\.001\/send\./);
    expect(p).toMatch(/emailCentsPerSend: 0\.1,/);
  });

  it('CRITICAL LLM-input-rate framing — Anthropic Claude Opus 4.7 list price ($5/1M = 0.5c/1k) + 0.5 cents/1k tokens. The Opus-4.7-$5/1M framing is the LLM-input-rate provenance (corrected from the 4o-mini under-estimate, #15).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/\/\/ Anthropic Claude Opus 4\.7 list price \(the model the agent actually/);
    expect(p).toMatch(/\$5\/1M input = 0\.5c\/1k\./);
    expect(p).toMatch(/llmCentsPer1kInputTokens: 0\.5,/);
  });

  it('CRITICAL LLM-output-rate framing — Anthropic Claude Opus 4.7 list price ($25/1M = 2.5c/1k) + 2.5 cents/1k tokens. The Opus-4.7-$25/1M framing is the LLM-output-rate provenance (corrected from the 4o-mini under-estimate, #15).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/Anthropic Claude Opus 4\.7 list price — \$25\/1M output = 2\.5c\/1k\./);
    expect(p).toMatch(/llmCentsPer1kOutputTokens: 2\.5,/);
  });

  // ─── TIER_MONTHLY_PRICE_CENTS 6-tier inventory ───────────────

  it('CRITICAL TIER_MONTHLY_PRICE_CENTS is Partial<Record<AccountTier, number>>. The Partial<...> shape is what makes future-tier additions (e.g. api_pro) safe without requiring an entry here.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(
      /export const TIER_MONTHLY_PRICE_CENTS: Partial<Record<AccountTier, number>> = \{/,
    );
  });

  it('CRITICAL TIER_MONTHLY_PRICE_CENTS has 6 priced tiers — solo_manual 7900 + team_manual 24900 + agency_manual 69900 + api_starter 14900 + api_builder 49900 + api_scale 149900. The 6-tier price-card matches billing-crypto TIER_PRICE_CENTS + the customer-facing tier matrix ($/mo).', () => {
    expect(TIER_MONTHLY_PRICE_CENTS.solo_manual).toBe(7900);
    expect(TIER_MONTHLY_PRICE_CENTS.team_manual).toBe(24900);
    expect(TIER_MONTHLY_PRICE_CENTS.agency_manual).toBe(69900);
    expect(TIER_MONTHLY_PRICE_CENTS.api_starter).toBe(14900);
    expect(TIER_MONTHLY_PRICE_CENTS.api_builder).toBe(49900);
    expect(TIER_MONTHLY_PRICE_CENTS.api_scale).toBe(149900);
  });

  it('CRITICAL TIER_MONTHLY_PRICE_CENTS === billing-crypto TIER_PRICE_CENTS for all 6 paid tiers — the two price sources MUST agree. Pricing-as-data routes the crypto quote + charge through PricingService.listEffective(), which falls back to TIER_MONTHLY_PRICE_CENTS (and migration 0067 seeds the same figures), while TIER_PRICE_CENTS drives the crypto SUPPORTED_PRODUCTS list. They were "previously" divergent (a past under-quote bug); enforcing equality (not just the prose claim above) stops a future edit of one constant from silently diverging the charged price from the crypto price map.', () => {
    const PAID_TIERS = [
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
    ] as const;
    for (const tier of PAID_TIERS) {
      expect(TIER_MONTHLY_PRICE_CENTS[tier]).toBe(TIER_PRICE_CENTS[tier]);
    }
    // Both constants cover exactly the same paid-tier set (no tier priced in
    // one but missing from the other).
    expect(Object.keys(TIER_PRICE_CENTS).sort()).toEqual([...PAID_TIERS].sort());
    expect(
      Object.keys(TIER_MONTHLY_PRICE_CENTS)
        .filter(
          (t) => TIER_MONTHLY_PRICE_CENTS[t as keyof typeof TIER_MONTHLY_PRICE_CENTS] !== undefined,
        )
        .sort(),
    ).toEqual([...PAID_TIERS].sort());
  });

  it("CRITICAL future-tier api_pro placeholder framing — 'tiers not on Stripe (e.g. the future api_pro tier) get a placeholder so the derive helper doesn't break'. The placeholder design keeps the derive-helper total-coverage even when a tier is not-yet-priced.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/tiers/);
    expect(p).toMatch(/not on Stripe \(e\.g\. the future api_pro tier\) get a placeholder/);
    expect(p).toMatch(/so the derive helper doesn't break\./);
  });

  // ─── deriveThresholdsFromMonthlyPrice formula ────────────────

  it("CRITICAL deriveThresholdsFromMonthlyPrice formula — 'softCents = round(P × 0.6), hardCents = round(P × 0.9)'. The 60%/90% multiplier pair is the V-541.F runbook formula.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/softCents: Math\.round\(monthlyPriceCents \* 0\.6\),/);
    expect(p).toMatch(/hardCents: Math\.round\(monthlyPriceCents \* 0\.9\),/);
  });

  it("CRITICAL runbook-anchor framing — 'Soft = approaching the operator-tolerated cost ceiling. Hard = 10% margin between cost-to-serve and revenue. The runbook (docs/runbooks/cost-monitoring.md) documents this rationale; tweaking the multipliers means editing both this file AND the runbook so the operator's interpretation stays in sync'. The 60%-soft + 90%-hard + edit-both-or-drift design is the V-541.F cross-source contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/Soft = "approaching the operator-tolerated cost ceiling\."/);
    expect(p).toMatch(/Hard = "10% margin between cost-to-serve and revenue\."/);
    expect(p).toMatch(/The runbook \(`docs\/runbooks\/cost-monitoring\.md`\) documents this/);
    expect(p).toMatch(/rationale; tweaking the multipliers means editing both this file/);
    expect(p).toMatch(/AND the runbook so the operator's interpretation stays in sync\./);
  });

  // ─── Runtime — deriveThresholdsFromMonthlyPrice ──────────────

  it('CRITICAL runtime — deriveThresholdsFromMonthlyPrice rounds to integer cents — P=10000 → {softCents:6000, hardCents:9000}.', () => {
    expect(deriveThresholdsFromMonthlyPrice(10000)).toEqual({ softCents: 6000, hardCents: 9000 });
  });

  it('CRITICAL runtime — deriveThresholdsFromMonthlyPrice rounds half-up at integer boundaries — P=1 → soft=Math.round(0.6)=1, hard=Math.round(0.9)=1. The Math.round is what prevents fractional-cent thresholds.', () => {
    expect(deriveThresholdsFromMonthlyPrice(1)).toEqual({ softCents: 1, hardCents: 1 });
    expect(deriveThresholdsFromMonthlyPrice(5000)).toEqual({ softCents: 3000, hardCents: 4500 });
  });

  // ─── DEFAULT_TIER_THRESHOLDS_DERIVED ─────────────────────────

  it('CRITICAL DEFAULT_TIER_THRESHOLDS_DERIVED is built via Object.fromEntries(Object.entries(TIER_MONTHLY_PRICE_CENTS).map(...)). The Object.fromEntries-of-derive maps each priced tier 1:1 to a {softCents, hardCents} pair.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(
      /export const DEFAULT_TIER_THRESHOLDS_DERIVED: Record<string, AlertThresholds> = Object\.fromEntries\(/,
    );
    expect(p).toMatch(
      /Object\.entries\(TIER_MONTHLY_PRICE_CENTS\)\.map\(\(\[tier, price\]\) => \[/,
    );
    expect(p).toMatch(/tier,/);
    expect(p).toMatch(/deriveThresholdsFromMonthlyPrice\(price\),/);
  });

  it('CRITICAL runtime — DEFAULT_TIER_THRESHOLDS_DERIVED has 6 entries matching TIER_MONTHLY_PRICE_CENTS. Each entry is the 60%/90% derived threshold pair.', () => {
    expect(Object.keys(DEFAULT_TIER_THRESHOLDS_DERIVED).length).toBe(6);
    expect(DEFAULT_TIER_THRESHOLDS_DERIVED.solo_manual).toEqual({
      softCents: 4740,
      hardCents: 7110,
    });
    expect(DEFAULT_TIER_THRESHOLDS_DERIVED.team_manual).toEqual({
      softCents: 14940,
      hardCents: 22410,
    });
    expect(DEFAULT_TIER_THRESHOLDS_DERIVED.agency_manual).toEqual({
      softCents: 41940,
      hardCents: 62910,
    });
    expect(DEFAULT_TIER_THRESHOLDS_DERIVED.api_starter).toEqual({
      softCents: 8940,
      hardCents: 13410,
    });
    expect(DEFAULT_TIER_THRESHOLDS_DERIVED.api_builder).toEqual({
      softCents: 29940,
      hardCents: 44910,
    });
    expect(DEFAULT_TIER_THRESHOLDS_DERIVED.api_scale).toEqual({
      softCents: 89940,
      hardCents: 134910,
    });
  });

  // ─── Derived-vs-hand-tuned framing ───────────────────────────

  it("CRITICAL derived-vs-hand-tuned framing — 'Compared with the in-estimator DEFAULT_TIER_THRESHOLDS, this map is derived (price-driven) rather than hand-tuned. Both are intentionally kept around: the estimator's defaults exist so the pure module is self-contained, this map exists so production wiring is anchored to tier pricing'. The derived-here + hand-tuned-in-estimator + both-on-purpose design is the V-658 + V-541.F decoupling rationale.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts'));
    expect(p).toMatch(/Compared with the in-estimator DEFAULT_TIER_THRESHOLDS, this map/);
    expect(p).toMatch(/is derived \(price-driven\) rather than hand-tuned\. Both are/);
    expect(p).toMatch(/intentionally kept around: the estimator's defaults exist so the/);
    expect(p).toMatch(/pure module is self-contained, this map exists so production/);
    expect(p).toMatch(/wiring is anchored to tier pricing\./);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/cost-defaults-v541f-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
