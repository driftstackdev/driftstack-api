// V-541.C — cost alert dispatcher.
//
// Sits on top of V-541.B CostMonitoringService. Takes a list of
// per-account cost summaries, detects threshold-state transitions
// against a remembered prior state, and dispatches alerts for the
// ones that newly cross a threshold.
//
// V-541.C posture: persistence is in-memory (no `cost_alerts_sent`
// table yet). The dispatcher remembers the last threshold state per
// account across calls within the same process; deploys reset the
// memory, so the worst-case is one duplicate alert per deploy. That's
// acceptable for a sub-daily nightly-recompute cadence.
//
// Channel is pluggable via `sendAlert` — pass a Postmark-driven email
// sender, a Slack webhook POST, or both. The dispatcher only decides
// "fire or skip" and packages the alert payload.

import type { CostMonitoringAccountSummary, CostMonitoringService } from './cost-monitoring.js';
import type { ThresholdState } from '../lib/cost-estimator.js';

export type AlertSeverity = 'warn' | 'critical' | 'resolved';

export interface CostAlertPayload {
  account_id: string;
  billing_cycle: string;
  tier: string;
  severity: AlertSeverity;
  previous_state: ThresholdState | null;
  current_state: ThresholdState;
  total_cents: number;
  threshold_soft_cents: number;
  threshold_hard_cents: number;
}

export type AlertSink = (alert: CostAlertPayload) => Promise<void>;

export interface DispatchResult {
  alertsFired: number;
  alertsSkipped: number;
}

export interface CostAlertDispatcherOpts {
  service: CostMonitoringService;
  sendAlert: AlertSink;
}

export class CostAlertDispatcher {
  private readonly lastState = new Map<string, ThresholdState>();
  // The billing cycle the remembered states belong to. Threshold state is
  // per-cycle (a new cycle resets spend), so state must NOT carry across a
  // cycle rollover — otherwise an account that ended the prior cycle over a
  // threshold fires a spurious 'resolved' transition on the new cycle's
  // first run. Cleared in evaluate() when the cycle changes.
  private lastCycle: string | null = null;

  constructor(private readonly opts: CostAlertDispatcherOpts) {}

  /**
   * Evaluate the given account ids for the given billing cycle.
   * Fires an alert for any account whose threshold state transitioned
   * (e.g. under-soft → between-soft-and-hard).
   *
   * Accounts the cost service can't summarise (no usage in cycle) are
   * silently skipped — no alert needs firing if there's no spend.
   */
  async evaluate(args: {
    accountIds: readonly string[];
    billingCycle: string;
  }): Promise<DispatchResult> {
    // A new billing cycle resets spend → prior-cycle threshold state is
    // irrelevant (and would fire a spurious transition). Drop it so the new
    // cycle starts fresh: prior=null → only a genuine over-threshold first
    // reading alerts (classifyTransition's first-run branch). Also bounds the
    // in-memory map to one cycle's accounts.
    if (this.lastCycle !== args.billingCycle) {
      this.lastState.clear();
      this.lastCycle = args.billingCycle;
    }

    const summaries = await this.opts.service.getOverview({
      accountIds: args.accountIds,
      billingCycle: args.billingCycle,
    });

    let alertsFired = 0;
    let alertsSkipped = 0;

    for (const summary of summaries) {
      const prior = this.lastState.get(summary.account_id) ?? null;
      const current = summary.breakdown.thresholdState;
      this.lastState.set(summary.account_id, current);

      if (prior === current) {
        // No transition — already alerted (or already-OK).
        alertsSkipped += 1;
        continue;
      }
      const severity = classifyTransition(prior, current);
      if (severity === null) {
        alertsSkipped += 1;
        continue;
      }
      await this.opts.sendAlert(buildAlertPayload(summary, prior, current, severity));
      alertsFired += 1;
    }

    return { alertsFired, alertsSkipped };
  }

  /**
   * Test seam: reset the remembered prior-state map. Production
   * doesn't reset (deploys do that implicitly).
   */
  reset(): void {
    this.lastState.clear();
    this.lastCycle = null;
  }
}

function classifyTransition(
  prior: ThresholdState | null,
  current: ThresholdState,
): AlertSeverity | null {
  // First-ever evaluation (prior null): only fire if we're already
  // over a threshold. Don't alert "still under-soft" on first run.
  if (prior === null) {
    if (current === 'over-hard') return 'critical';
    if (current === 'between-soft-and-hard') return 'warn';
    return null;
  }
  // Tightening transitions — escalation alerts.
  if (current === 'over-hard' && prior !== 'over-hard') return 'critical';
  if (current === 'between-soft-and-hard' && prior === 'under-soft') return 'warn';
  // Recovering: spend dropped back below the threshold. Fire a
  // 'resolved' alert so on-call knows to stand down.
  if (current === 'under-soft' && prior !== 'under-soft') return 'resolved';
  if (current === 'between-soft-and-hard' && prior === 'over-hard') return 'resolved';
  return null;
}

function buildAlertPayload(
  summary: CostMonitoringAccountSummary,
  prior: ThresholdState | null,
  current: ThresholdState,
  severity: AlertSeverity,
): CostAlertPayload {
  return {
    account_id: summary.account_id,
    billing_cycle: summary.billing_cycle,
    tier: summary.tier,
    severity,
    previous_state: prior,
    current_state: current,
    total_cents: summary.breakdown.totalCents,
    threshold_soft_cents: summary.thresholds.softCents,
    threshold_hard_cents: summary.thresholds.hardCents,
  };
}
