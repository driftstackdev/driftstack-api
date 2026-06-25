// W374.C — drift guard for customer-dashboard /subscription page
// content. V-134. Existing subscription-page-stub-baseline pins
// the surface as a known-mock placeholder. This guard pins the
// load-bearing content claims that anchor the deeper-drill-down
// from /billing:
//
//   • V-134 scaffolding framing pinned: /subscription is the
//     deeper drill-down from /billing; real /v1/billing reads
//     land later. A future "wire to live" change should remove
//     the MOCK_* imports and update this comment.
//   • PLAN_HISTORY uses reason taxonomy: signup / upgrade /
//     downgrade / tier_rename. A future schema add silently
//     renders as undefined REASON_LABEL.
//   • MOCK_SUBSCRIPTION + MOCK_INVOICES wiring (data-driven
//     mock; not inline-hardcoded UI).
//   • Plan history rendered reverse-chronologically (newest
//     first via .reverse() on slice).
//   • "Upgrades immediate + prorate; downgrades take effect at
//     end of period" framing pinned — load-bearing customer-
//     facing billing claim.
//   • "Invoice PDFs hosted by Stripe with permanent URLs" claim
//     pinned (no-expire commitment for accounting bookmark).
//   • Back-link to /billing for at-a-glance view.
//   • Three CTAs wired to real flows: Upgrade/Downgrade plan →
//     /select-tier checkout; Open Stripe portal → POST
//     /v1/billing/portal-session (was dead #anchor placeholders).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/subscription.astro');
const BILLING_PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/billing.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W374.C customer-dashboard /subscription page content parity', () => {
  const body = read(PAGE);

  it('V-134 scaffolding framing pinned (deeper drill-down from /billing; real reads land later)', () => {
    expect(body).toMatch(/V-134 scaffolding\. Real reads against \/v1\/billing land later/);
    expect(body).toMatch(
      /\/subscription is a deeper drill-down from \/billing — plan history,\s*\n?\s*\/\/\s*upgrade\/downgrade preview, full invoice list\. \/billing stays the\s*\n?\s*\/\/\s*at-a-glance card; \/subscription is for the detail\./,
    );
  });

  it('honest empty states: plan history + invoices render neutral copy (fabricated PLAN_HISTORY / INVOICES removed — the API exposes neither; no invented amounts/statuses/PDF links)', () => {
    expect(body).toMatch(/Plan history isn't available yet\./);
    expect(body).toMatch(/No invoices yet\./);
    expect(body).not.toMatch(/PLAN_HISTORY/);
    expect(body).not.toMatch(/const INVOICES/);
    expect(body).not.toMatch(/REASON_LABEL/);
    expect(body).not.toMatch(/function fmtUsd/);
    expect(body).not.toMatch(/Download PDF/);
    expect(body).not.toMatch(/in_test_/);
  });

  it('MOCK_SUBSCRIPTION + TIER_DISPLAY_NAMES imported for the live-hydrated Current-plan card (SSG paint, replaced by /v1/billing; tier id mapped to a plan name)', () => {
    expect(body).toMatch(
      /import \{ MOCK_SUBSCRIPTION, TIER_DISPLAY_NAMES \} from '\.\.\/data\/mocks\.ts';/,
    );
    // SSG + live hydration both render the friendly plan name, never the
    // raw tier id (e.g. "API Builder", not "api_builder").
    expect(body).toMatch(/TIER_DISPLAY_NAMES\[MOCK_SUBSCRIPTION\.tier\]/);
    expect(body).toMatch(/setText\('sub-tier', tierLabel\(body\.subscription\.tier\)\)/);
  });

  it('"Upgrades immediate + prorate; downgrades at end of period" billing-claim framing pinned', () => {
    expect(body).toMatch(
      /Upgrades take effect immediately and prorate your remaining period\.\s+Downgrades take effect at the end of the current period — you keep\s+your current cap until renewal\./,
    );
  });

  it('back-link to /billing for at-a-glance view pinned', () => {
    expect(body).toMatch(
      /<a href="\/billing" class="text-tk-accent hover:underline">← Back to billing<\/a>/,
    );
    expect(existsSync(BILLING_PAGE)).toBe(true);
    // Body also cross-links to /billing in the descriptor.
    expect(body).toMatch(/<a href="\/billing" class="text-tk-accent underline">\/billing<\/a>/);
  });

  it('3 plan-management CTAs wired to real flows (Upgrade/Downgrade → /select-tier; Stripe portal → POST /v1/billing/portal-session)', () => {
    // Previously these were dead `href="#..."` anchors with no handler.
    // Now Upgrade/Downgrade link to the working /select-tier checkout page
    // and "Open Stripe portal" is a button wired to the portal endpoint.
    expect(body).toMatch(/<a href="\/select-tier" class="btn-primary">Upgrade plan<\/a>/);
    expect(body).toMatch(/<a href="\/select-tier" class="btn-secondary">Downgrade plan<\/a>/);
    expect(body).toMatch(
      /<button type="button" class="btn-secondary" data-action="portal">Open Stripe portal<\/button>/,
    );
    // No dead hash anchors left behind.
    expect(body).not.toMatch(/href="#upgrade"/);
    expect(body).not.toMatch(/href="#downgrade"/);
    expect(body).not.toMatch(/href="#portal"/);
    // Portal handler POSTs the portal-session endpoint + redirects.
    expect(body).toMatch(/\/v1\/billing\/portal-session/);
    expect(body).toMatch(/if \(body\.portal_url\) window\.location\.href = body\.portal_url/);
  });
});
