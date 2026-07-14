// W751 — customer-dashboard /billing.astro V-183 (live-fetch) +
// V-331b (act-as RBAC passthrough) parity. Seventy-seventh in the
// cross-SDK drift-guard series.
//
// /billing is the second highest-stakes dashboard page after
// /api-keys: it threads Stripe-portal redirects + trial-pack
// checkout. Drift to URL framing or the act-as header would let
// team-RBAC requests leak to the wrong account.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const PAGE = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/billing.astro');

describe('W751 dashboard /billing page V-183 + V-331b parity', () => {
  it('billing.astro file exists', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('CRITICAL V-183 anchor framing pins an honest inert cold state and enables Stripe authority only after the live billing read.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/V-183 — progressive-enhancement wiring against \/v1\/billing\./);
    expect(p).toMatch(/SSG renders an inert unavailable shell; inline <script> fetches live/);
    expect(p).toMatch(/state \+ replaces card values\. The portal action button is enabled only/);
    expect(p).toMatch(/after that authoritative read, then POSTs to the/);
    expect(p).not.toMatch(/SSG renders mock for instant paint/);
    expect(p).toMatch(/data-field="sub-tier">\s*Billing state unavailable\s*<\/h2>/);
    expect(p).toMatch(
      /data-action="portal"\s*\n\s*disabled\s*\n\s*aria-disabled="true"\s*\n\s*title="Live billing must load before opening Stripe\."/,
    );
    expect(p).toMatch(/Mirrors\s*\n?\s*\/\/ V-180\/V-181\/V-182/);
  });

  it('CRITICAL Stripe-redirect-for-all-payment-changes framing pinned. The wording — "All payment changes redirect to Stripe\'s secure portal" — is the load-bearing PCI/compliance framing (dashboard never handles card data).', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /Manage subscription, payment method, and invoices\.\s*\n\s+All payment changes redirect to Stripe's secure portal\./,
    );
  });

  it('CRITICAL 9-state STATUS_BADGE_CLASS map pinned — active/trialing/past_due/canceled/unpaid/incomplete/incomplete_expired/paused/no_subscription. Drift to dropping a state would leave that subscription status badge-less.', () => {
    const p = read(PAGE);

    for (const state of [
      'active',
      'trialing',
      'past_due',
      'canceled',
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused',
      'no_subscription',
    ]) {
      expect(p, `STATUS_BADGE_CLASS.${state}`).toMatch(new RegExp(`${state}: '[^']+'`));
    }
  });

  it("CRITICAL V-331b act-as header passthrough pinned. The 'V-331b — act-as header for team-scoped requests' anchor + window.driftstackActAsHeaders() spread in authedFetch() is what threads team-RBAC into billing requests. Drift would let billing requests leak to the wrong team-scope.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/\/\/ V-331b — act-as header for team-scoped requests\./);
    expect(p).toMatch(
      /\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n\s+\? window\.driftstackActAsHeaders\(\)\s*\n\s+: \{\}\),/,
    );
  });

  it("CRITICAL authedFetch() helper pins the shared request deadline plus Authorization, content type, act-as scope, and credentials:'include'.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /const BILLING_REQUEST_TIMEOUT_MS = 15_000;\s*\n\s+function authedFetch\(path, init = \{\}\) \{\s*\n\s+return window\.driftstackFetchWithDeadline\(\s*\n\s+apiBaseUrl \+ path,/,
    );
    expect(p).toMatch(/authorization: 'Bearer ' \+ token,/);
    expect(p).toMatch(/'content-type': 'application\/json',/);
    expect(p).toMatch(/credentials: 'include',/);
    expect(p).toMatch(/BILLING_REQUEST_TIMEOUT_MS,\s*\n\s+\);/);
  });

  it("CRITICAL serialized POST /v1/billing/portal-session pinned with body:'{}', validated portal URL, and redirect. Drift would lose Stripe portal hand-off or allow duplicate portal creation.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /const response = await authedFetch\('\/v1\/billing\/portal-session', \{\s*\n\s+method: 'POST',\s*\n\s+body: '\{\}',\s*\n\s+\}\);/,
    );
    expect(p).toMatch(
      /const portalUrl = window\.driftstackTrustedRedirectUrl\(body && body\.portal_url, \[\s*\n\s+'https:\/\/billing\.stripe\.com',\s*\n\s+\]\);/,
    );
    expect(p).toMatch(/if \(!portalUrl\) throw new Error\('portal URL invalid'\);/);
    expect(p).toMatch(/window\.location\.href = portalUrl;/);
    expect(p).toMatch(/if \(portalLoading\) return;/);
  });

  it('CRITICAL Cancel button → handlePortal pinned. The "cancellation goes through Stripe portal" inline comment is the load-bearing PCI framing: we never cancel directly.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /if \(cancelBtn\) cancelBtn\.addEventListener\('click', handlePortal\); \/\/ cancellation goes through Stripe portal/,
    );
  });

  it('CRITICAL fmtIso() helper YYYY-MM-DD-only format pinned (NOT YYYY-MM-DD HH:mm UTC). Billing dates show calendar-day granularity (period renewal). Matches W748 dashboard-home fmtIso.', () => {
    const p = read(PAGE);

    // With the fabricated SSG subscription removed, formatting belongs only
    // to the authoritative live-data script.
    expect(p).not.toMatch(/function fmtIso\(iso: string \| null\)/);
    expect(p).toMatch(
      /function fmtIso\(iso\) \{\s*\n\s+if \(!iso\) return '—';\s*\n\s+return new Date\(iso\)\.toISOString\(\)\.slice\(0, 10\);\s*\n\s+\}/,
    );
  });

  it('CRITICAL no-token state remains explicitly unavailable and never presents preview billing as account truth.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /renderBillingUnavailable\(\s*'Billing state unavailable',\s*'Sign in to load your subscription and renewal details\.',\s*'unavailable',\s*\);/,
    );
    expect(p).toMatch(/showBanner\('Sign in to see live billing state\.'\);/);
    expect(p).not.toMatch(/Showing preview data below/);
  });

  it("W588: on a 503 (Stripe activation-gated) the subscription card is reset to an honest 'Billing not configured yet' state — NOT left showing the SSG mock tier/renew, which a real customer reads as their actual plan", () => {
    const p = read(PAGE);
    expect(p).toMatch(/if \(err && err\.status === 503\) \{/);
    expect(p).toMatch(
      /renderBillingUnavailable\(\s*'Billing not configured yet',\s*'Paid-plan billing activates once Stripe setup completes — nothing to pay or manage here yet\.',\s*'pending setup',\s*\);/,
    );
    // The shared unavailable renderer clears account state, disables portal
    // authority, and hides both portal actions.
    expect(p).toMatch(/function renderBillingUnavailable\(tier, summary, badge\)/);
    expect(p).toMatch(/setPortalAvailability\(false\);/);
    // The old misleading "Showing preview data below" wording is gone from 503.
    expect(p).not.toMatch(/finishing Stripe setup\. Showing preview data below/);
  });

  it('CRITICAL friendly portal-error banner framing pinned. Drift to silent error would leave customers stranded on a non-responding button.', () => {
    const p = read(PAGE);
    expect(p).toMatch(
      /showBanner\("Couldn't open Stripe right now — check your connection and try again\."\);/,
    );
    expect(p).toMatch(/finally \{\s*\n\s+setPortalLoading\(false\);/);
  });

  it("CRITICAL action-buttons wired regardless of token framing pinned. The 'Wire action buttons regardless of token state — they show a banner if no token rather than silently no-oping' inline comment is the load-bearing zero-confusion-state framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /\/\/ Wire action buttons regardless of token state — they show a\s*\n\s+\/\/ banner if no token rather than silently no-oping\./,
    );
  });

  it('CRITICAL subscription card cancel-button visibility — cancel_at_period_end hides the cancel button. Drift to always-show would let customers click cancel on already-canceling subs (no-op churn).', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /if \(cancelBtn\) \{\s*\n\s+if \(sub\.cancel_at_period_end\) cancelBtn\.classList\.add\('hidden'\);\s*\n\s+else cancelBtn\.classList\.remove\('hidden'\);/,
    );
  });

  it('CRITICAL subscription summary copy pinned — "Renews <date> · <set to cancel at period end | auto-renews>". The discriminated subscription-status framing tells customers exactly what happens at period end.', () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /'Renews ' \+\s*\n\s+fmtIso\(sub\.current_period_end\) \+\s*\n\s+' · ' \+\s*\n\s+\(sub\.cancel_at_period_end \? 'set to cancel at period end' : 'auto-renews'\);/,
    );
  });

  it("CRITICAL 'no active subscription' empty-state framing pinned. The wording — 'Upgrade to a paid tier to unlock concurrent caps + archetype access' — is the upsell framing on accounts with no Stripe subscription.", () => {
    const p = read(PAGE);

    expect(p).toMatch(/'No active subscription'/);
    expect(p).toMatch(/'Upgrade to a paid tier to unlock concurrent caps \+ archetype access\.',?/);
  });

  it("CRITICAL status-badge label pinned — replace(/_/g, ' '). 'past_due' → 'past due', 'no_subscription' → 'no subscription'. Drift to keeping underscores would look raw + uppercase-tracking-wide framing would look broken.", () => {
    const p = read(PAGE);

    // The cold SSG shell is deliberately status-neutral.
    expect(p).toMatch(/data-field="sub-status-badge"[\s\S]*?>\s*unavailable\s*<\/span>/);
    expect(p).not.toMatch(/\{status\.replace\(\/_\/g, ' '\)\}/);

    // Inline-script version.
    expect(p).toMatch(
      /setStatusBadge\(\(sub\.status \|\| ''\)\.replace\(\/_\/g, ' '\), sub\.status\);/,
    );
    expect(p).toMatch(/setStatusBadge\('no subscription', 'no_subscription'\);/);
  });

  it("CRITICAL tax + EU VAT framing pinned. The 'All prices in USD. VAT/BTW added per region per applicable EU rules. Stripe handles tax computation + invoicing per ADR-002.' framing threads ADR-002 (Stripe-handles-tax) — the load-bearing EU/Dutch tax framing.", () => {
    const p = read(PAGE);

    expect(p).toMatch(
      /All prices in USD\. VAT\/BTW added per region per applicable EU rules\.\s*\n\s+Stripe handles tax computation \+ invoicing per ADR-002\./,
    );
  });

  it('F-7 invoices-section placeholder framing — the prior "(Live invoice list endpoint TODO — accessible via Stripe Customer Portal in the meantime)" wording was a developer-comment leaking into customer copy. Reframed to describe the Stripe Customer Portal path as a feature rather than a workaround for a missing endpoint.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/Invoice history and permanent receipt URLs are available in the/);
    expect(p).toMatch(/Stripe Customer Portal\. Open it above after live billing loads\./);
    expect(p).not.toMatch(/Live invoice list endpoint TODO/);
    expect(p).not.toMatch(/the trial pack is/);
  });

  it('CRITICAL resolveApiBaseUrl + DashboardLayout used (no withSidebar={false}). Billing IS sidebar-enabled.', () => {
    const p = read(PAGE);

    expect(p).toMatch(/import \{ resolveApiBaseUrl \} from '\.\.\/lib\/api-base-url'/);
    expect(p).toMatch(/const apiBaseUrl = resolveApiBaseUrl\(\)/);
    expect(p).toMatch(/<DashboardLayout title="Billing">/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/dashboard-billing-page-v183-v331b-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
