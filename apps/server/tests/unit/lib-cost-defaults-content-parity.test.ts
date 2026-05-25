// W390.C — drift guard for apps/server/src/lib/cost-defaults.ts.
// V-541.F — production defaults for cost rates + tier thresholds.
// Numbers anchor V-541 cost-monitoring alerting (NOT customer
// pricing). The 6-rate card + 6-tier monthly-price map + 0.6/0.9
// soft/hard multipliers are the "what we actually deploy" anchors;
// drift here re-classifies every account silently.
//
//   • V-541.F framing pinned (production defaults, EUR cents).
//   • Posture: rates do NOT drive customer pricing (cost-to-serve only).
//   • DEFAULT_COST_RATES 6 fields with EUR-cent numeric values pinned.
//   • TIER_MONTHLY_PRICE_CENTS: 6 self-serve tiers (Partial<Record>).
//   • deriveThresholdsFromMonthlyPrice: 0.6 soft + 0.9 hard multipliers.
//   • runbook docstring framing: tweak multipliers → edit BOTH file +
//     runbook so operator interpretation stays in sync.
//   • DEFAULT_TIER_THRESHOLDS_DERIVED: Object.fromEntries from the
//     price map (price-driven vs estimator's hand-tuned defaults).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/cost-defaults.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W390.C apps/server/src/lib/cost-defaults.ts content parity', () => {
  const body = read(LIB);

  it('V-541.F framing pinned (production defaults, centralised — one edit + runbook entry)', () => {
    expect(body).toMatch(/V-541\.F — production defaults for cost rates \+ tier thresholds\./);
    expect(body).toMatch(
      /Production wiring needs concrete defaults; before this module they\s*\n?\s*\/\/\s*lived as inline literals in tests \/ fixtures, which drifts the\s*\n?\s*\/\/\s*"what we actually deploy" from "what we test\." Centralising them\s*\n?\s*\/\/\s*here means a rate change is one edit \+ a runbook entry/,
    );
  });

  it('Posture framing: rates are cost-to-serve, NOT customer pricing (pricing lives in api-types + Stripe)', () => {
    expect(body).toMatch(
      /Posture: rates are an internal accounting concept \(cost-to-serve\);\s*\n?\s*\/\/\s*they do NOT drive customer pricing\. Pricing lives in\s*\n?\s*\/\/\s*`packages\/api-types` \(tier configs\) \+ the Stripe price-list/,
    );
  });

  it('DEFAULT_COST_RATES: 6 fields with EUR-cent numeric values pinned', () => {
    expect(body).toMatch(/export const DEFAULT_COST_RATES: CostRates = \{/);
    expect(body).toMatch(/computeCentsPerMinute: 0\.05,/);
    expect(body).toMatch(/storageCentsPerGbMonth: 1\.5,/);
    expect(body).toMatch(/egressCentsPerGb: 5,/);
    expect(body).toMatch(/emailCentsPerSend: 0\.1,/);
    expect(body).toMatch(/llmCentsPer1kInputTokens: 0\.015,/);
    expect(body).toMatch(/llmCentsPer1kOutputTokens: 0\.06,/);
  });

  it('DEFAULT_COST_RATES: provenance comments pinned (Hetzner CCX13 / R2 €0.015 / TURN €0.05 / Postmark €0.001 / OpenAI 4o-mini)', () => {
    expect(body).toMatch(
      /\/\/ Hetzner CCX13 averaged across the fleet, divided by minutes-per-month\./,
    );
    expect(body).toMatch(/\/\/ R2 €0\.015\/GB-month list price\./);
    expect(body).toMatch(/\/\/ TURN egress €0\.05\/GB after V-531 free-tier discount\./);
    expect(body).toMatch(/\/\/ Postmark transactional bulk rate, €0\.001\/send\./);
    expect(body).toMatch(/\/\/ OpenAI 4o-mini input list price ~€0\.15\/1M = 0\.015c\/1k\./);
    expect(body).toMatch(/\/\/ OpenAI 4o-mini output list price ~€0\.60\/1M = 0\.06c\/1k\./);
  });

  it('TIER_MONTHLY_PRICE_CENTS: 6 self-serve tiers with cents values (Partial<Record<AccountTier>>)', () => {
    expect(body).toMatch(
      /export const TIER_MONTHLY_PRICE_CENTS: Partial<Record<AccountTier, number>> = \{/,
    );
    expect(body).toMatch(/solo_manual: 7900, \/\/ \$79\/mo/);
    expect(body).toMatch(/team_manual: 24900, \/\/ \$249\/mo/);
    expect(body).toMatch(/agency_manual: 69900, \/\/ \$699\/mo/);
    expect(body).toMatch(/api_starter: 14900, \/\/ \$149\/mo/);
    expect(body).toMatch(/api_builder: 49900, \/\/ \$499\/mo/);
    expect(body).toMatch(/api_scale: 149900, \/\/ \$1,499\/mo/);
  });

  it('deriveThresholdsFromMonthlyPrice: 0.6 soft + 0.9 hard multipliers (runbook formula)', () => {
    expect(body).toMatch(
      /V-541\.F — derive \(softCents, hardCents\) from a tier's monthly\s*\n?\s*\*\s*subscription price using the runbook formula:[\s\S]+?softCents = round\(P × 0\.6\)[\s\S]+?hardCents = round\(P × 0\.9\)/,
    );
    expect(body).toMatch(/Soft = "approaching the operator-tolerated cost ceiling\."/);
    expect(body).toMatch(/Hard = "10% margin between cost-to-serve and revenue\."/);
    expect(body).toMatch(
      /export function deriveThresholdsFromMonthlyPrice\(monthlyPriceCents: number\): AlertThresholds \{\s*\n?\s*return \{\s*\n?\s*softCents: Math\.round\(monthlyPriceCents \* 0\.6\),\s*\n?\s*hardCents: Math\.round\(monthlyPriceCents \* 0\.9\),\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('runbook-sync framing: tweaking multipliers requires editing BOTH file + runbook', () => {
    expect(body).toMatch(
      /The runbook \(`docs\/runbooks\/cost-monitoring\.md`\) documents this\s*\n?\s*\*\s*rationale; tweaking the multipliers means editing both this file\s*\n?\s*\*\s*AND the runbook so the operator's interpretation stays in sync/,
    );
  });

  it('DEFAULT_TIER_THRESHOLDS_DERIVED: Object.fromEntries map over TIER_MONTHLY_PRICE_CENTS (price-driven, not hand-tuned)', () => {
    expect(body).toMatch(
      /export const DEFAULT_TIER_THRESHOLDS_DERIVED: Record<string, AlertThresholds> = Object\.fromEntries\(\s*\n?\s*Object\.entries\(TIER_MONTHLY_PRICE_CENTS\)\.map\(\(\[tier, price\]\) => \[\s*\n?\s*tier,\s*\n?\s*deriveThresholdsFromMonthlyPrice\(price\),\s*\n?\s*\]\),\s*\n?\s*\);/,
    );
  });

  it('both-defaults-kept framing: estimator hand-tuned vs cost-defaults price-driven (intentional)', () => {
    expect(body).toMatch(
      /Compared with the in-estimator DEFAULT_TIER_THRESHOLDS, this map\s*\n?\s*\*\s*is derived \(price-driven\) rather than hand-tuned\. Both are\s*\n?\s*\*\s*intentionally kept around: the estimator's defaults exist so the\s*\n?\s*\*\s*pure module is self-contained, this map exists so production\s*\n?\s*\*\s*wiring is anchored to tier pricing/,
    );
  });

  it('imports: AccountTier type from @driftstack/api-types + AlertThresholds + CostRates from ./cost-estimator.js', () => {
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
    expect(body).toMatch(
      /import type \{ AlertThresholds, CostRates \} from '\.\/cost-estimator\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
