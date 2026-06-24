// W758 — customer-dashboard /subscription.astro V-134 (drill-down
// from /billing) parity. Eighty-fourth in the cross-SDK drift-guard
// series.
//
// /subscription is the V-134 scaffolding deeper drill-down from
// /billing. Plan history + change-plan preview + full invoice list.
// Drift to the upgrade/downgrade-policy framing would let customer
// proration expectations diverge from server-side Stripe behavior.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/subscription.astro');

describe('W758 dashboard /subscription page V-134 parity', () => {
  it('subscription.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-134 scaffolding + drill-down-from-billing framing pinned. The "V-134 scaffolding. Real reads against /v1/billing land later. /subscription is a deeper drill-down from /billing — plan history, upgrade/downgrade preview, full invoice list. /billing stays the at-a-glance card; /subscription is for the detail" wording is the load-bearing cross-page contract.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-134 scaffolding\. Real reads against \/v1\/billing land later\./);
    expect(p).toMatch(/\/subscription is a deeper drill-down from \/billing — plan history,/);
    expect(p).toMatch(/upgrade\/downgrade preview, full invoice list\. \/billing stays the/);
    expect(p).toMatch(/at-a-glance card; \/subscription is for the detail\./);
  });

  it("CRITICAL upgrade-immediate + downgrade-end-of-period framing pinned. The 'Upgrades take effect immediately and prorate your remaining period. Downgrades take effect at the end of the current period — you keep your current cap until renewal.' wording is the load-bearing customer proration framing — drift would mismatch Stripe behavior.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Upgrades take effect immediately and prorate your remaining period\.\s*\n\s+Downgrades take effect at the end of the current period — you keep\s*\n\s+your current cap until renewal\./,
    );
  });

  it('CRITICAL honest empty states for plan history + invoices. The fabricated PLAN_HISTORY / INVOICES arrays were removed (the API exposes neither); both sections render neutral empty-state copy. No invented dollar amounts, statuses, or dead Download-PDF links may ship.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Plan history isn't available yet\./);
    expect(p).toMatch(/No invoices yet\./);
    expect(p).not.toMatch(/PLAN_HISTORY/);
    expect(p).not.toMatch(/const INVOICES/);
    expect(p).not.toMatch(/REASON_LABEL/);
    expect(p).not.toMatch(/function fmtUsd/);
    expect(p).not.toMatch(/Download PDF/);
    expect(p).not.toMatch(/in_test_/);
    expect(p).not.toMatch(/Invoice PDFs hosted by Stripe/);
  });

  it("CRITICAL back-link to /billing pinned. The '← Back to billing' anchor is the canonical cross-link from /subscription drill-down back to /billing at-a-glance.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /<a href="\/billing" class="text-tk-accent hover:underline">← Back to billing<\/a>/,
    );
  });

  it("CRITICAL 'For quick subscription state' cross-link pinned. The 'For quick subscription state see /billing.' framing tells drill-down-arrivers where the lighter view is.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /For\s*\n\s+quick subscription state see <a href="\/billing" class="text-tk-accent underline">\/billing<\/a>\./,
    );
  });

  it('CRITICAL 3-action CTA set — Upgrade + Downgrade + Stripe portal. The dashboard-card flex-wrap-gap-3 layout keeps the 3 buttons together on desktop + stacks on narrow screens.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/<a href="#upgrade" class="btn-primary">Upgrade plan<\/a>/);
    expect(p).toMatch(/<a href="#downgrade" class="btn-secondary">Downgrade plan<\/a>/);
    expect(p).toMatch(/<a href="#portal" class="btn-secondary">Open Stripe portal<\/a>/);
  });

  it('CRITICAL MOCK_SUBSCRIPTION null-coalescing for status display. The "No subscription" header copy + the conditional "renews" row is what avoids rendering null status to customers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\{MOCK_SUBSCRIPTION \? MOCK_SUBSCRIPTION\.tier : 'No subscription'\}/);
    expect(p).toMatch(/\{\s*\n\s+MOCK_SUBSCRIPTION && \(/);
  });

  it('CRITICAL period-end null fallback to em-dash pinned. The `current_period_end ? fmtIsoDay(...) : "—"` ternary protects against null subscriptions rendering "null".', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\{MOCK_SUBSCRIPTION\.current_period_end\s*\n\s+\? fmtIsoDay\(MOCK_SUBSCRIPTION\.current_period_end\)\s*\n\s+: '—'\}/,
    );
  });

  it('CRITICAL fmtIsoDay() formats to YYYY-MM-DD only (calendar-day granularity). Subscription dates are calendar-day not minute. Matches W748+W751 home/billing fmtIsoDay.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /function fmtIsoDay\(iso: string\): string \{\s*\n\s+return new Date\(iso\)\.toISOString\(\)\.slice\(0, 10\);\s*\n\}/,
    );
  });

  it('CRITICAL DashboardLayout used. /subscription IS sidebar-enabled.', () => {
    const p = read(PAGE);
    expect(p).toMatch(/<DashboardLayout title="Subscription">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-subscription-page-v134-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
