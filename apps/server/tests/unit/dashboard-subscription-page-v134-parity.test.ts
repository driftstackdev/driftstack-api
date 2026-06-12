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

  it('CRITICAL 4-reason MockPlanHistoryEntry enum pinned — signup/upgrade/downgrade/tier_rename. Drift to dropping tier_rename would lose the "no price change" attribution.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/reason: 'signup' \| 'upgrade' \| 'downgrade' \| 'tier_rename'/);
  });

  it('CRITICAL REASON_LABEL map pinned with 4 keys mapped to customer-facing strings. signup → "Initial signup", tier_rename → "Tier renamed (no price change)" tells customers the change had no $ impact.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/signup: 'Initial signup',/);
    expect(p).toMatch(/upgrade: 'Upgraded',/);
    expect(p).toMatch(/downgrade: 'Downgraded',/);
    expect(p).toMatch(/tier_rename: 'Tier renamed \(no price change\)'/);
  });

  it('CRITICAL plan history rendered newest-first via slice().reverse(). The .slice() avoids mutating the source array; drift to in-place .reverse() would mutate the const MOCK array across renders.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/PLAN_HISTORY\.slice\(\)\s*\n\s+\.reverse\(\)/);
  });

  it('CRITICAL plan-history row formats `<from_tier> → <to_tier>` arrow when from_tier non-null. The arrow framing matches W755 audit-log subscription.tier_changed display.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/<code class="font-mono">\{entry\.from_tier\}<\/code> →/);
  });

  it('CRITICAL plan-history signup row (from_tier === null) renders `: <to_tier>` without arrow. Drift to a null-arrow would render "null → trial_pack" to customers.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/\{entry\.from_tier === null && ': '\}/);
  });

  it('CRITICAL 3-status invoice STATUS visual map pinned — paid/open/void. paid → bg-emerald (success), open → bg-tk-accent (action needed), void → bg-tk-surface (gray-cancelled). Drift to identical styling would lose the visual cue.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /invoice\.status === 'paid'\s*\n\s+\? 'bg-emerald-400\/10 text-emerald-300'\s*\n\s+: invoice\.status === 'open'\s*\n\s+\? 'bg-tk-accent\/10 text-tk-accent'\s*\n\s+: 'bg-tk-surface text-tk-ink-2',/,
    );
  });

  it('CRITICAL fmtUsd() helper formats cents to $X.XX with .toFixed(2). Drift to a different precision would diverge from the W751 /billing fmtCents() helper.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /function fmtUsd\(cents: number\): string \{\s*\n\s+return `\$\$\{\(cents \/ 100\)\.toFixed\(2\)\}`;\s*\n\}/,
    );
  });

  it("CRITICAL Stripe-permanent-URL framing pinned. The 'Invoice PDFs hosted by Stripe with permanent URLs. Bookmark for accounting; we don\\'t expire them.' wording is the customer-comms contract that protects against churn-driven invoice expiration.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Invoice PDFs hosted by Stripe with permanent URLs\. Bookmark for\s*\n\s+accounting; we don't expire them\./,
    );
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

  it('CRITICAL invoice-table 5-column header pinned — Date/Invoice/Amount/Status/(actions). The 5-column shape matches the MockInvoice row render.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/<th class="py-2 pr-4">Date<\/th>/);
    expect(p).toMatch(/<th class="py-2 pr-4">Invoice<\/th>/);
    expect(p).toMatch(/<th class="py-2 pr-4">Amount<\/th>/);
    expect(p).toMatch(/<th class="py-2 pr-4">Status<\/th>/);
    expect(p).toMatch(/<th class="py-2"><\/th>/);
  });

  it('CRITICAL invoice-row PDF download link pinned. Drift to an inline-view button would force customers to bookmark Driftstack URLs instead of Stripe URLs.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /<a href=\{invoice\.pdf_url\} class="text-sm text-tk-accent hover:underline">\s*\n\s+Download PDF\s*\n\s+<\/a>/,
    );
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
