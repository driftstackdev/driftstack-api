// Drift-guard for apps/admin-panel/src/pages/cost.astro field-name
// reads. Slices 79 + 80 + 81 fixed FOUR field-name drift bugs on
// this page (all silently rendering "$0.00" or empty-states):
//
//   - tier-thresholds loop: t.softWarningCents → t.softCents
//   - tier-thresholds loop: t.hardCapCents    → t.hardCents
//   - config loader:        body.tiers        → body.tierThresholds
//   - account-summary:      body.estimated    → body.breakdown
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

describe('admin-panel /cost field-name parity (drift-guard for slices 79/80/81)', () => {
  it('cost.astro file exists at the canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('tier-thresholds loop reads t.softCents + t.hardCents (NOT the legacy softWarningCents/hardCapCents)', () => {
    const body = read(PAGE);
    expect(body).toMatch(/t\.softCents \?\? 0/);
    expect(body).toMatch(/t\.hardCents \?\? 0/);
    // Drift-guards on the wrong names.
    expect(body).not.toMatch(/t\.softWarningCents/);
    expect(body).not.toMatch(/t\.hardCapCents/);
  });

  it('loadConfig reads body.tierThresholds (NOT the legacy body.tiers)', () => {
    const body = read(PAGE);
    // Allow `body.tierThresholds ?? body.tiers ?? {}` defensive
    // fallback (kept for rolling-deploy safety); the load-bearing
    // bit is that tierThresholds is read first.
    expect(body).toMatch(/renderTierThresholds\(body\.tierThresholds/);
  });

  it('renderAccountSummary reads body.breakdown + body.thresholds (NOT body.estimated / body.softWarningCents / body.hardCapCents at the root)', () => {
    const body = read(PAGE);
    // Account-summary destructures breakdown + thresholds at the top
    // of the function.
    expect(body).toMatch(/const breakdown = body\.breakdown \?\? body\.estimated \?\? \{\};/);
    expect(body).toMatch(/const thresholds = body\.thresholds \?\? \{\};/);
    // Drift-guards: the broken root-level reads MUST NOT come back.
    expect(body).not.toMatch(/cents\(body\.softWarningCents\)/);
    expect(body).not.toMatch(/cents\(body\.hardCapCents\)/);
    expect(body).not.toMatch(/escapeHtml\(body\.thresholdState/);
    // Sub-processor row sums email + LLM (no fictional subprocessorCents field).
    expect(body).toMatch(/breakdown\.emailCents \?\? 0\) \+ Number\(breakdown\.llmCents \?\? 0/);
    expect(body).not.toMatch(/body\.estimated[^.]*\.subprocessorCents/);
  });

  it('renderTopAccounts table reads r.breakdown.thresholdState + r.thresholds.{softCents,hardCents} (NOT root-level wrong fields)', () => {
    const body = read(PAGE);
    // Per-row destructure of breakdown + thresholds inside the map.
    expect(body).toMatch(/const breakdown = r\.breakdown \?\? r\.estimated \?\? \{\};/);
    expect(body).toMatch(/const thresholds = r\.thresholds \?\? \{\};/);
    // Pin the corrected reads on the table cells.
    expect(body).toMatch(/cents\(thresholds\.softCents\)/);
    expect(body).toMatch(/cents\(thresholds\.hardCents\)/);
    expect(body).toMatch(/breakdown\.thresholdState/);
    // Drift-guards.
    expect(body).not.toMatch(/cents\(r\.softWarningCents\)/);
    expect(body).not.toMatch(/cents\(r\.hardCapCents\)/);
    expect(body).not.toMatch(/escapeHtml\(r\.thresholdState/);
  });
});
