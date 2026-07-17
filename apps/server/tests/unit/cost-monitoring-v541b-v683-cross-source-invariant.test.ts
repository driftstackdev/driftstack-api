// W942 — V-541.B + V-683 cost-monitoring cross-source invariant.
// Two-hundred-sixty-eighth in the drift-guard series. Pins the
// admin-surface cost-monitoring service:
//
//   V-541.B anchor — 'cost-monitoring service. Compute-on-demand
//   per-account cost breakdown for the V-541 admin surface. Wraps
//   the V-658 estimator + a pluggable usage aggregator'.
//
//   V-541.B compute-on-demand posture:
//     - 'no persistence (no cost_snapshots table yet — V-541.C's
//       job). Every call recomputes from the underlying usage
//       data'.
//     - 'Cost-of-recompute is bounded by the per-account usage row
//       count, which is small enough that compute-on-demand is
//       acceptable for admin-tool use (one operator, occasional
//       queries)'.
//
//   UsageAggregator — 'Aggregate usage for a single account over
//     the requested billing cycle. Returns null when the account
//     doesn't exist or has no usage in the cycle'.
//
//   CostMonitoringAccountSummary (5 fields):
//     - account_id + billing_cycle + breakdown (CostBreakdown
//       from V-658) + tier + thresholds (AlertThresholds).
//
//   CostMonitoringServiceOpts (4 fields):
//     - aggregator + rates (CostRates) + tierThresholds (optional,
//       defaults to V-658 DEFAULT_TIER_THRESHOLDS) + resolveTier
//       (per-account tier-label fn).
//
//   V-683 getConfig() — 'return the rates + tier-threshold table
//     currently wired into this service so admin tooling can verify
//     what's in production. Read-only; no usage data is accessed'.
//
//   getOverview sort — 'Sort by total cost descending so the admin's
//     "who's expensive" eye hits the top of the list first'.
//
//   getAccountSummary returns null when usage OR tier resolves to
//     null (accounts with no usage / unknown account silently omitted),
//     but an identified tier without exact thresholds fails closed.
//
//   billingCycleFromDate(d) — UTC 'YYYY-MM' label (2-digit padded
//     month); BILLING_CYCLE_PATTERN admits only months 01..12.
//
// stays in lockstep across apps/server/src/services/cost-monitoring.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BILLING_CYCLE_PATTERN, billingCycleFromDate } from '../../src/services/cost-monitoring.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W942 V-541.B + V-683 cost-monitoring cross-source invariant', () => {
  // ─── V-541.B anchor + admin-surface framing ──────────────────

  it("CRITICAL apps/server/src/services/cost-monitoring.ts header pins V-541.B anchor — 'V-541.B — cost-monitoring service. Compute-on-demand per-account cost breakdown for the V-541 admin surface. Wraps the V-658 estimator + a pluggable usage aggregator'. The V-541.B + V-658 wrap is the architecture provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(/V-541\.B — cost-monitoring service/);
    expect(p).toMatch(/Compute-on-demand per-account cost breakdown for the V-541 admin/);
    expect(p).toMatch(/surface\. Wraps the V-658 estimator \+ a pluggable usage aggregator/);
  });

  // ─── V-541.B compute-on-demand posture ───────────────────────

  it("CRITICAL V-541.B compute-on-demand framing — 'no persistence (no cost_snapshots table yet — V-541.C's job). Every call recomputes from the underlying usage data. Cost-of-recompute is bounded by the per-account usage row count, which is small enough that compute-on-demand is acceptable for admin-tool use (one operator, occasional queries)'. The no-persistence-yet + admin-tool-scope rationale is the V-541.B trade-off.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(/V-541\.B posture: no persistence \(no `cost_snapshots` table yet —/);
    expect(p).toMatch(/V-541\.C's job\)\. Every call recomputes from the underlying usage/);
    expect(p).toMatch(/data\. Cost-of-recompute is bounded by the per-account usage row/);
    expect(p).toMatch(/count, which is small enough that compute-on-demand is acceptable/);
    expect(p).toMatch(/for admin-tool use \(one operator, occasional queries\)/);
  });

  // ─── UsageAggregator pluggable interface ─────────────────────

  it("CRITICAL UsageAggregator interface — 'Aggregate usage for a single account over the requested billing cycle. Returns null when the account doesn't exist or has no usage in the cycle'. The null-on-no-usage contract is what makes the overview-list silently skip empty accounts.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(/export interface UsageAggregator \{/);
    expect(p).toMatch(/Aggregate usage for a single account over the requested billing/);
    expect(p).toMatch(/cycle\. Returns null when the account doesn't exist or has no/);
    expect(p).toMatch(/usage in the cycle/);
    expect(p).toMatch(/aggregateForAccount\(args: \{/);
    expect(p).toMatch(/accountId: string;/);
    expect(p).toMatch(/billingCycle: string;.*\/\/ 'YYYY-MM'/);
  });

  // ─── CostMonitoringAccountSummary 5-field shape ──────────────

  it('CRITICAL CostMonitoringAccountSummary has 5 fields — account_id + billing_cycle + breakdown (CostBreakdown) + tier + thresholds (AlertThresholds). The 5-field summary is the V-541 admin-surface read shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(/export interface CostMonitoringAccountSummary \{/);
    expect(p).toMatch(/account_id: string;/);
    expect(p).toMatch(/billing_cycle: string;/);
    expect(p).toMatch(/breakdown: CostBreakdown;/);
    expect(p).toMatch(/tier: string;/);
    expect(p).toMatch(/thresholds: AlertThresholds;/);
  });

  // ─── CostMonitoringServiceOpts 4-field shape ─────────────────

  it('CRITICAL CostMonitoringServiceOpts has 4 fields — aggregator + rates (CostRates) + tierThresholds (optional; defaults to V-658 DEFAULT_TIER_THRESHOLDS) + resolveTier (per-account tier-label fn). The 4-DI surface is the boot-time wiring.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(/export interface CostMonitoringServiceOpts \{/);
    expect(p).toMatch(/aggregator: UsageAggregator;/);
    expect(p).toMatch(/rates: CostRates;/);
    expect(p).toMatch(/Per-tier thresholds\. Defaults to V-658 DEFAULT_TIER_THRESHOLDS/);
    expect(p).toMatch(/tierThresholds\?: Record<string, AlertThresholds>;/);
    expect(p).toMatch(/Resolve a tier label for a given account id\. Production wires this/);
    expect(p).toMatch(/to AccountAuthRepo \/ accounts table; tests pass a stub map/);
    expect(p).toMatch(/resolveTier: \(accountId: string\) => Promise<string \| null>;/);
  });

  // ─── V-683 getConfig framing ─────────────────────────────────

  it("CRITICAL V-683 getConfig JSDoc — 'V-683 — return the rates + tier-threshold table currently wired into this service so admin tooling can verify what's in production. Read-only; no usage data is accessed'. The V-683 read-only-config endpoint is the prod-verification anchor.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(/V-683 — return the rates \+ tier-threshold table currently/);
    expect(p).toMatch(/wired into this service so admin tooling can verify what's in/);
    expect(p).toMatch(/production\. Read-only; no usage data is accessed/);
  });

  it('CRITICAL getConfig() returns 2-field shape — rates: CostRates + tierThresholds: Record<string, AlertThresholds>. The 2-field return is the V-683 admin-tooling verification surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(
      /getConfig\(\): \{ rates: CostRates; tierThresholds: Record<string, AlertThresholds> \}/,
    );
    expect(p).toMatch(/rates: this\.opts\.rates,/);
    expect(p).toMatch(/tierThresholds: this\.opts\.tierThresholds \?\? DEFAULT_TIER_THRESHOLDS,/);
  });

  // ─── getOverview sort framing ────────────────────────────────

  it("CRITICAL getOverview sort framing — 'Sort by total cost descending so the admin's \"who's expensive\" eye hits the top of the list first'. The cost-desc sort puts costliest accounts at the top of admin views.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(/Sort by total cost descending so the admin's "who's expensive" eye/);
    expect(p).toMatch(/hits the top of the list first/);
    expect(p).toMatch(
      /return \[\.\.\.results\]\.sort\(\(a, b\) => b\.breakdown\.totalCents - a\.breakdown\.totalCents\);/,
    );
  });

  // ─── getAccountSummary null on no-usage / no-tier ────────────

  it("CRITICAL getAccountSummary returns null on null usage OR null tier — 'if (usage === null) return null' + 'if (tier === null) return null'. The 2-null fast-path silently omits empty/unknown accounts from getOverview results.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(/if \(usage === null\) return null;/);
    expect(p).toMatch(/if \(tier === null\) return null;/);
  });

  it('CRITICAL getAccountSummary threshold lookup is exact and fail-closed. A missing tier entry throws CostThresholdConfigurationError before aggregation instead of borrowing api_starter or zero thresholds.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(
      /const thresholds = \(this\.opts\.tierThresholds \?\? DEFAULT_TIER_THRESHOLDS\)\[tier\];/,
    );
    expect(p).toMatch(/if \(thresholds === undefined\) \{/);
    expect(p).toMatch(/throw new CostThresholdConfigurationError\(tier\);/);
    expect(p).not.toMatch(/DEFAULT_TIER_THRESHOLDS\.api_starter/);
    expect(p).not.toMatch(/softCents: 0, hardCents: 0/);
  });

  // ─── getAccountSummary returns full 5-field shape ────────────

  it('CRITICAL getAccountSummary returns 5-field summary via estimateCost(usage, rates, thresholds). The estimateCost call is what bridges V-541.B (orchestrator) to V-658 (cost-estimator primitive).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(/breakdown: estimateCost\(usage, this\.opts\.rates, thresholds\),/);
  });

  // ─── billingCycleFromDate UTC + 2-digit month ────────────────

  it("CRITICAL billingCycleFromDate JSDoc — 'Build a YYYY-MM billing-cycle label from a Date (UTC)'. The UTC + YYYY-MM format matches W925 cost-aggregator billingCycleWindow regex.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(/Build a YYYY-MM billing-cycle label from a Date \(UTC\)/);
  });

  it('CRITICAL billingCycleFromDate runtime — UTC year + zero-padded month. Verified for 2026-05-15 12:30Z → "2026-05".', () => {
    expect(billingCycleFromDate(new Date('2026-05-15T12:30:00Z'))).toBe('2026-05');
    expect(billingCycleFromDate(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01');
    expect(billingCycleFromDate(new Date('2026-12-31T23:59:59Z'))).toBe('2026-12');
  });

  it('CRITICAL shared billing-cycle authority accepts 01/12 and rejects impossible 00/13 months', () => {
    expect(BILLING_CYCLE_PATTERN.test('2026-01')).toBe(true);
    expect(BILLING_CYCLE_PATTERN.test('2026-12')).toBe(true);
    expect(BILLING_CYCLE_PATTERN.test('2026-00')).toBe(false);
    expect(BILLING_CYCLE_PATTERN.test('2026-13')).toBe(false);
  });

  it("CRITICAL billingCycleFromDate uses getUTCFullYear + (getUTCMonth + 1).padStart(2, '0'). The UTC-only computation matches cost-aggregator billingCycleWindow + status-snapshot pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(/const y = d\.getUTCFullYear\(\)\.toString\(\);/);
    expect(p).toMatch(/const m = \(d\.getUTCMonth\(\) \+ 1\)\.toString\(\)\.padStart\(2, '0'\);/);
    expect(p).toMatch(/return `\$\{y\}-\$\{m\}`;/);
  });

  // ─── V-658 cost-estimator imports ────────────────────────────

  it('CRITICAL imports V-658 primitives — DEFAULT_TIER_THRESHOLDS + estimateCost + type AlertThresholds + type CostBreakdown + type CostRates + type UsageInputs. The 6-primitive import bridges V-541.B orchestrator → V-658 estimator.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts'));
    expect(p).toMatch(/import \{/);
    expect(p).toMatch(/DEFAULT_TIER_THRESHOLDS,/);
    expect(p).toMatch(/estimateCost,/);
    expect(p).toMatch(/type AlertThresholds,/);
    expect(p).toMatch(/type CostBreakdown,/);
    expect(p).toMatch(/type CostRates,/);
    expect(p).toMatch(/type UsageInputs,/);
    expect(p).toMatch(/\} from '\.\.\/lib\/cost-estimator\.js';/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/cost-monitoring-v541b-v683-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
