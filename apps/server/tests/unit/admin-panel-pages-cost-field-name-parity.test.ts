// Drift-guard for apps/admin-panel/src/pages/cost.astro field-name
// reads. Slices 79 + 80 + 81 fixed field-name drift bugs on this page;
// the current contract is stricter: every success payload is decoded
// before rendering, with no rolling legacy fallback that can turn a
// malformed response into a plausible zero-cost result.
//
//   - tier-thresholds loop: t.softWarningCents → t.softCents
//   - tier-thresholds loop: t.hardCapCents    → t.hardCents
//   - config loader:        tiers             → tierThresholds
//   - account-summary:      estimated         → breakdown
//   - account-summary:      body.softWarningCents → body.thresholds.softCents
//   - account-summary:      body.hardCapCents  → body.thresholds.hardCents
//   - account-summary:      body.thresholdState → body.breakdown.thresholdState
//   - account-summary:      body.subprocessorCents → emailCents + llmCents sum
//   - top-accounts table:   r.softWarningCents → r.thresholds.softCents
//   - top-accounts table:   r.hardCapCents     → r.thresholds.hardCents
//   - top-accounts table:   r.thresholdState   → r.breakdown.thresholdState
//
// The wire shape is governed by:
//   - cost-monitoring.ts CostMonitoringAccountSummary
//   - cost-estimator.ts AlertThresholds + CostBreakdown
//   - cost-monitoring.ts getConfig() return
//
// This parity test pins the CORRECT field names + adds explicit
// not.toMatch on the legacy wrong forms so they can't drift back.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/admin-panel/src/pages/cost.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('admin-panel /cost strict field-name parity', () => {
  it('cost.astro file exists at the canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('threshold rendering consumes only the validated softCents + hardCents fields', () => {
    const body = read(PAGE);
    expect(body).toContain("hasExactKeys(value, ['softCents', 'hardCents'])");
    expect(body).toContain('accountingAmount(t.softCents)');
    expect(body).toContain('accountingAmount(t.hardCents)');
    expect(body).not.toMatch(/softWarningCents|hardCapCents/);
    expect(body).not.toMatch(/t\.(?:softCents|hardCents)\s*\?\?/);
  });

  it('config loader requires exact rates + tierThresholds and has no legacy tiers fallback', () => {
    const body = read(PAGE);
    expect(body).toContain("hasExactKeys(value, ['rates', 'tierThresholds'])");
    expect(body).toContain('const config = parseConfigPayload(body);');
    expect(body).toContain('renderTierThresholds(config.tierThresholds);');
    expect(body).not.toMatch(/body\.tiers|config\.tiers/);
  });

  it('account summary requires exact canonical root and nested breakdown fields', () => {
    const body = read(PAGE);
    expect(body).toContain(
      "hasExactKeys(value, ['account_id', 'billing_cycle', 'breakdown', 'tier', 'thresholds'])",
    );
    expect(body).toContain('hasExactKeys(value, COST_BREAKDOWN_KEYS)');
    expect(body).toContain('const breakdown = summary.breakdown;');
    expect(body).toContain('const thresholds = summary.thresholds;');
    expect(body).not.toMatch(/\.estimated|subprocessorCents|softWarningCents|hardCapCents/);
    expect(body).not.toMatch(/body\.(?:accountId|billingCycle|thresholdState)/);
  });

  it('overview rows use the same validated canonical summary shape with no per-row fallbacks', () => {
    const body = read(PAGE);
    expect(body).toContain('parseCostSummary(summary, accountId, expectedCycle);');
    expect(body).toContain('const breakdown = r.breakdown;');
    expect(body).toContain('const thresholds = r.thresholds;');
    expect(body).toContain('accountingAmount(thresholds.softCents)');
    expect(body).toContain('accountingAmount(thresholds.hardCents)');
    expect(body).toContain('escapeHtml(breakdown.thresholdState)');
    expect(body).not.toMatch(/r\.(?:estimated|softWarningCents|hardCapCents|thresholdState)/);
  });

  it('forbids nullish/default fallbacks on every wire-value read', () => {
    const body = read(PAGE);
    expect(body).not.toMatch(
      /\b(?:body|config|summary|breakdown|thresholds|rates|tiers|r|t)\.[A-Za-z_]+\s*\?\?/,
    );
    expect(body).not.toMatch(/Number\([^)]*\?\?\s*0/);
  });
});
