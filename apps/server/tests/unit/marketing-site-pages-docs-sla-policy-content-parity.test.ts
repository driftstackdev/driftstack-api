// W512.A — drift guard for apps/marketing-site/src/pages/docs/sla-policy.astro.
// V-711 SLA policy. Drift here either softens an availability target
// (would put Driftstack on the hook for credits without procurement
// approval) or breaks the credit-mechanics table (would create
// marketing↔billing-system divergence).
//
//   • V-711 doc-comment framing.
//   • 5-tier availability ladder: trial_pack/api_starter (no SLA) +
//     solo_manual (99.5%) + team/api_builder (99.9%) + agency/api_scale
//     (99.95%) + enterprise (99.99% per addendum).
//   • Tier-upgrade mid-month SLA boundary.
//   • What's covered 3-surface: /v1 API + dashboard + live-view stream.
//   • What's NOT covered 4-exclusion: maintenance + customer-supplied
//     target + sub-processor outages + force majeure.
//   • Measurement: V-295b probes + 5s timeout + 3-consecutive-probe +
//     2-of-3-locations.
//   • Credit table: <target → 5% / <99% → 10% / <95% → 25%.
//   • 30-day claim window + 5 business day reconciliation.
//   • Enterprise addenda 4-list.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/sla-policy.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W512.A apps/marketing-site/src/pages/docs/sla-policy.astro content parity', () => {
  const body = read(LIB);

  it('V-711 framing pinned. Re-enabled by slice 203 after verifying the V-711 comment exists at sla-policy.astro:4-7 with the matching shape', () => {
    expect(body).toMatch(
      /\/\/ V-711 — SLA policy for the public API \+ dashboard\. Companion to\s*\n?\s*\/\/ \/docs\/incident-policy \(operational response\) and \/docs\/api-versioning\s*\n?\s*\/\/ \(deprecation timelines\)\. Pitched at procurement \/ customer security\s*\n?\s*\/\/ review\./,
    );
  });

  it('Availability table aligned to ToS §9 (S43 2026-07-07, founder-approved): §9.1 tiers (free / solo_manual / team_manual / agency_manual / api_starter / api_builder) carry NO contractual SLA (best effort); §9.2 tiers api_scale + enterprise carry 99.9% / ~43m + the Severity-1 first-response column (4h / 1h). The old 99.5/99.9/99.95/99.99 5-row ladder contradicted the binding ToS and must not reappear.', () => {
    expect(body).toMatch(
      /<tr><td><code>free<\/code> \/ <code>solo_manual<\/code> \/ <code>team_manual<\/code> \/ <code>agency_manual<\/code> \/ <code>api_starter<\/code> \/ <code>api_builder<\/code><\/td><td>—<\/td><td>\(no contractual SLA — best effort, ToS §9\.1\)<\/td><td>—<\/td><\/tr>/,
    );
    expect(body).toMatch(
      /<tr><td><code>api_scale<\/code><\/td><td>99\.9%<\/td><td>~43m<\/td><td>4 hours<\/td><\/tr>/,
    );
    expect(body).toMatch(
      /<tr><td><code>enterprise<\/code><\/td><td>99\.9%<\/td><td>~43m<\/td><td>1 hour<\/td><\/tr>/,
    );
    // The ToS-contradicting ladder rows must not reappear.
    expect(body).not.toMatch(/99\.95%/);
    expect(body).not.toMatch(/99\.99%/);
    expect(body).not.toMatch(/<code>solo_manual<\/code><\/td><td>99\.5%/);
    // §9.1/§9.2 tier split quoted from the ToS.
    expect(body).toMatch(
      /the Free, Manual-ladder\s*\n?\s*\(Personal, Team, Agency\), API Starter, and API Builder tiers are\s*\n?\s*provided <strong>without<\/strong> a contractually-binding\s*\n?\s*service level agreement/,
    );
    expect(body).toMatch(
      /first-response SLA on Severity-1 incidents of four\s*\n?\s*\(4\) hours on API Scale and one \(1\) hour on Enterprise/,
    );
  });

  it("Mid-month-upgrade SLA boundary framing pinned (S43 wording: 'a mid-month upgrade into an SLA-carrying tier does not retroactively apply the commitment') — pinned so the immediate-effect + no-retroactive-commitment posture survives (drift to retroactive application would invite credits for downtime before the upgrade-paid moment)", () => {
    expect(body).toMatch(
      /Tier upgrades take effect immediately on payment confirmation;\s*\n?\s*SLA credit accruals reset at the boundary so a mid-month upgrade\s*\n?\s*into an SLA-carrying tier does not retroactively apply the\s*\n?\s*commitment\./,
    );
  });

  it("What's-covered 3-surface: api.driftstack.dev + app.driftstack.dev + live-view streaming — pinned so the 3-surface SLA coverage scope stays explicit (drift to dropping the dashboard would make customers question whether the dashboard is in scope; drift to dropping the live-view stream would orphan the most-customer-facing surface)", () => {
    expect(body).toMatch(
      /<li><code>https:\/\/api\.driftstack\.dev\/\*<\/code> — every documented endpoint\.<\/li>/,
    );
    expect(body).toMatch(
      /<li><code>https:\/\/app\.driftstack\.dev\/\*<\/code> — the customer dashboard\.<\/li>/,
    );
    expect(body).toMatch(/<li>The live-view streaming endpoints for an active session\.<\/li>/);
  });

  it("What's-NOT-covered 4-exclusion: scheduled maintenance (>72h notice + 4h/month cap) + customer-supplied target_url/profile/script + sub-processor outages (NowPayments/Stripe/Postmark) + force majeure — pinned so the 4-exclusion list + the 4h/month maintenance-window cap + the explicit sub-processor list (NowPayments + Stripe + Postmark) survive (drift to dropping the 72h-notice or 4h cap would let maintenance be invoked-without-bound; drift to dropping the sub-processor list would invite blame for upstream issues)", () => {
    expect(body).toMatch(
      /Scheduled maintenance windows announced &gt;72h in advance\s*\n?\s*on <a href="https:\/\/status\.driftstack\.dev">status\.driftstack\.dev<\/a>\./,
    );
    expect(body).toMatch(
      /Maintenance windows are capped at 4h\/month and rarely\s*\n?\s*triggered/,
    );
    expect(body).toMatch(
      /Failures attributable to a customer-supplied\s*\n?\s*<code>target_url<\/code>, profile state, or script/,
    );
    expect(body).toMatch(
      /Sub-processor outages we cannot route around: NowPayments\s*\n?\s*IPN delivery, Stripe Checkout, Postmark email\./,
    );
    expect(body).toMatch(
      /Force majeure: regional cloud-provider failures, large-scale\s*\n?\s*DDoS against shared infrastructure, government-mandated\s*\n?\s*shutdowns\./,
    );
  });

  it('Measurement framing pins the automated health-probe service', () => {
    expect(body).toMatch(/our automated health-probe service/);
    expect(body).toMatch(
      /<li><code>GET \/health<\/code> — the API health endpoint \(alias\s*\n?\s*<code>\/healthz<\/code>\)\.<\/li>/,
    );
    expect(body).toMatch(/<li><code>GET \/<\/code> on the dashboard/);
    expect(body).toMatch(/A probe is "failed" when it returns non-2xx OR exceeds 5s\./);
    expect(body).toMatch(
      /Probes run every 60s from three geo-distributed locations, and a\s*\n?\s*minute counts as downtime only when ≥ 2 of 3 locations register\s*\n?\s*a failure for that minute \(so a single region's ISP routing\s*\n?\s*issue isn't counted against us\)\./,
    );
    // Anti-drift: the previous "3+ consecutive probes fail" downtime rule was
    // superseded by the 2-of-3-locations quorum rule; ban its return.
    expect(body).not.toMatch(/counted as downtime when 3\+ consecutive probes fail/);
  });

  it("Credit-table 3-tier: <target ≥ 99.0% → 5% + <99.0% ≥ 95.0% → 10% + <95.0% → 25% + 'Credits are capped at the customer's monthly subscription fee for that month — they cannot exceed what was paid.' + 'Credits do not apply to per-minute or per-session usage charges, only the tier subscription line.' — pinned so the 3-tier credit ladder + cap-at-monthly-fee + subscription-only commitment survive (drift to higher percentages would put Driftstack on the hook for credits beyond contract; drift to dropping the usage-charge exclusion would expand the credit base beyond what's intended)", () => {
    // S43 2026-07-07 — first band names the §9.2 99.9% commitment
    // explicitly (was "Below target"); credits scoped to the
    // SLA-carrying tiers (API Scale + Enterprise).
    expect(body).toMatch(/<tr><td>Below 99\.9%, ≥ 99\.0%<\/td><td>5%<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>Below 99\.0%, ≥ 95\.0%<\/td><td>10%<\/td><\/tr>/);
    expect(body).toMatch(/<tr><td>Below 95\.0%<\/td><td>25%<\/td><\/tr>/);
    expect(body).toMatch(/<h2>Credit mechanics \(API Scale \+ Enterprise\)<\/h2>/);
    expect(body).toMatch(
      /Credits are capped at the customer's monthly subscription fee\s*\n?\s*for that month — they cannot exceed what was paid\./,
    );
    expect(body).toMatch(
      /Credits do\s*\n?\s*not apply to per-minute or per-session usage charges, only the\s*\n?\s*tier subscription line\./,
    );
  });

  it('30-day-claim-window + 5-business-day-reconcile + billing@driftstack.dev + line-item-on-next-invoice framing pinned — pinned so the 30-day claim deadline + 5-business-day reconciliation SLA + the billing@ routing + the line-item credit-application all survive (drift to dropping the 30-day deadline would let stale claims surface; drift to a different reconciliation window would create marketing↔ops divergence)', () => {
    expect(body).toMatch(
      /Email <a href="mailto:billing@driftstack\.dev">billing@driftstack\.dev<\/a>\s*\n?\s*within 30 days of the calendar month closing\./,
    );
    expect(body).toMatch(
      /We reconcile against the probe data \+ the audit trail on\s*\n?\s*status\.driftstack\.dev within 5 business days\. Approved credits\s*\n?\s*appear on the next invoice as a line-item\./,
    );
  });

  it("Enterprise addenda 4-list: higher-per-incident-credit + P95-latency-budgets + 24/7-named-first-responders + maintenance-pre-approval — pinned so the 4-addendum negotiable surface stays explicit (drift to dropping P95-latency-budgets would close off the degraded-but-not-down credit shape; drift to dropping the 24/7 named-responder option would orphan high-criticality customers; the explicit floor framing 'addenda only ever strengthen' protects the SLA from being weakened mid-contract)", () => {
    expect(body).toMatch(/<li>Higher per-incident credit percentages\.<\/li>/);
    expect(body).toMatch(
      /<li>Hard ceilings on degraded-but-not-down windows \(P95 latency\s*\n?\s*budgets\)\.<\/li>/,
    );
    expect(body).toMatch(/<li>Dedicated 24\/7 oncall pager with named first responders\.<\/li>/);
    expect(body).toMatch(/<li>Maintenance-window pre-approval rights\.<\/li>/);
    // S43 2026-07-07 — floor framing plus the ToS §9.2
    // negotiated-SLA-governs clause quoted.
    expect(body).toMatch(
      /The SLA above is the floor — addenda\s*\n?\s*only ever strengthen it, and per ToS §9\.2 a negotiated SLA\s*\n?\s*governs in case of conflict with this page\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
