// W494.C — drift guard for apps/customer-dashboard/src/pages/billing.astro.
// V-183 billing-overview page with progressive-enhancement
// against /v1/billing + Stripe-portal handoff. Drift here either
// drops the 9-state STATUS_BADGE_CLASS (a new Stripe status
// would render with no styling) or breaks the cancel→portal
// indirection (cancellation goes through Stripe portal, not a
// direct cancel endpoint, so the page can't be a self-serve
// cancel UI that bypasses Stripe's flow).
//
//   • V-183 progressive-enhancement framing pinned.
//   • STATUS_BADGE_CLASS 9-state: active / trialing / past_due /
//     canceled / unpaid / incomplete / incomplete_expired /
//     paused / no_subscription.
//   • V-331b act-as header in authedFetch.
//   • Cancel button → handlePortal (cancellation goes through
//     Stripe portal).
//   • POST /v1/billing/portal-session + POST /v1/billing/trial-
//     pack contracts.
//   • Trial-pack 3-state (active / redeemed / available).
//   • Tax framing: 'VAT/BTW added per region per applicable EU
//     rules. Stripe handles tax computation + invoicing per ADR-
//     002.'

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/billing.astro');
const LAYOUT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W494.C apps/customer-dashboard/src/pages/billing.astro content parity', () => {
  const body = read(LIB);
  const layout = read(LAYOUT);

  it('V-183 framing pins an inert SSG shell that enables Stripe actions only after authoritative live billing loads', () => {
    expect(body).toMatch(
      /\/\/ V-183 — progressive-enhancement wiring against \/v1\/billing\.\s*\/\/ SSG renders an inert unavailable shell; inline <script> fetches live\s*\/\/ state \+ replaces card values\. The portal action button is enabled only\s*\/\/ after that authoritative read, then POSTs to the/,
    );
  });

  it('STATUS_BADGE_CLASS 9-state catalog: active / trialing / past_due / canceled / unpaid / incomplete / incomplete_expired / paused / no_subscription on the two-axis status tokens (Fleet v2 2026-07-02: tk-ready positive, tk-err recovery, tk-accent transient, tk-hover muted — flips with data-mode, unlike the old emerald/red literals) — pinned so the Stripe lifecycle vocabulary stays complete (drift to dropping incomplete_expired would render Stripe-state-incomplete-then-expired with no styling)', () => {
    // S23 2026-07-06 — accent-toned TEXT re-pinned raw tk-accent → AA-safe tk-accent-text (cross-app WCAG sweep).
    // S25 2026-07-06 — status-toned TEXT re-pinned raw tk-ready/tk-err → AA-safe tk-ready-text/tk-err-text (washes stay raw).
    expect(body).toMatch(
      /const STATUS_BADGE_CLASS: Record<string, string> = \{\s*\n?\s*active: 'bg-tk-ready\/10 text-tk-ready-text',\s*\n?\s*trialing: 'bg-tk-accent\/10 text-tk-accent-text',\s*\n?\s*past_due: 'bg-tk-err\/10 text-tk-err-text',\s*\n?\s*canceled: 'bg-tk-hover text-tk-ink-2',\s*\n?\s*unpaid: 'bg-tk-err\/10 text-tk-err-text',\s*\n?\s*incomplete: 'bg-tk-accent\/10 text-tk-accent-text',\s*\n?\s*incomplete_expired: 'bg-tk-hover text-tk-ink-2',\s*\n?\s*paused: 'bg-tk-hover text-tk-ink-2',\s*\n?\s*no_subscription: 'bg-tk-hover text-tk-ink-2',\s*\n?\s*\};/,
    );
  });

  it('billing authedFetch preserves act-as headers and delegates its exact 15s deadline to the shared layout transport', () => {
    expect(body).toMatch(
      /\/\/ V-331b — act-as header for team-scoped requests\.\s*\n?\s*\.\.\.\(typeof window\.driftstackActAsHeaders === 'function'\s*\n?\s*\? window\.driftstackActAsHeaders\(\)\s*\n?\s*: \{\}\),/,
    );
    expect(body).toContain('const BILLING_REQUEST_TIMEOUT_MS = 15_000;');
    expect(body).toMatch(
      /window\.driftstackFetchWithDeadline\(\s*\n?\s*apiBaseUrl \+ path,[\s\S]*?credentials: 'include',[\s\S]*?BILLING_REQUEST_TIMEOUT_MS,\s*\n?\s*\);/,
    );
    expect(layout).toContain('var callerSignal = init && init.signal;');
    expect(layout).toContain(
      "callerSignal.addEventListener('abort', forwardAbort, { once: true })",
    );
    expect(layout).toContain("callerSignal.removeEventListener('abort', forwardAbort)");
  });

  it('receipt downloads are single-flight, honest while busy, and finally-clean temporary resources', () => {
    expect(body).toContain('const receiptDownloadsInFlight = new WeakSet();');
    expect(body).toContain('if (receiptDownloadsInFlight.has(btn)) return;');
    expect(body).toContain("btn.textContent = 'Downloading…';");
    expect(body).toContain(
      'if (anchor && anchor.parentNode) anchor.parentNode.removeChild(anchor);',
    );
    expect(body).toContain('if (objectUrl !== null) URL.revokeObjectURL(objectUrl);');
    expect(body).toContain('receiptDownloadsInFlight.delete(btn);');
  });

  it("Cancel button → handlePortal indirection: 'cancellation goes through Stripe portal' inline comment + cancelBtn.addEventListener('click', handlePortal) — pinned so customers can't accidentally land on a self-serve cancel API path that bypasses Stripe's retention/save offers (Stripe portal is the canonical cancel surface, with their own UX for offering pauses/discounts)", () => {
    expect(body).toMatch(
      /if \(cancelBtn\) cancelBtn\.addEventListener\('click', handlePortal\); \/\/ cancellation goes through Stripe portal/,
    );
  });

  it('POST /v1/billing/portal-session contract: serialized action, empty {} body, validated portal URL, and redirect — pinned so the portal handoff stays minimal and duplicate clicks cannot create concurrent sessions', () => {
    expect(body).toMatch(
      /const response = await authedFetch\('\/v1\/billing\/portal-session', \{\s*\n?\s*method: 'POST',\s*\n?\s*body: '\{\}',\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /if \(!body \|\| !body\.portal_url\) throw new Error\('portal URL missing'\);/,
    );
    expect(body).toMatch(/window\.location\.href = body\.portal_url;/);
    expect(body).toMatch(/if \(portalLoading\) return;/);
  });

  it('Cancel-at-period-end visibility: the static shell is hidden+disabled, then an authoritative subscription shows cancel iff it is not already set to cancel', () => {
    expect(body).toMatch(
      /data-action="cancel"\s*disabled\s*aria-disabled="true"[\s\S]*?class:list=\{\[\s*'btn-secondary text-red-700',\s*'hidden',/,
    );
    expect(body).toMatch(
      /if \(cancelBtn\) \{\s*\n?\s*if \(sub\.cancel_at_period_end\) cancelBtn\.classList\.add\('hidden'\);\s*\n?\s*else cancelBtn\.classList\.remove\('hidden'\);\s*\n?\s*\}/,
    );
  });

  it("Subscription auto-renew vs cancel-at-end framing: 'Renews {date} · set to cancel at period end' vs 'Renews {date} · auto-renews' — pinned so the customer sees AT-A-GLANCE whether the subscription will renew (active by default) or end (cancellation already triggered) — drift to merging both into 'Renews {date}' would hide the cancel-at-end signal", () => {
    expect(body).toMatch(
      /sub\.cancel_at_period_end \? 'set to cancel at period end' : 'auto-renews'/,
    );
  });

  it("Tax + receipts framing pinned: 'All prices in USD. VAT/BTW added per region per applicable EU rules. Stripe handles tax computation + invoicing per ADR-002.' — pinned so the EU-VAT framing + the ADR-002 Stripe-tax delegation reference survive (drift to handling tax ourselves would violate ADR-002 + create compliance liability)", () => {
    expect(body).toMatch(
      /All prices in USD\. VAT\/BTW added per region per applicable EU rules\.\s*\n?\s*Stripe handles tax computation \+ invoicing per ADR-002\./,
    );
  });

  it('The static and signed-out billing shell is neutral, non-actionable, and never fabricates account/subscription/invoice state', () => {
    expect(body).not.toMatch(/MOCK_ACCOUNT|MOCK_SUBSCRIPTION/);
    expect(body).toMatch(/data-field="account-email">Account · —<\/p>/);
    expect(body).toMatch(/Billing state unavailable/);
    expect(body).toMatch(/data-action="portal"\s*disabled\s*aria-disabled="true"/);
    expect(body).toMatch(
      /Invoice history and permanent receipt URLs are available in the\s*Stripe Customer Portal\./,
    );
    expect(body).toMatch(
      /if \(!token\) \{\s*renderBillingUnavailable\(\s*'Billing state unavailable',\s*'Sign in to load your subscription and renewal details\.',\s*'unavailable',\s*\);[\s\S]*?showBanner\('Sign in to see live billing state\.'\);\s*return;/,
    );
    expect(body).not.toMatch(/Showing preview data below/);
  });

  it('Portal controls remain disabled through unavailable/loading states and are enabled only inside the live subscription branch', () => {
    expect(body).toMatch(/let billingDataAvailable = false;/);
    expect(body).toMatch(
      /function setPortalAvailability\(available\) \{[\s\S]*?btn\.disabled = !available \|\| portalLoading;[\s\S]*?Live billing must load before opening Stripe\./,
    );
    expect(body).toMatch(
      /async function handlePortal\(\) \{[\s\S]*?if \(!billingDataAvailable\) \{\s*showBanner\('Reload live billing before opening Stripe\.'\);\s*return;/,
    );
    expect(body).toMatch(
      /if \(body\.subscription\) \{\s*const sub = body\.subscription;\s*setPortalAvailability\(true\);/,
    );
    expect(body).toMatch(
      /function renderBillingUnavailable\(tier, summary, badge\) \{[\s\S]*?setPortalAvailability\(false\);[\s\S]*?portalBtn\.classList\.add\('hidden'\)/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
