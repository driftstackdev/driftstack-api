// W555.A — drift guard for /docs/runbooks/cost-monitoring.md.
// V-673 ops reference for V-541.B → V-541.E cost pipeline. Drift
// here either weakens the in-memory-dispatcher-resets-on-deploy
// caveat (would invite false-alarm escalations), drops the
// customer-facing-redacts-numeric-thresholds posture (would
// re-permit customers optimizing right up to the hard line), or
// weakens the 4-state threshold-transition vocabulary.
//
//   • V-673. Shipped in V-541.B → V-541.E.
//   • Architecture: usage tables → UsageAggregator →
//     CostMonitoringService → AlertSink (Sentry/Slack).
//   • Nightly job: cost.recompute_nightly, V-541.E,
//     dedup_on_account_and_type via scheduled_jobs V-202d.
//   • 4 threshold states: under-soft / approaching / over-soft /
//     over-hard. softCents = 60% tier price; hardCents = 90%.
//   • Customer route redacts numeric thresholds. Internal-only.
//   • In-memory dispatcher state resets on deploy (Redis-backing
//     follow-up when volume justifies it).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/runbooks/cost-monitoring.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W555.A /docs/runbooks/cost-monitoring.md content parity', () => {
  const body = read(LIB);

  it("Header + V-673 + V-541 framing pinned: '# Cost monitoring runbook (V-673)' + 'Operational reference for the cost-monitoring pipeline shipped in V-541.B → V-541.E.' + 'A cost alert (`cost.threshold.breached`) fires for a customer.' + 'The nightly recompute (`cost.recompute_nightly` scheduled job) is missing or late.' + 'An operator needs to interpret the customer-facing `GET /v1/account/cost` response when a customer asks \"why is my number different from what I see in my invoice?\"' — pinned so the V-673-runbook + V-541.B-V-541.E-pipeline + cost.threshold.breached + cost.recompute_nightly + customer-asks-why-different-from-invoice commitment survives", () => {
    expect(body).toMatch(/^# Cost monitoring runbook \(V-673\)$/m);
    expect(body).toMatch(/Operational reference for the cost-monitoring pipeline shipped in/);
    expect(body).toMatch(/V-541\.B → V-541\.E\./);
    expect(body).toMatch(/- A cost alert \(`cost\.threshold\.breached`\) fires for a customer\./);
    expect(body).toMatch(/- The nightly recompute \(`cost\.recompute_nightly` scheduled job\) is/);
    expect(body).toMatch(/missing or late\./);
    expect(body).toMatch(/- An operator needs to interpret the customer-facing/);
    expect(body).toMatch(/`GET \/v1\/account\/cost` response when a customer asks "why is my/);
    expect(body).toMatch(/number different from what I see in my invoice\?"/);
  });

  it("Architecture + state-storage framing pinned: 'CostMonitoringService' + '(V-541.B, pure)' + 'CostAlertDispatcher' + '(V-541.C, in-memory prior-state map)' + 'AlertSink' + '(Sentry/Slack)' + 'Per-tier rates              | `CostRates` config — wired at app boot (`config/cost-rates.ts`)' + 'Per-tier thresholds       | `tierThresholds` map — wired at app boot' + 'Last-seen threshold state | **In-memory** on the dispatcher (Map<accountId, ThresholdState>)' + 'Scheduled-job ledger      | `scheduled_jobs` table (V-202d)' + '**Important — dispatcher state is in-memory.**' + 'The first nightly tick after a deploy will re-alert every account currently above `over-soft`' — pinned so the V-541.B-pure-CostMonitoringService + V-541.C-in-memory-CostAlertDispatcher + Sentry/Slack-AlertSink + CostRates-config + tierThresholds-map + scheduled_jobs-V-202d + first-nightly-tick-re-alerts-over-soft commitment survives", () => {
    expect(body).toMatch(/CostMonitoringService/);
    expect(body).toMatch(/\(V-541\.B, pure\)/);
    expect(body).toMatch(/CostAlertDispatcher/);
    expect(body).toMatch(/\(V-541\.C, in-memory/);
    expect(body).toMatch(/prior-state map\)/);
    expect(body).toMatch(/AlertSink/);
    expect(body).toMatch(/\(Sentry\/Slack\)/);
    expect(body).toMatch(
      /Per-tier rates\s+\|\s+`CostRates` config — wired at app boot \(`config\/cost-rates\.ts`\)/,
    );
    expect(body).toMatch(/Per-tier thresholds\s+\|\s+`tierThresholds` map — wired at app boot/);
    expect(body).toMatch(
      /Last-seen threshold state \| \*\*In-memory\*\* on the dispatcher \(Map<accountId, ThresholdState>\)/,
    );
    expect(body).toMatch(/Scheduled-job ledger\s+\|\s+`scheduled_jobs` table \(V-202d\)/);
    expect(body).toMatch(/> \*\*Important — dispatcher state is in-memory\.\*\*/);
    expect(body).toMatch(
      /The first nightly tick\s*> after a deploy will re-alert every account currently above/,
    );
    expect(body).toMatch(/> `over-soft`/);
  });

  it("4-threshold-state vocabulary + soft/hard rule-of-thumb framing pinned: '`under-soft → approaching → over-soft → over-hard`' + '`softCents` — first alert; \"approaching the limit\" — friendly notice' + '`hardCents` — second alert; \"over the limit\" — operator action' + '`softCents = round(P * 0.6)`' + '`hardCents = round(P * 0.9)`' + 'The customer-facing route (`GET /v1/account/cost`) intentionally **redacts** the numeric thresholds from the response' + 'the customer sees a categorical `thresholdState` (`under-soft` / `approaching` / `over-soft` / `over-hard`)' + 'This prevents customers from optimising right up to the hard line.' — pinned so the 4-threshold-state-arrow + softCents-0.6P + hardCents-0.9P + customer-route-redacts-numeric + categorical-thresholdState + no-optimize-to-hard-line commitment survives", () => {
    expect(body).toMatch(/`under-soft → approaching → over-soft →\s*over-hard`/);
    expect(body).toMatch(/- `softCents` — first alert; "approaching the limit" — friendly notice/);
    expect(body).toMatch(/- `hardCents` — second alert; "over the limit" — operator action/);
    expect(body).toMatch(/2\. `softCents = round\(P \* 0\.6\)` — gives the customer headroom to/);
    expect(body).toMatch(/3\. `hardCents = round\(P \* 0\.9\)` — leaves ~10% margin between cost/);
    expect(body).toMatch(/The customer-facing route \(`GET \/v1\/account\/cost`\) intentionally/);
    expect(body).toMatch(/\*\*redacts\*\* the numeric thresholds from the response — the customer/);
    expect(body).toMatch(/sees a categorical `thresholdState` \(`under-soft` \/ `approaching` \//);
    expect(body).toMatch(/`over-soft` \/ `over-hard`\) but not the operator-tuned cents values\./);
    expect(body).toMatch(/This prevents customers from optimising right up to the hard line\./);
  });

  it("Triage workflow + admin route framing pinned: '### Triage an alert' + 'Open the alert in Sentry / the alert sink and grab `account_id`' + 'curl -H \"Authorization: Bearer <internal-admin-key>\" \\' + '$BASE_URL/v1/admin/cost/accounts/<account_id>?billing_cycle=<YYYY-MM>' + 'Identify which line dominates the total (`computeCents`, `storageCents`, `egressCents`, `emailCents`, `llmCents`).' + 'If `severity == 'critical'` (over-hard) — page on-call. Hard threshold means the account is past the cost ceiling we'd be willing to absorb for a single billing cycle.' + 'If `severity == 'warning'` (over-soft) — file a follow-up to contact the customer within 48h about upgrading or shaping their usage.' — pinned so the Triage-alert-procedure + admin-cost-accounts-curl + 5-line-breakdown-inventory + critical-page-on-call + warning-48h-follow-up commitment survives", () => {
    expect(body).toMatch(/### Triage an alert/);
    expect(body).toMatch(/1\. Open the alert in Sentry \/ the alert sink and grab `account_id`/);
    expect(body).toMatch(/curl -H "Authorization: Bearer <internal-admin-key>" \\/);
    expect(body).toMatch(
      /"\$BASE_URL\/v1\/admin\/cost\/accounts\/<account_id>\?billing_cycle=<YYYY-MM>"/,
    );
    expect(body).toMatch(/3\. Identify which line dominates the total \(`computeCents`,/);
    expect(body).toMatch(/`storageCents`, `egressCents`, `emailCents`, `llmCents`\)\./);
    expect(body).toMatch(/5\. If `severity == 'critical'` \(over-hard\) — page on-call\. Hard/);
    expect(body).toMatch(/threshold means the account is past the cost ceiling we'd be/);
    expect(body).toMatch(/willing to absorb for a single billing cycle\./);
    expect(body).toMatch(/6\. If `severity == 'warning'` \(over-soft\) — file a follow-up to/);
    expect(body).toMatch(/contact the customer within 48h about upgrading or shaping their/);
    expect(body).toMatch(/usage\./);
  });

  it("Customer-confusion script + failure-modes framing pinned: '## When the customer asks \"why doesn't this match my Stripe invoice?\"' + 'The cost-monitoring numbers are an **internal cost projection**, not a Stripe-issued invoice.' + 'The cost-monitoring window is the **current calendar UTC month**.' + 'The Stripe billing cycle anchors on the customer's subscription start date.' + 'The dashboard's usage panel shows our internal cost projection' + 'Your Stripe invoice is the source of truth for what you actually pay — it follows your subscription's billing cycle, not the calendar month, and includes the tier subscription on top of any metered usage.' + 'Nightly job hasn't enqueued in >24h' + 'Re-alerts after every deploy' + 'Customer breakdown shows zero' + '`GET /v1/account/cost` 403s' — pinned so the internal-cost-projection-vs-Stripe-invoice + calendar-UTC-month-vs-subscription-cycle + customer-script-text + 4-failure-mode-row commitment survives", () => {
    expect(body).toMatch(/## When the customer asks "why doesn't this match my Stripe invoice\?"/);
    expect(body).toMatch(
      /The cost-monitoring numbers are an \*\*internal cost projection\*\*, not/,
    );
    expect(body).toMatch(/a Stripe-issued invoice\./);
    expect(body).toMatch(
      /- The cost-monitoring window is the \*\*current calendar UTC month\*\*\./,
    );
    expect(body).toMatch(/The Stripe billing cycle anchors on the customer's subscription/);
    expect(body).toMatch(/start date\./);
    expect(body).toMatch(/> "The dashboard's usage panel shows our internal cost projection/);
    expect(body).toMatch(/> for the current calendar month so you can plan ahead\. Your Stripe/);
    expect(body).toMatch(/> invoice is the source of truth for what you actually pay — it/);
    expect(body).toMatch(/> follows your subscription's billing cycle, not the calendar month,/);
    expect(body).toMatch(/> and includes the tier subscription on top of any metered usage\."/);
    expect(body).toMatch(/Nightly job hasn't enqueued in >24h/);
    expect(body).toMatch(/Re-alerts after every deploy/);
    expect(body).toMatch(/Customer breakdown shows zero/);
    expect(body).toMatch(/`GET \/v1\/account\/cost` 403s/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
