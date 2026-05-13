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

  it("REASON_LABEL 4-entry enum: signup → 'Initial signup' / upgrade → 'Upgraded' / downgrade → 'Downgraded' / tier_rename → 'Tier renamed (no price change)' — pinned so the lifecycle vocabulary maps to friendly text + the tier_rename label includes the '(no price change)' clarifier (drift to dropping the clarifier would confuse customers who saw a 'rename' as an unexplained event)", () => {
    expect(body).toMatch(
      /const REASON_LABEL: Record<MockPlanHistoryEntry\['reason'\], string> = \{\s*\n?\s*signup: 'Initial signup',\s*\n?\s*upgrade: 'Upgraded',\s*\n?\s*downgrade: 'Downgraded',\s*\n?\s*tier_rename: 'Tier renamed \(no price change\)',\s*\n?\s*\};/,
    );
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

  it('Plan history reverse-chronological order: PLAN_HISTORY.slice().reverse() (.slice() preserves immutability before reverse) — pinned so the timeline reads newest-first (drift to forward order would hide the most-recent change below older entries, defeating the at-a-glance purpose)', () => {
    expect(body).toMatch(/PLAN_HISTORY\.slice\(\)\s*\n?\s*\.reverse\(\)/);
  });

  it("Plan history from_tier conditional: from_tier !== null → <code>{from}</code> → <code>{to}</code> + from_tier === null → ': ' separator + <code>{to}</code> — pinned so the signup row (no from_tier) doesn't render with a phantom '→' (drift would either show 'null → trial_pack' or break the JSX entirely)", () => {
    expect(body).toMatch(
      /\{entry\.from_tier !== null && \(\s*\n?\s*<>\s*\n?\s*: <code class="font-mono">\{entry\.from_tier\}<\/code> →\{' '\}\s*\n?\s*<\/>\s*\n?\s*\)\}\s*\n?\s*\{entry\.from_tier === null && ': '\}\s*\n?\s*<code class="font-mono">\{entry\.to_tier\}<\/code>/,
    );
  });

  it("Invoice-status 3-tone: paid → emerald-50 / open → amber-50 / void → slate-100 (nested ternary, paid first since it's the common case) — pinned so the visual urgency of unpaid (open) invoices stays distinct from paid + voided states (drift to dropping void would render as no-style when Stripe marks invoices void)", () => {
    expect(body).toMatch(
      /invoice\.status === 'paid'\s*\n?\s*\? 'bg-emerald-50 text-emerald-700'\s*\n?\s*: invoice\.status === 'open'\s*\n?\s*\? 'bg-amber-50 text-amber-700'\s*\n?\s*: 'bg-slate-100 text-slate-600',/,
    );
  });

  it("Stripe-hosted invoice PDF framing pinned: 'Invoice PDFs hosted by Stripe with permanent URLs. Bookmark for accounting; we don't expire them.' — pinned so customers know they can bookmark invoice URLs without fearing expiry (drift to dropping the permanence guarantee would push customers to download PDFs locally — defensive copy + storage they don't need)", () => {
    expect(body).toMatch(
      /Invoice PDFs hosted by Stripe with permanent URLs\. Bookmark for\s*\n?\s*accounting; we don't expire them\./,
    );
  });

  it("fmtUsd helper: $${(cents / 100).toFixed(2)} template literal — pinned so cents → USD conversion stays consistent (drift to bare division would show '4.9' instead of '$4.90'; drift to dropping toFixed(2) would lose the cents precision)", () => {
    expect(body).toMatch(
      /function fmtUsd\(cents: number\): string \{\s*\n?\s*return `\$\$\{\(cents \/ 100\)\.toFixed\(2\)\}`;\s*\n?\s*\}/,
    );
  });

  it("MOCK_SUBSCRIPTION null branch: 'No subscription' fallback header — pinned so a customer who lands here pre-subscription doesn't see a broken '<undefined>' tier name (drift to dropping the null check would surface a JavaScript error on the SSG render)", () => {
    expect(body).toMatch(/\{MOCK_SUBSCRIPTION \? MOCK_SUBSCRIPTION\.tier : 'No subscription'\}/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
