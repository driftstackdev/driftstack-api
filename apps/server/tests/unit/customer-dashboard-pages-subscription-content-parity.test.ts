// W493.B — drift guard for apps/customer-dashboard/src/pages/subscription.astro.
// V-134 subscription detail page. Drift here either drops the
// upgrade-vs-downgrade timing framing (customers wouldn't know
// upgrades prorate but downgrades wait for renewal) or breaks
// the 4-option reason enum (a new lifecycle event without a
// REASON_LABEL entry would render as undefined).
//
//   • V-134 framing pinned + /billing-vs-/subscription split.
//   • REASON_LABEL 4-entry enum: signup / upgrade / downgrade /
//     tier_rename.
//   • Upgrade-vs-downgrade timing framing: 'Upgrades take effect
//     immediately and prorate; downgrades take effect at end of
//     period'.
//   • Plan history reverse-chronological (slice().reverse()).
//   • 3-button action row: Upgrade / Downgrade / Open Stripe
//     portal.
//   • Invoice-status 3-tone (paid emerald / open amber / void
//     slate).
//   • Stripe-hosted PDF framing 'permanent URLs. Bookmark for
//     accounting; we don't expire them.'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/subscription.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W493.B apps/customer-dashboard/src/pages/subscription.astro content parity', () => {
  const body = read(LIB);

  it("V-134 framing pinned: 'V-134 scaffolding. Real reads against /v1/billing land later. /subscription is a deeper drill-down from /billing — plan history, upgrade/downgrade preview, full invoice list. /billing stays the at-a-glance card; /subscription is for the detail.' — pinned so the page-purpose split (/billing = summary, /subscription = detail) stays explicit", () => {
    expect(body).toMatch(
      /\/\/ V-134 scaffolding\. Real reads against \/v1\/billing land later\.\s*\n?\s*\/\/ \/subscription is a deeper drill-down from \/billing — plan history,\s*\n?\s*\/\/ upgrade\/downgrade preview, full invoice list\. \/billing stays the\s*\n?\s*\/\/ at-a-glance card; \/subscription is for the detail\./,
    );
  });

  it('Honest empty states: plan history + invoices render neutral empty-state copy (the fabricated PLAN_HISTORY / INVOICES arrays were removed because the API exposes neither; the dashboard must not ship invented dollar amounts, statuses, or dead Download-PDF links)', () => {
    // Empty-state copy present.
    expect(body).toMatch(/Plan history isn't available yet\./);
    expect(body).toMatch(/No invoices yet\./);
    // The fabricated data + helpers are gone.
    expect(body).not.toMatch(/const PLAN_HISTORY/);
    expect(body).not.toMatch(/const INVOICES/);
    expect(body).not.toMatch(/REASON_LABEL/);
    expect(body).not.toMatch(/function fmtUsd/);
    expect(body).not.toMatch(/Download PDF/);
    expect(body).not.toMatch(/in_test_/);
    expect(body).not.toMatch(/amount_cents/);
  });

  it("Upgrade-vs-downgrade timing framing pinned: 'Upgrades take effect immediately and prorate your remaining period. Downgrades take effect at the end of the current period — you keep your current cap until renewal.' — pinned so the asymmetric timing (immediate-prorate vs end-of-period) survives (drift to symmetric framing would mislead customers who downgrade expecting instant effect)", () => {
    expect(body).toMatch(
      /Upgrades take effect immediately and prorate your remaining period\.\s*\n?\s*Downgrades take effect at the end of the current period — you keep\s*\n?\s*your current cap until renewal\./,
    );
  });

  it("3-button action row: Upgrade plan (#upgrade, btn-primary) / Downgrade plan (#downgrade, btn-secondary) / Open Stripe portal (#portal, btn-secondary) — pinned so the action vocabulary stays 3-button (drift to dropping Stripe portal would force customers to navigate through /billing for portal access, doubling the click count for the most-common 'manage subscription externally' workflow)", () => {
    expect(body).toMatch(/<a href="#upgrade" class="btn-primary">Upgrade plan<\/a>/);
    expect(body).toMatch(/<a href="#downgrade" class="btn-secondary">Downgrade plan<\/a>/);
    expect(body).toMatch(/<a href="#portal" class="btn-secondary">Open Stripe portal<\/a>/);
  });

  it("MOCK_SUBSCRIPTION null branch: 'No subscription' fallback header — pinned so a customer who lands here pre-subscription doesn't see a broken '<undefined>' tier name (drift to dropping the null check would surface a JavaScript error on the SSG render)", () => {
    expect(body).toMatch(/\{MOCK_SUBSCRIPTION \? MOCK_SUBSCRIPTION\.tier : 'No subscription'\}/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
