// W396.A — drift guard for apps/server/src/services/cost-monitoring.ts.
// V-541.B compute-on-demand cost-monitoring service. Wraps the V-658
// estimator + a pluggable UsageAggregator. The compute-on-demand
// posture (no cost_snapshots table yet — V-541.C job) is intentional
// and load-bearing: drift toward persistence here would silently
// double-count costs across the V-541.C dispatcher's polling.
//
//   • V-541.B framing + no-persistence posture pinned.
//   • UsageAggregator interface: aggregateForAccount returns null for
//     missing accounts / no usage in cycle.
//   • CostMonitoringAccountSummary: 5 fields (snake_case JSON shape).
//   • CostMonitoringServiceOpts: aggregator + rates + tierThresholds?
//     (defaults to V-658 DEFAULT_TIER_THRESHOLDS) + resolveTier.
//   • getAccountSummary: returns null when usage OR tier missing.
//   • Canonical billing-cycle grammar rejects impossible calendar months.
//   • Threshold lookup is exact and fail-closed before aggregation; no
//     cross-tier or zero-threshold borrowing.
//   • V-683 getConfig: read-only rates + tierThresholds inspection
//     for admin tooling.
//   • getOverview: sort by total cost descending ("who's expensive"
//     eye hits top first).
//   • billingCycleFromDate: UTC YYYY-MM label (zero-padded month).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/cost-monitoring.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W396.A apps/server/src/services/cost-monitoring.ts content parity', () => {
  const body = read(LIB);

  it('V-541.B framing pinned + V-658 estimator + pluggable UsageAggregator', () => {
    expect(body).toMatch(/V-541\.B — cost-monitoring service\./);
    expect(body).toMatch(
      /Compute-on-demand per-account cost breakdown for the V-541 admin\s*\/\/\s*surface\. Wraps the V-658 estimator \+ a pluggable usage aggregator/,
    );
  });

  it('V-541.B no-persistence posture pinned (no cost_snapshots table — V-541.C job; compute-on-demand)', () => {
    expect(body).toMatch(
      /V-541\.B posture: no persistence \(no `cost_snapshots` table yet —\s*\/\/\s*V-541\.C's job\)\. Every call recomputes from the underlying usage\s*\/\/\s*data\. Cost-of-recompute is bounded by the per-account usage row\s*\/\/\s*count, which is small enough that compute-on-demand is acceptable\s*\/\/\s*for admin-tool use \(one operator, occasional queries\)/,
    );
  });

  it('UsageAggregator interface: aggregateForAccount returns Promise<UsageInputs | null> with YYYY-MM cycle', () => {
    expect(body).toMatch(/export interface UsageAggregator \{/);
    expect(body).toMatch(
      /Aggregate usage for a single account over the requested billing\s*\*\s*cycle\. Returns null when the account doesn't exist or has no\s*\*\s*usage in the cycle/,
    );
    expect(body).toMatch(
      /aggregateForAccount\(args: \{\s*accountId: string;\s*billingCycle: string; \/\/ 'YYYY-MM'\s*\}\): Promise<UsageInputs \| null>;/,
    );
  });

  it('CostMonitoringAccountSummary: 5 snake_case fields (account_id, billing_cycle, breakdown, tier, thresholds)', () => {
    expect(body).toMatch(/export interface CostMonitoringAccountSummary \{/);
    expect(body).toMatch(/account_id: string;/);
    expect(body).toMatch(/billing_cycle: string;/);
    expect(body).toMatch(/breakdown: CostBreakdown;/);
    expect(body).toMatch(/tier: string;/);
    expect(body).toMatch(/thresholds: AlertThresholds;/);
  });

  it('CostMonitoringServiceOpts: aggregator + rates + tierThresholds? (default V-658) + resolveTier', () => {
    expect(body).toMatch(/export interface CostMonitoringServiceOpts \{/);
    expect(body).toMatch(/aggregator: UsageAggregator;/);
    expect(body).toMatch(/rates: CostRates;/);
    expect(body).toMatch(/Per-tier thresholds\. Defaults to V-658 DEFAULT_TIER_THRESHOLDS\./);
    expect(body).toMatch(/tierThresholds\?: Record<string, AlertThresholds>;/);
    expect(body).toMatch(
      /Resolve a tier label for a given account id\. Production wires this\s*\*\s*to AccountAuthRepo \/ accounts table; tests pass a stub map\./,
    );
    expect(body).toMatch(/resolveTier: \(accountId: string\) => Promise<string \| null>;/);
  });

  it('getAccountSummary: returns null when usage missing OR tier missing', () => {
    expect(body).toMatch(
      /const usage = await this\.opts\.aggregator\.aggregateForAccount\(args\);/,
    );
    expect(body).toMatch(/if \(usage === null\) return null;/);
    expect(body).toMatch(/const tier = await this\.opts\.resolveTier\(args\.accountId\);/);
    expect(body).toMatch(/if \(tier === null\) return null;/);
  });

  it('exports one strict calendar-cycle authority with real month boundaries', () => {
    expect(body).toMatch(
      /export const BILLING_CYCLE_PATTERN = \/\^\\d\{4\}-\(\?:0\[1-9\]\|1\[0-2\]\)\$\//,
    );
  });

  it('resolves tier + exact thresholds before aggregation and fails closed when absent', () => {
    expect(body).toMatch(
      /const tier = await this\.opts\.resolveTier\(args\.accountId\);\s*if \(tier === null\) return null;\s*const thresholds = \(this\.opts\.tierThresholds \?\? DEFAULT_TIER_THRESHOLDS\)\[tier\];\s*if \(thresholds === undefined\) \{\s*throw new CostThresholdConfigurationError\(tier\);/,
    );
    expect(body).toMatch(
      /const usage = await this\.opts\.aggregator\.aggregateForAccount\(args\);\s*if \(usage === null\) return null;/,
    );
    expect(body).not.toMatch(/DEFAULT_TIER_THRESHOLDS\.api_starter/);
    expect(body).not.toMatch(/softCents: 0, hardCents: 0/);
  });

  it('getAccountSummary: returns summary with breakdown=estimateCost(usage, rates, thresholds)', () => {
    expect(body).toMatch(
      /return \{\s*account_id: args\.accountId,\s*billing_cycle: args\.billingCycle,\s*breakdown: estimateCost\(usage, this\.opts\.rates, thresholds\),\s*tier,\s*thresholds,\s*\};/,
    );
  });

  it('V-683 getConfig: read-only rates + tierThresholds (admin tooling production-config verification)', () => {
    expect(body).toMatch(
      /V-683 — return the rates \+ tier-threshold table currently\s*\*\s*wired into this service so admin tooling can verify what's in\s*\*\s*production\. Read-only; no usage data is accessed/,
    );
    expect(body).toMatch(
      /getConfig\(\): \{ rates: CostRates; tierThresholds: Record<string, AlertThresholds> \} \{\s*return \{\s*rates: this\.opts\.rates,\s*tierThresholds: this\.opts\.tierThresholds \?\? DEFAULT_TIER_THRESHOLDS,\s*\};\s*\}/,
    );
  });

  it('getOverview: sort by totalCents descending ("who\'s expensive" eye)', () => {
    expect(body).toMatch(
      /\/\/ Sort by total cost descending so the admin's "who's expensive" eye\s*\/\/\s*hits the top of the list first\./,
    );
    expect(body).toMatch(
      /return \[\.\.\.results\]\.sort\(\(a, b\) => b\.breakdown\.totalCents - a\.breakdown\.totalCents\);/,
    );
  });

  it('billingCycleFromDate: UTC YYYY-MM label with zero-padded month', () => {
    expect(body).toMatch(/Build a YYYY-MM billing-cycle label from a Date \(UTC\)\./);
    expect(body).toMatch(
      /export function billingCycleFromDate\(d: Date\): string \{\s*const y = d\.getUTCFullYear\(\)\.toString\(\);\s*const m = \(d\.getUTCMonth\(\) \+ 1\)\.toString\(\)\.padStart\(2, '0'\);\s*return `\$\{y\}-\$\{m\}`;\s*\}/,
    );
  });

  it('imports: DEFAULT_TIER_THRESHOLDS + estimateCost + 4 types from ../lib/cost-estimator.js', () => {
    expect(body).toMatch(
      /import \{\s*DEFAULT_TIER_THRESHOLDS,\s*estimateCost,\s*type AlertThresholds,\s*type CostBreakdown,\s*type CostRates,\s*type UsageInputs,\s*\} from '\.\.\/lib\/cost-estimator\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
