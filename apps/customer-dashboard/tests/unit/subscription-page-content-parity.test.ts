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
//   • Three CTAs: Upgrade plan / Downgrade plan / Open Stripe
//     portal (all #anchor placeholders pre-wire-up).

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

  it('PLAN_HISTORY reason taxonomy pinned: signup / upgrade / downgrade / tier_rename', () => {
    const reasonLabel = body.match(/const REASON_LABEL[\s\S]*?\};/);
    expect(reasonLabel).not.toBeNull();
    for (const r of ['signup', 'upgrade', 'downgrade', 'tier_rename']) {
      expect(reasonLabel![0], `reason key missing: ${r}`).toContain(`${r}:`);
    }
    // Type union pinned in source.
    expect(body).toMatch(/reason: 'signup' \| 'upgrade' \| 'downgrade' \| 'tier_rename'/);
  });

  it('MOCK_SUBSCRIPTION + inline mocks wired (data-driven mock, not inline-hardcoded UI)', () => {
    expect(body).toMatch(/import \{ MOCK_SUBSCRIPTION \} from '\.\.\/data\/mocks\.ts';/);
    expect(body).toMatch(/const PLAN_HISTORY: MockPlanHistoryEntry\[\] = \[/);
    expect(body).toMatch(/const INVOICES: MockInvoice\[\] = \[/);
  });

  it('plan history rendered reverse-chronologically (newest first via .reverse() on slice)', () => {
    expect(body).toMatch(/PLAN_HISTORY\.slice\(\)\s*\n?\s*\.reverse\(\)\s*\n?\s*\.map\(\(entry\)/);
  });

  it('"Upgrades immediate + prorate; downgrades at end of period" billing-claim framing pinned', () => {
    expect(body).toMatch(
      /Upgrades take effect immediately and prorate your remaining period\.\s+Downgrades take effect at the end of the current period — you keep\s+your current cap until renewal\./,
    );
  });

  it('"Invoice PDFs hosted by Stripe with permanent URLs" no-expire commitment pinned', () => {
    expect(body).toMatch(
      /Invoice PDFs hosted by Stripe with permanent URLs\. Bookmark for\s+accounting; we don't expire them\./,
    );
  });

  it('back-link to /billing for at-a-glance view pinned', () => {
    expect(body).toMatch(
      /<a href="\/billing" class="text-glow-red hover:underline">← Back to billing<\/a>/,
    );
    expect(existsSync(BILLING_PAGE)).toBe(true);
    // Body also cross-links to /billing in the descriptor.
    expect(body).toMatch(/<a href="\/billing" class="text-glow-red underline">\/billing<\/a>/);
  });

  it('3 plan-management CTAs pinned (Upgrade / Downgrade / Stripe portal)', () => {
    expect(body).toMatch(/<a href="#upgrade" class="btn-primary">Upgrade plan<\/a>/);
    expect(body).toMatch(/<a href="#downgrade" class="btn-secondary">Downgrade plan<\/a>/);
    expect(body).toMatch(/<a href="#portal" class="btn-secondary">Open Stripe portal<\/a>/);
  });

  it('invoice-status badge map pinned: paid (emerald) / open (glow-red after R3 migration) / void (surface-raised)', () => {
    expect(body).toMatch(
      /invoice\.status === 'paid'\s*\n?\s*\?\s*'bg-emerald-400\/10 text-emerald-300'/,
    );
    expect(body).toMatch(/invoice\.status === 'open'\s*\n?\s*\?\s*'bg-glow-red\/10 text-glow-red'/);
    expect(body).toMatch(/'bg-surface-raised text-ink-secondary'/);
  });

  it('invoice table columns: Date / Invoice / Amount / Status / (download)', () => {
    expect(body).toMatch(/<th class="py-2 pr-4">Date<\/th>/);
    expect(body).toMatch(/<th class="py-2 pr-4">Invoice<\/th>/);
    expect(body).toMatch(/<th class="py-2 pr-4">Amount<\/th>/);
    expect(body).toMatch(/<th class="py-2 pr-4">Status<\/th>/);
    // Download-PDF affordance per row.
    expect(body).toMatch(/Download PDF/);
  });

  it('"Initial signup" + "Upgraded" + "Downgraded" + "Tier renamed" reason labels pinned', () => {
    expect(body).toContain("signup: 'Initial signup'");
    expect(body).toContain("upgrade: 'Upgraded'");
    expect(body).toContain("downgrade: 'Downgraded'");
    expect(body).toContain("tier_rename: 'Tier renamed (no price change)'");
  });

  it('invoice amounts use cents-to-USD helper (fmtUsd) for display consistency', () => {
    expect(body).toMatch(
      /function fmtUsd\(cents: number\): string \{[\s\S]*?\(cents \/ 100\)\.toFixed\(2\)/,
    );
    expect(body).toMatch(/fmtUsd\(invoice\.amount_cents\)/);
  });
});
