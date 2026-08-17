// W927 — V-541.C cost-alert-dispatcher cross-source invariant.
// Two-hundred-fifty-third in the drift-guard series. Pins the
// threshold-transition-based cost alert dispatcher:
//
//   V-541.C anchor — 'cost alert dispatcher. Sits on top of V-541.B
//   CostMonitoringService. Takes a list of per-account cost summaries,
//   detects threshold-state transitions against a remembered prior
//   state, and dispatches alerts for the ones that newly cross a
//   threshold'.
//
//   V-541.C posture: persistence is in-memory (no cost_alerts_sent
//   table yet). Dispatcher remembers last threshold state per account
//   across calls within same process; deploys reset memory. Worst-case
//   = one duplicate alert per deploy — acceptable for sub-daily
//   nightly-recompute cadence.
//
//   Channel is pluggable via sendAlert — Postmark email / Slack
//   webhook / both. Dispatcher only decides 'fire or skip' + packages
//   alert payload.
//
//   AlertSeverity 3-value union — 'warn' | 'critical' | 'resolved'.
//
//   CostAlertPayload (8 fields):
//     - account_id + billing_cycle + tier + severity +
//       previous_state (nullable) + current_state +
//       total_cents + threshold_soft_cents + threshold_hard_cents.
//
//   classifyTransition state machine:
//     - prior null + current over-hard → critical.
//     - prior null + current between-soft-and-hard → warn.
//     - prior null + current under-soft → null (no alert).
//     - escalations: over-hard from non-over-hard → critical.
//     - escalations: under-soft → between-soft-and-hard → warn.
//     - resolved: non-under-soft → under-soft → resolved.
//     - resolved: over-hard → between-soft-and-hard → resolved.
//
//   evaluate() silently skips accounts with no usage (null summary
//   from CostMonitoringService).
//
// stays in lockstep across apps/server/src/services/cost-alert-dispatcher.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W927 V-541.C cost-alert-dispatcher cross-source invariant', () => {
  // ─── V-541.C anchor + V-541.B dependency ─────────────────────

  it("CRITICAL apps/server/src/services/cost-alert-dispatcher.ts header pins V-541.C anchor — 'V-541.C — cost alert dispatcher. Sits on top of V-541.B CostMonitoringService. Takes a list of per-account cost summaries, detects threshold-state transitions against a remembered prior state, and dispatches alerts for the ones that newly cross a threshold'. The V-541.C anchor is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/V-541\.C — cost alert dispatcher/);
    expect(p).toMatch(/Sits on top of V-541\.B CostMonitoringService\. Takes a list of/);
    expect(p).toMatch(/per-account cost summaries, detects threshold-state transitions/);
    expect(p).toMatch(/against a remembered prior state, and dispatches alerts for the/);
    expect(p).toMatch(/ones that newly cross a threshold/);
  });

  // ─── V-541.C in-memory persistence posture ───────────────────

  it("CRITICAL persistence posture framing — 'V-541.C posture: persistence is in-memory (no cost_alerts_sent table yet). The dispatcher remembers the last threshold state per account across calls within the same process; deploys reset the memory, so the worst-case is one duplicate alert per deploy. That's acceptable for a sub-daily nightly-recompute cadence'. The deploy-reset-tolerant design is the V-541.C trade-off.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/V-541\.C posture: persistence is in-memory \(no `cost_alerts_sent`/);
    expect(p).toMatch(/table yet\)\. The dispatcher remembers the last threshold state per/);
    expect(p).toMatch(/account across calls within the same process; deploys reset the/);
    expect(p).toMatch(/memory, so the worst-case is one duplicate alert per deploy\. That's/);
    expect(p).toMatch(/acceptable for a sub-daily nightly-recompute cadence/);
  });

  // ─── Pluggable sendAlert channel ─────────────────────────────

  it('CRITICAL channel-pluggable framing — \'Channel is pluggable via sendAlert — pass a Postmark-driven email sender, a Slack webhook POST, or both. The dispatcher only decides "fire or skip" and packages the alert payload\'. The fire-or-skip + payload-packaging split is what makes the channel a deployment-time decision.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/Channel is pluggable via `sendAlert` — pass a Postmark-driven email/);
    expect(p).toMatch(/sender, a Slack webhook POST, or both\. The dispatcher only decides/);
    expect(p).toMatch(/"fire or skip" and packages the alert payload/);
  });

  // ─── AlertSeverity 3-value union ─────────────────────────────

  it("CRITICAL AlertSeverity = 'warn' | 'critical' | 'resolved'. The 3-value union distinguishes escalations (warn/critical) from de-escalations (resolved) — 'resolved' is what lets on-call stand down.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/export type AlertSeverity = 'warn' \| 'critical' \| 'resolved';/);
  });

  // ─── CostAlertPayload 9-field shape ──────────────────────────

  it('CRITICAL CostAlertPayload has 9 fields — account_id + billing_cycle + tier + severity + previous_state (nullable) + current_state + total_cents + threshold_soft_cents + threshold_hard_cents. The 9-field shape gives alerting channels everything they need to write a self-contained alert.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/export interface CostAlertPayload \{/);
    expect(p).toMatch(/account_id: string;/);
    expect(p).toMatch(/billing_cycle: string;/);
    expect(p).toMatch(/tier: string;/);
    expect(p).toMatch(/severity: AlertSeverity;/);
    expect(p).toMatch(/previous_state: ThresholdState \| null;/);
    expect(p).toMatch(/current_state: ThresholdState;/);
    expect(p).toMatch(/total_cents: number;/);
    expect(p).toMatch(/threshold_soft_cents: number;/);
    expect(p).toMatch(/threshold_hard_cents: number;/);
  });

  // ─── AlertSink async signature ───────────────────────────────

  it('CRITICAL AlertSink = (alert: CostAlertPayload) => Promise<void>. The async-void return is what lets sendAlert do network I/O without blocking the dispatch loop.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/export type AlertSink = \(alert: CostAlertPayload\) => Promise<void>;/);
  });

  it('CRITICAL per-account sink failures are sanitized before the nightly logger receives them', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/const ALERT_SINK_ERROR_MAX_CHARS = 500;/);
    expect(p).toMatch(/message: safeAlertSinkError\(err\),/);
    expect(p).toMatch(
      /redactText\(sliceWithoutSplittingSurrogate\(raw, ALERT_SINK_ERROR_PRE_REDACT_MAX_CHARS\)\)/,
    );
  });

  // ─── DispatchResult 2-counter shape ──────────────────────────

  it('CRITICAL DispatchResult has 2 counters — alertsFired + alertsSkipped. The 2-counter ops-metric shape lets dashboards report dispatch-effectiveness without enumerating per-alert outcomes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/export interface DispatchResult \{/);
    expect(p).toMatch(/alertsFired: number;/);
    expect(p).toMatch(/alertsSkipped: number;/);
  });

  // ─── classifyTransition state machine ────────────────────────

  it('CRITICAL classifyTransition first-eval framing — prior null + current over-hard → critical, prior null + current between-soft-and-hard → warn, prior null + current under-soft → null. The first-ever-eval shape is what prevents spurious "still under-soft" alerts on cold-start.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/First-ever evaluation \(prior null\): only fire if we're already/);
    expect(p).toMatch(/over a threshold\. Don't alert "still under-soft" on first run/);
    expect(p).toMatch(/if \(prior === null\) \{/);
    expect(p).toMatch(/if \(current === 'over-hard'\) return 'critical';/);
    expect(p).toMatch(/if \(current === 'between-soft-and-hard'\) return 'warn';/);
  });

  it("CRITICAL escalation transitions — 'over-hard' from non-'over-hard' → critical; 'between-soft-and-hard' from 'under-soft' → warn. The 2 escalation rules cover spend-increasing transitions.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/Tightening transitions — escalation alerts\./);
    expect(p).toMatch(/if \(current === 'over-hard' && prior !== 'over-hard'\) return 'critical';/);
    expect(p).toMatch(
      /if \(current === 'between-soft-and-hard' && prior === 'under-soft'\) return 'warn';/,
    );
  });

  it("CRITICAL resolved transitions — non-'under-soft' → 'under-soft' = resolved; 'over-hard' → 'between-soft-and-hard' = resolved. The 'resolved' alert lets on-call stand down — drift to skipping these would leave incidents 'open' in dashboards forever.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/Recovering: spend dropped back below the threshold\. Fire a/);
    expect(p).toMatch(/'resolved' alert so on-call knows to stand down/);
    expect(p).toMatch(
      /if \(current === 'under-soft' && prior !== 'under-soft'\) return 'resolved';/,
    );
    expect(p).toMatch(
      /if \(current === 'between-soft-and-hard' && prior === 'over-hard'\) return 'resolved';/,
    );
  });

  // ─── No-usage silent skip framing ────────────────────────────

  it("CRITICAL no-usage skip framing — 'Accounts the cost service can't summarise (no usage in cycle) are silently skipped — no alert needs firing if there's no spend'. The silent-skip is what prevents alert-storms on test accounts with zero usage.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/Accounts the cost service can't summarise \(no usage in cycle\) are/);
    expect(p).toMatch(/silently skipped — no alert needs firing if there's no spend/);
  });

  // ─── Test-seam reset() ───────────────────────────────────────

  it("CRITICAL reset() comment pins 'Test seam: reset the remembered prior-state map. Production doesn't reset (deploys do that implicitly)'. The test-seam framing prevents production code from leaning on reset() for state.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/Test seam: reset the remembered prior-state map\. Production/);
    expect(p).toMatch(/doesn't reset \(deploys do that implicitly\)/);
  });

  // ─── CostAlertDispatcherOpts shape ───────────────────────────

  it('CRITICAL CostAlertDispatcherOpts has 2 fields — service: CostMonitoringService + sendAlert: AlertSink. The 2-field options pin the dependency-injection surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts'));
    expect(p).toMatch(/export interface CostAlertDispatcherOpts \{/);
    expect(p).toMatch(/service: CostMonitoringService;/);
    expect(p).toMatch(/sendAlert: AlertSink;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/cost-alert-dispatcher-v541c-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
