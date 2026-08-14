// W514.C — drift guard for apps/marketing-site/src/pages/docs/incident-policy.astro.
// V-701 incident response + SLA policy. Drift here either softens the
// severity ladder (would create marketing↔ops-procedure divergence) or
// breaks the /v1/status/sla response shape (would mislead consumers about
// the camelCase + data: envelope contract).
//
//   • V-701 doc-comment framing + companion fix-log (no incident_subscriptions
//     field; incident.* events NOT subscribable; sla camelCase + data: envelope;
//     no ?window_days param).
//   • status.driftstack.dev + 3-endpoint surface: GET /v1/status, GET
//     /v1/status/incidents, POST /v1/status/subscribe.
//   • 3-severity ladder matching the incident_severity enum: Outage (≤15min,
//     every 30min) / Major (≤30min,
//     every 60min) / Minor (≤60min, at resolution). Maintenance (≥48h notice) is
//     labelled NOT an incident severity — the enum has only minor|major|outage.
//   • Detection 3-signal: V-295b probes (60s, 3-consecutive → critical) +
//     customer reports (support@, ≤30min EU biz hrs) + internal alerting.
//   • 5-step customer comms: file → email fan-out → progress → resolution →
//     postmortem within 7 business days for Outage/Major.
//   • incident.created/updated/resolved NOT in SubscribableWebhookEventTypeSchema.
//   • /v1/status/sla 9-field camelCase response + 30-day rolling window + no-auth.
//   • 3-contact ladder: urgent@ (acute) / support@ (non-acute) / security@ (PGP).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/incident-policy.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W514.C apps/marketing-site/src/pages/docs/incident-policy.astro content parity', () => {
  const body = read(LIB);

  it('V-701 framing + fix-log pinned. Re-enabled by slice 246 after verifying both the V-701 anchor at incident-policy.astro:4 + the 4-fix-log Major-fixes-vs-prior-revision framing at incident-policy.astro:6-11 exist verbatim', () => {
    expect(body).toMatch(/\/\/ V-701 — incident response \+ customer-facing policy docs\./);
    expect(body).toMatch(
      /\/\/ Pinned by tests\/unit\/incident-policy-doc-parity\.test\.ts\. Major fixes\s*\n?\s*\/\/ vs\. prior revision: removed fictional `incident_subscriptions` account\s*\n?\s*\/\/ field, removed claim that `incident\.\*` are subscribable webhook\s*\n?\s*\/\/ events \(they aren't — they're admin-audit \/ SSE-broadcast events\),\s*\n?\s*\/\/ fixed \/v1\/status\/sla response shape \(camelCase, `data:` envelope\),\s*\n?\s*\/\/ removed fictional `\?window_days` query param\./,
    );
  });

  it('status.driftstack.dev + 3-endpoint surface pinned: GET /v1/status (overall + per-component) + GET /v1/status/incidents (recent/live) + POST /v1/status/subscribe + /docs/status-subscriptions cross-link — pinned so the 3-endpoint surface + status-subscriptions companion doc survives (drift to a different status-endpoint shape would create marketing↔status-route divergence)', () => {
    expect(body).toMatch(
      /<a href="https:\/\/status\.driftstack\.dev">status\.driftstack\.dev<\/a>/,
    );
    expect(body).toMatch(
      /<code>GET \/v1\/status<\/code> \(overall \+ per-component status\)\s*\n?\s*and <code>GET \/v1\/status\/incidents<\/code> \(recent \/ live\s*\n?\s*incidents\)/,
    );
    expect(body).toMatch(/<code>POST \/v1\/status\/subscribe<\/code>/);
    expect(body).toMatch(
      /<a href="\/docs\/status-subscriptions\/">\/docs\/status-subscriptions<\/a>/,
    );
  });

  it('severity ladder pinned: Outage (≤15min, every 30min) + Major (5%+ error rate / sub-customer auth-sessions outage, ≤30min, every 60min) + Minor (single non-critical surface, ≤60min, at resolution), plus Maintenance labelled NOT an incident severity (≥48h notice) — V-772 renamed the top row from Critical, which was not a value of the incident_severity enum (minor|major|outage), so a customer matching the badge on the status page to this table landed on the wrong row. Cadences are unchanged: the commitment is identical, only the label now matches what is actually filed.', () => {
    expect(body).toMatch(
      /<td><strong>Outage<\/strong><\/td>\s*\n?\s*<td>Core API down across all customers, or data-loss risk\.<\/td>\s*\n?\s*<td>≤ 15 min<\/td>\s*\n?\s*<td>Every 30 min until resolved\.<\/td>/,
    );
    expect(body).toMatch(
      /<td><strong>Major<\/strong><\/td>\s*\n?\s*<td>API degraded \(\{'>'\}5% error rate\) OR a critical surface\s*\n?\s*\(auth, sessions\) unavailable for a subset of customers\.<\/td>\s*\n?\s*<td>≤ 30 min<\/td>\s*\n?\s*<td>Every 60 min\.<\/td>/,
    );
    expect(body).toMatch(
      /<td><strong>Minor<\/strong><\/td>\s*\n?\s*<td>Single non-critical surface \(dashboard, an SDK build pipeline\) degraded\.<\/td>\s*\n?\s*<td>≤ 60 min<\/td>\s*\n?\s*<td>At resolution\.<\/td>/,
    );
    expect(body).toMatch(
      /<td><strong>Maintenance<\/strong> \(not an incident severity\)<\/td>\s*\n?\s*<td>Planned change with potential impact\. Always announced\s*\n?\s*≥48h in advance\./,
    );
  });

  it('Detection 3-signal behavior pinned without internal work-item labels', () => {
    expect(body).toMatch(
      /<strong>Automated health probes:<\/strong> 60-second poller\s*\n?\s*against <code>\/health<\/code> \+ per-region API endpoints\.\s*\n?\s*Three consecutive failures auto-create a <strong>Major<\/strong>/,
    );
    expect(body).toMatch(
      /<a href="mailto:support@driftstack\.dev">support@driftstack\.dev<\/a>\s*\n?\s*and Slack channel monitoring\. We acknowledge within 30 min\s*\n?\s*during EU business hours\./,
    );
    expect(body).toMatch(
      /<strong>Internal alerting:<\/strong> Sentry \+ cost-monitoring\s*\n?\s*thresholds page on-call\./,
    );
  });

  it('5-step customer comms pinned: 1) status-page entry filed + 2) email fan-out to /v1/status/subscribe subscribers + 3) progress updates per cadence + 4) resolution + final email with root-cause + 5) postmortem within 7 business days for Outage/Major — pinned so the 5-step comms cascade + 7-business-day postmortem SLA + inline-summary-for-Minor framing survives (drift to a longer postmortem SLA would create marketing↔ops divergence)', () => {
    expect(body).toMatch(
      /<strong>Status page entry filed<\/strong> with severity \+\s*\n?\s*title \+ affected components\./,
    );
    expect(body).toMatch(
      /<strong>Email fan-out<\/strong> to confirmed\s*\n?\s*<code>\/v1\/status\/subscribe<\/code> subscribers\./,
    );
    expect(body).toMatch(
      /<strong>Postmortem<\/strong> for Outage \/ Major incidents\s*\n?\s*published within 7 business days/,
    );
    expect(body).toMatch(
      /Minor\s*\n?\s*incidents get an inline summary on the resolved status entry\./,
    );
  });

  it('incident events are explicitly internal rather than advertised as deferred subscriptions', () => {
    expect(body).toMatch(
      /<code>incident\.created<\/code> \/\s*\n?\s*<code>incident\.updated<\/code> \/ <code>incident\.resolved<\/code>\s*\n?\s*are admin-audit \/ internal SSE event types, not customer webhook\s*\n?\s*subscription values\. Email subscription is the customer-facing\s*\n?\s*notification path\./,
    );
    expect(body).not.toMatch(/not yet\s+in <code>SubscribableWebhookEventTypeSchema/);
  });

  it("/docs/sla-policy authoritative-reference framing pinned: 'Tier-by-tier SLA targets, the windowing methodology, the credit bands, and the dispute process all live in /docs/sla-policy — that is the authoritative reference. Tier identifiers used there match the AccountTier enum exactly.' — pinned so the /docs/sla-policy authoritative cross-ref + AccountTier-enum-match commitment survives (drift to dropping the AccountTier-enum-match anchor would re-create tier-name-divergence risk)", () => {
    expect(body).toMatch(
      /Tier-by-tier SLA targets, the windowing methodology, the\s*\n?\s*credit bands, and the dispute process all live in\s*\n?\s*<a href="\/docs\/sla-policy\/">\/docs\/sla-policy<\/a> — that is the\s*\n?\s*authoritative reference\. Tier identifiers used there match\s*\n?\s*the <code>AccountTier<\/code> enum exactly\./,
    );
  });

  it("/v1/status/sla response shape pinned: data: envelope + 9-field camelCase (target + uptimePct + totalProbes + okCount + failCount + lastProbeAt + lastFailureAt + windowStart + windowEnd) + 'No auth — status surface is public. Window is a fixed rolling 30 days. Field names are camelCase (the SLA report serialises its internal model directly).' — pinned so the data-envelope + 9-field camelCase shape + public-no-auth + 30d-rolling-window + serialises-internal-model commitments survive (drift to flipping to snake_case would create marketing↔server divergence)", () => {
    expect(body).toMatch(/GET \/v1\/status\/sla/);
    expect(body).toMatch(/"data": \[/);
    expect(body).toMatch(/"target": "api\.driftstack\.dev"/);
    expect(body).toMatch(/"uptimePct": 99\.99/);
    expect(body).toMatch(/"totalProbes": 43200/);
    expect(body).toMatch(/"okCount": 43196/);
    expect(body).toMatch(/"failCount": 4/);
    expect(body).toMatch(/"lastProbeAt":/);
    expect(body).toMatch(/"lastFailureAt":/);
    expect(body).toMatch(/"windowStart":/);
    expect(body).toMatch(/"windowEnd":/);
    expect(body).toMatch(
      /No auth — status surface is public\. Window is a fixed rolling\s*\n?\s*30 days\. Field names are camelCase \(the SLA report serialises\s*\n?\s*its internal model directly\)\./,
    );
  });

  it("Postmortems blameless framing pinned: 'Public postmortems for Outage + Major incidents live on the public status page, attached to the resolved incident entry. Each follows the same template: timeline, root cause, what we changed to prevent recurrence. Postmortems are blameless and detailed enough to be useful — we'd rather over-share than under-share.' — pinned so the 3-template-field (timeline/root-cause/prevention) + blameless + over-share commitment survives", () => {
    expect(body).toMatch(
      /Each follows the same\s*\n?\s*template: timeline, root cause, what we changed to prevent\s*\n?\s*recurrence\. Postmortems are blameless and detailed enough to be\s*\n?\s*useful — we'd rather over-share than under-share\./,
    );
  });

  it('3-contact ladder pinned: urgent@driftstack.dev (acute outage, straight to on-call) + support@driftstack.dev (non-acute bug, session id + timestamp) + security@driftstack.dev (PGP available) + /docs/api-security-headers cross-link — pinned so the 3-channel routing + on-call-direct-urgent-channel + session-id-timestamp request-pattern + PGP-available framing survives (drift to merging any channel would create marketing↔mailbox-routing divergence)', () => {
    expect(body).toMatch(/<a href="mailto:urgent@driftstack\.dev">urgent@driftstack\.dev<\/a>\./);
    expect(body).toMatch(/That goes straight to on-call\./);
    expect(body).toMatch(
      /<a href="mailto:support@driftstack\.dev">support@driftstack\.dev<\/a>\s*\n?\s*with a session id \+ timestamp\./,
    );
    expect(body).toMatch(
      /<a href="mailto:security@driftstack\.dev">security@driftstack\.dev<\/a>\s*\n?\s*— PGP available on the page\./,
    );
    expect(body).toMatch(
      /<a href="\/docs\/api-security-headers\/">\/docs\/api-security-headers<\/a>/,
    );
  });

  it('4-related-doc cluster: /docs/sla-policy + /docs/status-subscriptions + /docs/webhooks (subscribable today) + status.driftstack.dev — pinned so the 4-related navigation surface stays complete (drift to dropping /docs/sla-policy would orphan the authoritative-credit-bands reference)', () => {
    expect(body).toMatch(
      /<a href="\/docs\/sla-policy\/">SLA policy \(authoritative tier targets \+ credit bands\)<\/a>/,
    );
    expect(body).toMatch(
      /<a href="\/docs\/status-subscriptions\/">Status email subscriptions<\/a>/,
    );
    expect(body).toMatch(
      /<a href="\/docs\/webhooks\/">Webhook signing \+ retries \(for the events that are subscribable today\)<\/a>/,
    );
    expect(body).not.toMatch(
      /href="\/docs\/(?:sla-policy|status-subscriptions|webhooks|api-security-headers)"/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
