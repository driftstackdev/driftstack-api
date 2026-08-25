// W396.C — drift guard for apps/server/src/services/cost-alert-dispatcher.ts.
// V-541.C cost-alert dispatcher: detects threshold-state transitions
// against in-memory prior-state map + dispatches alerts via pluggable
// AlertSink. The classifyTransition matrix is the load-bearing
// artefact; drift here either suppresses critical escalation alerts
// or floods Postmark/Slack with duplicate "still over-hard" emails on
// every nightly run.
//
//   • V-541.C framing + sits-on-top-of-V-541.B-CostMonitoringService
//     pinned.
//   • In-memory persistence framing: deploys reset memory → worst-
//     case 1 duplicate alert per deploy (acceptable for sub-daily
//     nightly cadence).
//   • Pluggable AlertSink: Postmark email / Slack webhook / both.
//   • AlertSeverity: 3-literal union (warn | critical | resolved).
//   • CostAlertPayload: 9 snake_case fields.
//   • Transition matrix:
//       - prior=null + over-hard → 'critical'
//       - prior=null + between → 'warn'
//       - prior=null + under-soft → null (no first-run "still ok")
//       - any → over-hard (escalation): 'critical'
//       - under-soft → between (escalation): 'warn'
//       - !under-soft → under-soft (recovery): 'resolved'
//       - over-hard → between (recovery): 'resolved'
//   • prior === current → skip (no transition).
//   • reset() test seam — production never resets (deploys do).
//   • Accounts with no usage in cycle silently skipped (no alert
//     needed if no spend).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/cost-alert-dispatcher.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W396.C apps/server/src/services/cost-alert-dispatcher.ts content parity', () => {
  const body = read(LIB);

  it('V-541.C framing + sits-on-top-of-V-541.B-CostMonitoringService pinned', () => {
    expect(body).toMatch(/V-541\.C — cost alert dispatcher\./);
    expect(body).toMatch(
      /Sits on top of V-541\.B CostMonitoringService\. Takes a list of\s*\/\/\s*per-account cost summaries, detects threshold-state transitions\s*\/\/\s*against a remembered prior state, and dispatches alerts for the\s*\/\/\s*ones that newly cross a threshold/,
    );
  });

  it('In-memory persistence framing: deploys reset → worst-case 1 duplicate per deploy (acceptable sub-daily cadence)', () => {
    expect(body).toMatch(
      /V-541\.C posture: persistence is in-memory \(no `cost_alerts_sent`\s*\/\/\s*table yet\)\. The dispatcher remembers the last threshold state per\s*\/\/\s*account across calls within the same process; deploys reset the\s*\/\/\s*memory, so the worst-case is one duplicate alert per deploy\. That's\s*\/\/\s*acceptable for a sub-daily nightly-recompute cadence/,
    );
  });

  it('Pluggable channel framing: Postmark / Slack / both via sendAlert AlertSink', () => {
    expect(body).toMatch(
      /Channel is pluggable via `sendAlert` — pass a Postmark-driven email\s*\/\/\s*sender, a Slack webhook POST, or both\. The dispatcher only decides\s*\/\/\s*"fire or skip" and packages the alert payload/,
    );
  });

  it('AlertSeverity: 3-literal union (warn | critical | resolved)', () => {
    expect(body).toMatch(/export type AlertSeverity = 'warn' \| 'critical' \| 'resolved';/);
  });

  it('CostAlertPayload: 9 snake_case fields (account_id / billing_cycle / tier / severity / previous_state / current_state / total_cents / threshold_soft_cents / threshold_hard_cents)', () => {
    expect(body).toMatch(/export interface CostAlertPayload \{/);
    expect(body).toMatch(/account_id: string;/);
    expect(body).toMatch(/billing_cycle: string;/);
    expect(body).toMatch(/tier: string;/);
    expect(body).toMatch(/severity: AlertSeverity;/);
    expect(body).toMatch(/previous_state: ThresholdState \| null;/);
    expect(body).toMatch(/current_state: ThresholdState;/);
    expect(body).toMatch(/total_cents: number;/);
    expect(body).toMatch(/threshold_soft_cents: number;/);
    expect(body).toMatch(/threshold_hard_cents: number;/);
  });

  it('AlertSink + DispatchResult types: callback shape + alertsFired/alertsSkipped/alertsErrored counters + errors[] (W378 per-account isolation)', () => {
    expect(body).toMatch(/export type AlertSink = \(alert: CostAlertPayload\) => Promise<void>;/);
    expect(body).toMatch(/export interface DispatchResult \{/);
    expect(body).toMatch(/alertsFired: number;/);
    expect(body).toMatch(/alertsSkipped: number;/);
    expect(body).toMatch(/alertsErrored: number;/);
    expect(body).toMatch(/errors: ReadonlyArray<\{ accountId: string; message: string \}>;/);
  });

  it('CostAlertDispatcher: private lastState Map<accountId, ThresholdState> for prior-state recall', () => {
    expect(body).toMatch(/export class CostAlertDispatcher \{/);
    expect(body).toMatch(/private readonly lastState = new Map<string, ThresholdState>\(\);/);
  });

  it('cycle-scoped state: lastCycle field + evaluate drops remembered state when billingCycle changes (no spurious rollover transition)', () => {
    expect(body).toMatch(/private lastCycle: string \| null = null;/);
    expect(body).toMatch(
      /if \(this\.lastCycle !== args\.billingCycle\) \{\s*this\.lastState\.clear\(\);\s*this\.lastCycle = args\.billingCycle;\s*\}/,
    );
  });

  it('evaluate: getOverview accounts + cycle; prior === current → skip (no transition)', () => {
    expect(body).toMatch(
      /Evaluate the given account ids for the given billing cycle\.\s*\*\s*Fires an alert for any account whose threshold state transitioned/,
    );
    expect(body).toMatch(
      /Accounts the cost service can't summarise \(no usage in cycle\) are\s*\*\s*silently skipped — no alert needs firing if there's no spend\./,
    );
    expect(body).toMatch(
      /const summaries = await this\.opts\.service\.getOverview\(\{\s*accountIds: args\.accountIds,\s*billingCycle: args\.billingCycle,\s*\}\);/,
    );
    expect(body).toMatch(/const prior = this\.lastState\.get\(summary\.account_id\) \?\? null;/);
    expect(body).toMatch(/const current = summary\.breakdown\.thresholdState;/);
    expect(body).toMatch(/this\.lastState\.set\(summary\.account_id, current\);/);
    expect(body).toMatch(
      /if \(prior === current\) \{[\s\S]+?alertsSkipped \+= 1;[\s\S]+?continue;/,
    );
  });

  it('evaluate: classifyTransition returns null → record state + skip; non-null → (W378) sendAlert THEN advance lastState (only on success) + alertsFired++, wrapped in a per-account try/catch that counts alertsErrored + continues (no throw)', () => {
    expect(body).toMatch(/const severity = classifyTransition\(prior, current\);/);
    // null-severity (first-run under-soft) still records state before skipping.
    expect(body).toMatch(
      /if \(severity === null\) \{[\s\S]*?this\.lastState\.set\(summary\.account_id, current\);\s*alertsSkipped \+= 1;\s*continue;\s*\}/,
    );
    // W378 — the send is awaited FIRST inside a try; lastState advances AFTER it
    // resolves (only on success → a rejecting sink leaves prior state intact for
    // next-run retry); the catch counts alertsErrored + records the error +
    // continues, so one failing send neither aborts later accounts nor throws.
    expect(body).toMatch(
      /try \{[\s\S]*?await this\.opts\.sendAlert\(buildAlertPayload\(summary, prior, current, severity\)\);[\s\S]*?this\.lastState\.set\(summary\.account_id, current\);[\s\S]*?alertsFired \+= 1;[\s\S]*?\} catch \(err\) \{[\s\S]*?alertsErrored \+= 1;/,
    );
    expect(body).toMatch(/return \{ alertsFired, alertsSkipped, alertsErrored, errors \};/);
  });

  it('sink error detail is credential-redacted and pre/post bounded before alert_errors logging', () => {
    expect(body).toMatch(/import \{ redactText \} from '\.\.\/lib\/redact-url\.js';/);
    expect(body).toMatch(/const ALERT_SINK_ERROR_MAX_CHARS = 500;/);
    expect(body).toMatch(/const ALERT_SINK_ERROR_PRE_REDACT_MAX_CHARS = 2_000;/);
    expect(body).toMatch(/message: safeAlertSinkError\(err\),/);
    expect(body).toMatch(
      // Surrogate-safe on BOTH bounds: a plain slice can cut an emoji in half and
      // the orphaned surrogate reaches the alert sink as U+FFFD.
      /redactText\(sliceWithoutSplittingSurrogate\(raw, ALERT_SINK_ERROR_PRE_REDACT_MAX_CHARS\)\)/,
    );
  });

  it('reset(): test seam — production never resets (deploys do)', () => {
    expect(body).toMatch(
      /Test seam: reset the remembered prior-state map\. Production\s*\*\s*doesn't reset \(deploys do that implicitly\)\./,
    );
    expect(body).toMatch(
      /reset\(\): void \{\s*this\.lastState\.clear\(\);\s*this\.lastCycle = null;\s*\}/,
    );
  });

  it('classifyTransition: prior=null first-ever rules — over-hard→critical, between→warn, under-soft→null', () => {
    expect(body).toMatch(
      /\/\/ First-ever evaluation \(prior null\): only fire if we're already\s*\/\/\s*over a threshold\. Don't alert "still under-soft" on first run\./,
    );
    expect(body).toMatch(
      /if \(prior === null\) \{\s*if \(current === 'over-hard'\) return 'critical';\s*if \(current === 'between-soft-and-hard'\) return 'warn';\s*return null;\s*\}/,
    );
  });

  it('classifyTransition: tightening — current=over-hard&prior≠over-hard→critical, current=between&prior=under-soft→warn', () => {
    expect(body).toMatch(/\/\/ Tightening transitions — escalation alerts\./);
    expect(body).toMatch(
      /if \(current === 'over-hard' && prior !== 'over-hard'\) return 'critical';/,
    );
    expect(body).toMatch(
      /if \(current === 'between-soft-and-hard' && prior === 'under-soft'\) return 'warn';/,
    );
  });

  it('classifyTransition: recovery — !under-soft→under-soft→resolved, over-hard→between→resolved', () => {
    expect(body).toMatch(
      /\/\/ Recovering: spend dropped back below the threshold\. Fire a\s*\/\/\s*'resolved' alert so on-call knows to stand down\./,
    );
    expect(body).toMatch(
      /if \(current === 'under-soft' && prior !== 'under-soft'\) return 'resolved';/,
    );
    expect(body).toMatch(
      /if \(current === 'between-soft-and-hard' && prior === 'over-hard'\) return 'resolved';/,
    );
    expect(body).toMatch(/return null;/);
  });

  it('buildAlertPayload: snake_case fields — total_cents/threshold_soft_cents/threshold_hard_cents from summary', () => {
    expect(body).toMatch(
      /function buildAlertPayload\(\s*summary: CostMonitoringAccountSummary,\s*prior: ThresholdState \| null,\s*current: ThresholdState,\s*severity: AlertSeverity,\s*\): CostAlertPayload/,
    );
    expect(body).toMatch(/total_cents: summary\.breakdown\.totalCents,/);
    expect(body).toMatch(/threshold_soft_cents: summary\.thresholds\.softCents,/);
    expect(body).toMatch(/threshold_hard_cents: summary\.thresholds\.hardCents,/);
  });

  it('imports: CostMonitoringAccountSummary + CostMonitoringService + ThresholdState (type-only)', () => {
    expect(body).toMatch(
      /import type \{ CostMonitoringAccountSummary, CostMonitoringService \} from '\.\/cost-monitoring\.js';/,
    );
    expect(body).toMatch(/import type \{ ThresholdState \} from '\.\.\/lib\/cost-estimator\.js';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
