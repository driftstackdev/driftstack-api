// W390.B — drift guard for apps/server/src/lib/cost-estimator.ts.
// V-658 (V-541.B foundation) — pure cost-to-serve estimator. Zero DB
// dependencies so tests + tooling can sweep alternative configs. The
// 6-line-item breakdown shape + threshold-state taxonomy is consumed
// by the admin cost-monitoring service and the cost panel
// (V-534.G); drift here re-classifies accounts silently.
//
//   • V-658 / V-541.B framing pinned.
//   • Rates passed in by caller (admin UI is source of truth — V-541
//     design "operator maintains this multiplier in admin config").
//   • All arithmetic in cents (integer math) + round-half-up via
//     Math.round + negative-input clamping.
//   • CostRates: 6 fields (compute / storage / egress / email / LLM
//     input / LLM output).
//   • UsageInputs: 6 mirror fields.
//   • AlertThresholds: softCents + hardCents.
//   • ThresholdState: 3-literal union (under-soft / between-soft-and-
//     hard / over-hard).
//   • CostBreakdown: 5 sub-cents + totalCents + thresholdState.
//   • classifyThreshold: >=hard → over-hard, >=soft → between, else
//     under-soft.
//   • clampNonNegative: Number.isFinite + > 0 guard.
//   • DEFAULT_TIER_THRESHOLDS: 6 tier × (softCents, hardCents).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/cost-estimator.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W390.B apps/server/src/lib/cost-estimator.ts content parity', () => {
  const body = read(LIB);

  it('V-658 + V-541.B framing pinned in module comment', () => {
    expect(body).toMatch(/V-658 — cost estimator \(V-541\.B foundation\)\./);
    expect(body).toMatch(/docs\/internal\/v541-cost-monitoring-design\.md/);
  });

  it('zero-DB-dependencies framing pinned (so the estimator can be tested/tuned independently)', () => {
    expect(body).toMatch(
      /this module\s*\/\/\s*has zero DB dependencies so it can be tested \+ tuned independently/,
    );
  });

  it('cents-integer-math framing: "Everything in cents (integer math)"', () => {
    expect(body).toMatch(
      /Everything in cents \(integer math\)\. Rates are passed in by the\s*\/\/\s*caller — the admin UI is the source of truth for re-tunable rates/,
    );
    expect(body).toMatch(
      /Hard-coding rates here would mean shipping a deploy on\s*\/\/\s*every Hetzner \/ R2 \/ Postmark price change/,
    );
  });

  it('CostRates: 6 fields (compute / storage / egress / email / LLM input / LLM output)', () => {
    expect(body).toMatch(/export interface CostRates \{/);
    expect(body).toMatch(/Cents per Mac mini compute-minute\./);
    expect(body).toMatch(/computeCentsPerMinute: number;/);
    expect(body).toMatch(/Cents per GB-month of R2 storage\./);
    expect(body).toMatch(/storageCentsPerGbMonth: number;/);
    expect(body).toMatch(/Cents per GB of TURN egress \(post-V-531\)\./);
    expect(body).toMatch(/egressCentsPerGb: number;/);
    expect(body).toMatch(/Cents per Postmark transactional email sent\./);
    expect(body).toMatch(/emailCentsPerSend: number;/);
    expect(body).toMatch(/Cents per 1k LLM input tokens \(sub-processor v1 — pass-through\)\./);
    expect(body).toMatch(/llmCentsPer1kInputTokens: number;/);
    expect(body).toMatch(/Cents per 1k LLM output tokens\./);
    expect(body).toMatch(/llmCentsPer1kOutputTokens: number;/);
  });

  it('UsageInputs: 6 fields mirroring CostRates', () => {
    expect(body).toMatch(/export interface UsageInputs \{/);
    expect(body).toMatch(/sessionMinutes: number;/);
    expect(body).toMatch(/storageGbMonths: number;/);
    expect(body).toMatch(/egressGb: number;/);
    expect(body).toMatch(/emailSends: number;/);
    expect(body).toMatch(/llmInputTokens: number;/);
    expect(body).toMatch(/llmOutputTokens: number;/);
  });

  it('AlertThresholds: softCents (informational) + hardCents (paging)', () => {
    expect(body).toMatch(/export interface AlertThresholds \{/);
    expect(body).toMatch(/Cents\. Soft warn threshold — informational\./);
    expect(body).toMatch(/softCents: number;/);
    expect(body).toMatch(/Cents\. Hard cap — paging threshold\./);
    expect(body).toMatch(/hardCents: number;/);
  });

  it('ThresholdState: 3-literal union (under-soft | between-soft-and-hard | over-hard)', () => {
    expect(body).toMatch(
      /export type ThresholdState = 'under-soft' \| 'between-soft-and-hard' \| 'over-hard';/,
    );
  });

  it('CostBreakdown: 5 line-item cents + totalCents (sum) + thresholdState', () => {
    expect(body).toMatch(/export interface CostBreakdown \{/);
    expect(body).toMatch(/computeCents: number;/);
    expect(body).toMatch(/storageCents: number;/);
    expect(body).toMatch(/egressCents: number;/);
    expect(body).toMatch(/emailCents: number;/);
    expect(body).toMatch(/llmCents: number;/);
    expect(body).toMatch(/Sum of all sub-components\./);
    expect(body).toMatch(/totalCents: number;/);
    expect(body).toMatch(/Where this account sits against its configured thresholds\./);
    expect(body).toMatch(/thresholdState: ThresholdState;/);
  });

  it("estimateCost: round-half-up (Math.round, NOT banker's) + negative-input clamping framing", () => {
    expect(body).toMatch(/rounded to the nearest cent via `Math\.round`/);
    expect(body).toMatch(/round-half-up \(ties round toward \+Infinity\), NOT banker's/);
    expect(body).toMatch(/Negative inputs are clamped to 0/);
  });

  it('estimateCost signature: (usage, rates, thresholds) → CostBreakdown', () => {
    expect(body).toMatch(
      /export function estimateCost\(\s*usage: UsageInputs,\s*rates: CostRates,\s*thresholds: AlertThresholds,\s*\): CostBreakdown/,
    );
  });

  it('estimateCost: 6 clampNonNegative inputs + 5 line-item Math.round computations + total sum', () => {
    expect(body).toMatch(/const sessionMinutes = clampNonNegative\(usage\.sessionMinutes\);/);
    expect(body).toMatch(/const storageGbMonths = clampNonNegative\(usage\.storageGbMonths\);/);
    expect(body).toMatch(/const egressGb = clampNonNegative\(usage\.egressGb\);/);
    expect(body).toMatch(/const emailSends = clampNonNegative\(usage\.emailSends\);/);
    expect(body).toMatch(/const llmInputTokens = clampNonNegative\(usage\.llmInputTokens\);/);
    expect(body).toMatch(/const llmOutputTokens = clampNonNegative\(usage\.llmOutputTokens\);/);
    expect(body).toMatch(
      /const computeCents = Math\.round\(sessionMinutes \* rates\.computeCentsPerMinute\);/,
    );
    expect(body).toMatch(
      /const storageCents = Math\.round\(storageGbMonths \* rates\.storageCentsPerGbMonth\);/,
    );
    expect(body).toMatch(/const egressCents = Math\.round\(egressGb \* rates\.egressCentsPerGb\);/);
    expect(body).toMatch(
      /const emailCents = Math\.round\(emailSends \* rates\.emailCentsPerSend\);/,
    );
    expect(body).toMatch(
      /const llmCents = Math\.round\(\s*\(llmInputTokens \/ 1000\) \* rates\.llmCentsPer1kInputTokens \+\s*\(llmOutputTokens \/ 1000\) \* rates\.llmCentsPer1kOutputTokens,\s*\);/,
    );
    expect(body).toMatch(
      /const totalCents = computeCents \+ storageCents \+ egressCents \+ emailCents \+ llmCents;/,
    );
  });

  it('classifyThreshold: >=hard → over-hard, >=soft → between, else under-soft', () => {
    expect(body).toMatch(
      /export function classifyThreshold\(totalCents: number, thresholds: AlertThresholds\): ThresholdState \{\s*if \(totalCents >= thresholds\.hardCents\) return 'over-hard';\s*if \(totalCents >= thresholds\.softCents\) return 'between-soft-and-hard';\s*return 'under-soft';\s*\}/,
    );
  });

  it('clampNonNegative: Number.isFinite + > 0 guard (NaN and negative both → 0)', () => {
    expect(body).toMatch(
      /function clampNonNegative\(x: number\): number \{\s*return Number\.isFinite\(x\) && x > 0 \? x : 0;\s*\}/,
    );
  });

  it('DEFAULT_TIER_THRESHOLDS: 6 self-serve tiers with hand-tuned cents', () => {
    expect(body).toMatch(
      /Default per-tier alert thresholds in cents\. V-541 design called for\s*\*\s*"per-tier alert thresholds hard-coded" in v1 with admin-override\s*\*\s*landing in V-541\.C/,
    );
    expect(body).toMatch(
      /Currency:\s*\*\s*EUR \(V-541 open-question recommendation accepted in W44\)/,
    );
    expect(body).toMatch(/solo_manual: \{ softCents: 1500, hardCents: 3000 \},/);
    expect(body).toMatch(/team_manual: \{ softCents: 5000, hardCents: 10000 \},/);
    expect(body).toMatch(/agency_manual: \{ softCents: 20000, hardCents: 40000 \},/);
    expect(body).toMatch(/api_starter: \{ softCents: 3000, hardCents: 6000 \},/);
    expect(body).toMatch(/api_builder: \{ softCents: 15000, hardCents: 30000 \},/);
    expect(body).toMatch(/api_scale: \{ softCents: 75000, hardCents: 150000 \},/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
