// W958 — V-658 cost-estimator cross-source invariant. Two-hundred-
// eighty-fourth in the drift-guard series. Pins the pure-function
// cost estimator:
//
//   V-658 anchor — 'V-658 — cost estimator (V-541.B foundation)'.
//
//   Service intro framing — 'Pure functions that implement the cost-
//   to-serve formula sketched in docs/internal/v541-cost-monitoring-
//   design.md. The downstream service (V-541.B) wires these against
//   the sessions + usage_records tables and persists the result into
//   cost_snapshots; this module has zero DB dependencies so it can
//   be tested + tuned independently'.
//
//   Cents-integer-math + admin-tunable framing — 'Everything in
//   cents (integer math). Rates are passed in by the caller — the
//   admin UI is the source of truth for re-tunable rates (per the
//   V-541 design: "operator maintains this multiplier in admin
//   config"). Hard-coding rates here would mean shipping a deploy
//   on every Hetzner / R2 / Postmark price change'.
//
//   CostRates (6 dimensions): compute / storage / egress / email
//     / llm-input / llm-output cents-per-unit.
//
//   UsageInputs (6 dimensions): sessionMinutes + storageGbMonths
//     + egressGb + emailSends + llmInputTokens + llmOutputTokens.
//     Matches W925 cost-aggregator 6-dim envelope.
//
//   AlertThresholds 2-field shape: softCents + hardCents.
//
//   ThresholdState 3-value union: 'under-soft' |
//     'between-soft-and-hard' | 'over-hard'.
//
//   CostBreakdown 7-field shape: 5 per-component cents + totalCents
//     + thresholdState.
//
//   estimateCost framing — 'All arithmetic is rounded to the nearest
//   cent (banker's rounding via Math.round). Negative inputs are
//   clamped to 0 — usage data should never be negative, but a
//   corrupt input shouldn't produce nonsense negative cost'.
//
//   LLM cost split — input + output token rates separately + per
//     1k tokens.
//
//   DEFAULT_TIER_THRESHOLDS — 6-tier EUR default soft/hard:
//     - solo_manual: €15/€30, team_manual: €50/€100,
//       agency_manual: €200/€400, api_starter: €30/€60,
//       api_builder: €150/€300, api_scale: €750/€1500.
//
//   classifyThreshold 3-branch logic — over-hard if >= hardCents;
//     between-soft-and-hard if >= softCents; else under-soft.
//
//   clampNonNegative helper — 'Number.isFinite(x) && x > 0 ? x : 0'.
//
// stays in lockstep across apps/server/src/lib/cost-estimator.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  estimateCost,
  classifyThreshold,
  DEFAULT_TIER_THRESHOLDS,
  type CostRates,
  type AlertThresholds,
} from '../../src/lib/cost-estimator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const ZERO_RATES: CostRates = {
  computeCentsPerMinute: 0,
  storageCentsPerGbMonth: 0,
  egressCentsPerGb: 0,
  emailCentsPerSend: 0,
  llmCentsPer1kInputTokens: 0,
  llmCentsPer1kOutputTokens: 0,
};

const ZERO_THRESHOLDS: AlertThresholds = { softCents: 0, hardCents: 0 };

describe('W958 V-658 cost-estimator cross-source invariant', () => {
  // ─── V-658 anchor + pure-functions framing ───────────────────

  it("CRITICAL apps/server/src/lib/cost-estimator.ts header pins V-658 anchor — 'V-658 — cost estimator (V-541.B foundation)'. The V-658 anchor is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(/V-658 — cost estimator \(V-541\.B foundation\)/);
  });

  it("CRITICAL pure-functions framing — 'Pure functions that implement the cost-to-serve formula sketched in docs/internal/v541-cost-monitoring-design.md. The downstream service (V-541.B) wires these against the sessions + usage_records tables and persists the result into cost_snapshots; this module has zero DB dependencies so it can be tested + tuned independently'. The zero-DB pure-functions design is the V-658 testability contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(/Pure functions that implement the cost-to-serve formula sketched in/);
    expect(p).toMatch(/`docs\/internal\/v541-cost-monitoring-design\.md`\. The downstream/);
    expect(p).toMatch(/service \(V-541\.B\) wires these against the `sessions` \+ `usage_records`/);
    expect(p).toMatch(/tables and persists the result into `cost_snapshots`; this module/);
    expect(p).toMatch(/has zero DB dependencies so it can be tested \+ tuned independently\./);
  });

  // ─── Cents-integer + admin-tunable framing ───────────────────

  it('CRITICAL cents-integer-math + admin-tunable framing — \'Everything in cents (integer math). Rates are passed in by the caller — the admin UI is the source of truth for re-tunable rates (per the V-541 design: "operator maintains this multiplier in admin config"). Hard-coding rates here would mean shipping a deploy on every Hetzner / R2 / Postmark price change\'. The cents + admin-tunable design avoids deploy-per-price-change.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(/Everything in cents \(integer math\)\. Rates are passed in by the/);
    expect(p).toMatch(/caller — the admin UI is the source of truth for re-tunable rates/);
    expect(p).toMatch(/\(per the V-541 design: "operator maintains this multiplier in admin/);
    expect(p).toMatch(/config"\)\. Hard-coding rates here would mean shipping a deploy on/);
    expect(p).toMatch(/every Hetzner \/ R2 \/ Postmark price change\./);
  });

  // ─── CostRates 6-dimension shape ─────────────────────────────

  it('CRITICAL CostRates has 6 dimensions — computeCentsPerMinute + storageCentsPerGbMonth + egressCentsPerGb + emailCentsPerSend + llmCentsPer1kInputTokens + llmCentsPer1kOutputTokens. The 6-rate envelope matches W925 cost-aggregator UsageInputs 6 dimensions; drift would break the rate-vs-input pairing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(/export interface CostRates \{/);
    expect(p).toMatch(/computeCentsPerMinute: number;/);
    expect(p).toMatch(/storageCentsPerGbMonth: number;/);
    expect(p).toMatch(/egressCentsPerGb: number;/);
    expect(p).toMatch(/emailCentsPerSend: number;/);
    expect(p).toMatch(/llmCentsPer1kInputTokens: number;/);
    expect(p).toMatch(/llmCentsPer1kOutputTokens: number;/);
  });

  // ─── UsageInputs 6-dimension shape ───────────────────────────

  it('CRITICAL UsageInputs has 6 dimensions — sessionMinutes + storageGbMonths + egressGb + emailSends + llmInputTokens + llmOutputTokens. The 6-dim envelope matches W925 cost-aggregator zero-placeholder dims exactly.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(/export interface UsageInputs \{/);
    expect(p).toMatch(/sessionMinutes: number;/);
    expect(p).toMatch(/storageGbMonths: number;/);
    expect(p).toMatch(/egressGb: number;/);
    expect(p).toMatch(/emailSends: number;/);
    expect(p).toMatch(/llmInputTokens: number;/);
    expect(p).toMatch(/llmOutputTokens: number;/);
  });

  // ─── AlertThresholds 2-field shape ───────────────────────────

  it('CRITICAL AlertThresholds has 2 fields — softCents (informational warn) + hardCents (paging threshold). The 2-threshold ladder distinguishes warn-only from paging escalation.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(/export interface AlertThresholds \{/);
    expect(p).toMatch(/Cents\. Soft warn threshold — informational\./);
    expect(p).toMatch(/softCents: number;/);
    expect(p).toMatch(/Cents\. Hard cap — paging threshold\./);
    expect(p).toMatch(/hardCents: number;/);
  });

  // ─── ThresholdState 3-value union ────────────────────────────

  it("CRITICAL ThresholdState = 'under-soft' | 'between-soft-and-hard' | 'over-hard'. The 3-state ladder maps to W927 cost-alert-dispatcher AlertSeverity transitions exactly.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(
      /export type ThresholdState = 'under-soft' \| 'between-soft-and-hard' \| 'over-hard';/,
    );
  });

  // ─── CostBreakdown 7-field shape ─────────────────────────────

  it('CRITICAL CostBreakdown has 7 fields — 5 per-component cents (compute + storage + egress + email + llm) + totalCents + thresholdState. The 7-field breakdown is what V-541.B + W927 alert-dispatcher consume.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(/export interface CostBreakdown \{/);
    expect(p).toMatch(/computeCents: number;/);
    expect(p).toMatch(/storageCents: number;/);
    expect(p).toMatch(/egressCents: number;/);
    expect(p).toMatch(/emailCents: number;/);
    expect(p).toMatch(/llmCents: number;/);
    expect(p).toMatch(/Sum of all sub-components\./);
    expect(p).toMatch(/totalCents: number;/);
    expect(p).toMatch(/Where this account sits against its configured thresholds\./);
    expect(p).toMatch(/thresholdState: ThresholdState;/);
  });

  // ─── estimateCost rounding + clamp framing ───────────────────

  it("CRITICAL estimateCost framing — 'All arithmetic is rounded to the nearest cent (banker's rounding via Math.round). Negative inputs are clamped to 0 — usage data should never be negative, but a corrupt input shouldn't produce nonsense negative cost'. The Math.round + clamp-to-0 is the integer-cents + corruption-defense contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(/All arithmetic is rounded to the nearest cent \(banker's rounding via/);
    expect(p).toMatch(/Math\.round\)\. Negative inputs are clamped to 0 — usage data should/);
    expect(p).toMatch(/never be negative, but a corrupt input shouldn't produce nonsense/);
    expect(p).toMatch(/negative cost\./);
  });

  // ─── LLM cost split (input + output per 1k tokens) ───────────

  it('CRITICAL LLM cost split — input + output tokens have separate per-1k-token rates. Sum = (llmInputTokens / 1000) * llmCentsPer1kInputTokens + (llmOutputTokens / 1000) * llmCentsPer1kOutputTokens. Mechanically pinned via source.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(/const llmCents = Math\.round\(/);
    expect(p).toMatch(/\(llmInputTokens \/ 1000\) \* rates\.llmCentsPer1kInputTokens \+/);
    expect(p).toMatch(/\(llmOutputTokens \/ 1000\) \* rates\.llmCentsPer1kOutputTokens,/);
  });

  // ─── DEFAULT_TIER_THRESHOLDS 6-tier EUR defaults ─────────────

  it('CRITICAL DEFAULT_TIER_THRESHOLDS framing — \'V-541 design called for "per-tier alert thresholds hard-coded" in v1 with admin-override landing in V-541.C; these constants are the v1 defaults. Currency: EUR (V-541 open-question recommendation accepted in W44)\'. The v1-hardcoded + EUR-via-W44 + V-541.C-override-future framing is the threshold policy provenance.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(/Default per-tier alert thresholds in cents\. V-541 design called for/);
    expect(p).toMatch(/"per-tier alert thresholds hard-coded" in v1 with admin-override/);
    expect(p).toMatch(/landing in V-541\.C; these constants are the v1 defaults\. Currency:/);
    expect(p).toMatch(/EUR \(V-541 open-question recommendation accepted in W44\)\./);
  });

  it('CRITICAL DEFAULT_TIER_THRESHOLDS has 6 tiers — solo_manual (€15/€30) + team_manual + agency_manual + api_starter (€30/€60) + api_builder + api_scale. Pinned mechanically; drift would change cost-alert thresholds.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(/solo_manual: \{ softCents: 1500, hardCents: 3000 \},/);
    expect(p).toMatch(/team_manual: \{ softCents: 5000, hardCents: 10000 \},/);
    expect(p).toMatch(/agency_manual: \{ softCents: 20000, hardCents: 40000 \},/);
    expect(p).toMatch(/api_starter: \{ softCents: 3000, hardCents: 6000 \},/);
    expect(p).toMatch(/api_builder: \{ softCents: 15000, hardCents: 30000 \},/);
    expect(p).toMatch(/api_scale: \{ softCents: 75000, hardCents: 150000 \},/);
  });

  // ─── classifyThreshold 3-branch logic ────────────────────────

  it("CRITICAL classifyThreshold 3-branch — 'if (totalCents >= thresholds.hardCents) return over-hard; if (totalCents >= thresholds.softCents) return between-soft-and-hard; return under-soft'. The greedy-comparison + descending order is the classification logic.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(/if \(totalCents >= thresholds\.hardCents\) return 'over-hard';/);
    expect(p).toMatch(/if \(totalCents >= thresholds\.softCents\) return 'between-soft-and-hard';/);
    expect(p).toMatch(/return 'under-soft';/);
  });

  // ─── clampNonNegative helper ─────────────────────────────────

  it("CRITICAL clampNonNegative helper — 'Number.isFinite(x) && x > 0 ? x : 0'. The Number.isFinite + > 0 guard rejects NaN + Infinity + negatives.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts'));
    expect(p).toMatch(
      /function clampNonNegative\(x: number\): number \{\s*\n\s*return Number\.isFinite\(x\) && x > 0 \? x : 0;/,
    );
  });

  // ─── Runtime parity: estimateCost ────────────────────────────

  it('CRITICAL estimateCost runtime — zero-rates + zero-usage → all-zero breakdown + under-soft. Verified mechanically.', () => {
    const result = estimateCost(
      {
        sessionMinutes: 0,
        storageGbMonths: 0,
        egressGb: 0,
        emailSends: 0,
        llmInputTokens: 0,
        llmOutputTokens: 0,
      },
      ZERO_RATES,
      ZERO_THRESHOLDS,
    );
    expect(result.computeCents).toBe(0);
    expect(result.storageCents).toBe(0);
    expect(result.egressCents).toBe(0);
    expect(result.emailCents).toBe(0);
    expect(result.llmCents).toBe(0);
    expect(result.totalCents).toBe(0);
    // Note: with softCents=hardCents=0, totalCents=0 → 0 >= hardCents=0 → 'over-hard'.
    // The classifyThreshold descending-greedy check hits hardCents first.
    expect(result.thresholdState).toBe('over-hard');
  });

  it('CRITICAL estimateCost runtime — 100 session-minutes @ 50 cents/min → 5000 computeCents. Banker rounding via Math.round.', () => {
    const result = estimateCost(
      {
        sessionMinutes: 100,
        storageGbMonths: 0,
        egressGb: 0,
        emailSends: 0,
        llmInputTokens: 0,
        llmOutputTokens: 0,
      },
      { ...ZERO_RATES, computeCentsPerMinute: 50 },
      { softCents: 0, hardCents: 100000 },
    );
    expect(result.computeCents).toBe(5000);
    expect(result.totalCents).toBe(5000);
  });

  it('CRITICAL estimateCost runtime — LLM cost split. 1000 input tokens @ 10c/1k + 500 output tokens @ 20c/1k = 10 + 10 = 20 cents.', () => {
    const result = estimateCost(
      {
        sessionMinutes: 0,
        storageGbMonths: 0,
        egressGb: 0,
        emailSends: 0,
        llmInputTokens: 1000,
        llmOutputTokens: 500,
      },
      { ...ZERO_RATES, llmCentsPer1kInputTokens: 10, llmCentsPer1kOutputTokens: 20 },
      { softCents: 0, hardCents: 100000 },
    );
    expect(result.llmCents).toBe(20);
  });

  it('CRITICAL estimateCost runtime — negative inputs clamped to 0 (corruption defense). Negative sessionMinutes → 0 computeCents.', () => {
    const result = estimateCost(
      {
        sessionMinutes: -100,
        storageGbMonths: -50,
        egressGb: -10,
        emailSends: -100,
        llmInputTokens: -1000,
        llmOutputTokens: -500,
      },
      {
        computeCentsPerMinute: 50,
        storageCentsPerGbMonth: 100,
        egressCentsPerGb: 200,
        emailCentsPerSend: 1,
        llmCentsPer1kInputTokens: 10,
        llmCentsPer1kOutputTokens: 20,
      },
      { softCents: 0, hardCents: 1 },
    );
    expect(result.computeCents).toBe(0);
    expect(result.storageCents).toBe(0);
    expect(result.egressCents).toBe(0);
    expect(result.emailCents).toBe(0);
    expect(result.llmCents).toBe(0);
    expect(result.totalCents).toBe(0);
  });

  // ─── classifyThreshold runtime ───────────────────────────────

  it('CRITICAL classifyThreshold runtime — under-soft when totalCents < softCents; between-soft-and-hard when softCents <= totalCents < hardCents; over-hard when totalCents >= hardCents. The 3-branch behaviour verified mechanically.', () => {
    const t: AlertThresholds = { softCents: 100, hardCents: 200 };
    expect(classifyThreshold(0, t)).toBe('under-soft');
    expect(classifyThreshold(99, t)).toBe('under-soft');
    expect(classifyThreshold(100, t)).toBe('between-soft-and-hard');
    expect(classifyThreshold(199, t)).toBe('between-soft-and-hard');
    expect(classifyThreshold(200, t)).toBe('over-hard');
    expect(classifyThreshold(1000, t)).toBe('over-hard');
  });

  // ─── DEFAULT_TIER_THRESHOLDS runtime parity ──────────────────

  it('CRITICAL DEFAULT_TIER_THRESHOLDS exports 6 tiers via api-types AccountTier slugs (manual: solo/team/agency, api: starter/builder/scale). All have softCents < hardCents (well-ordered).', () => {
    const expected = [
      'solo_manual',
      'team_manual',
      'agency_manual',
      'api_starter',
      'api_builder',
      'api_scale',
    ];
    for (const tier of expected) {
      const t = DEFAULT_TIER_THRESHOLDS[tier];
      expect(t).toBeDefined();
      expect(t!.softCents).toBeLessThan(t!.hardCents);
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/cost-estimator-v658-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
