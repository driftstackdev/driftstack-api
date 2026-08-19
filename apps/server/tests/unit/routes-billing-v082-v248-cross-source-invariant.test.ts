// W1044 — routes/billing V-082 + V-248 cross-source invariant. Pins
// apps/server/src/routes/billing.ts subscription / trial-pack / portal
// / billing-state surface:
//
//   V-082 anchor — 'Billing routes (V-082)'.
//
//   Endpoint roster — 4 routes:
//     POST /v1/billing/checkout-session
//     POST /v1/billing/trial-pack
//     POST /v1/billing/portal-session
//     GET  /v1/billing
//
//   V-248 + V-246-P1-001 open-redirect gate — 'Stripe checkout return
//   URL allowlist. Customer-supplied success_url + cancel_url are
//   passed through to Stripe Checkout; without validation, a customer
//   could craft a URL pointing at attacker.com and share the checkout
//   link with a colleague who'd land on the phishing site after
//   entering their card'.
//
//   ALLOWED_RETURN_ORIGINS — 3 entries (prod dashboard +
//   localhost:5173 dev + app.driftstack.local e2e).
//
//   Hardcoded-not-env rationale — 'The allowlist is hardcoded rather
//   than env-driven because it anchors the security guarantee — a
//   typo in env config would silently re-introduce the open-redirect'.
//
//   Allowlist failure error — 'origin "${parsed.origin}" is not on
//   the allowlist. Contact support if you need a custom origin
//   allowlisted'.
//
//   publicSubscription envelope — 8 fields (tier / status /
//   stripe_subscription_id / current_period_end / cancel_at_period_end
//   / canceled_at / created_at / updated_at).
//
//   /v1/billing response — { subscription, trial_pack: { active,
//   credit_cents_remaining, expires_at, redeemed } }.
//
// stays in lockstep across apps/server/src/routes/billing.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  if (!existsSync(p)) throw new Error(`missing ${p}`);
  return readFileSync(p, 'utf8');
}

describe('W1044 routes/billing V-082 + V-248 cross-source invariant', () => {
  // ─── V-082 anchor + roster ───────────────────────────────────

  it("CRITICAL V-082 anchor — 'Billing routes (V-082)'. The single-anchor design ties the route to the Stripe-rail billing family.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts'));
    expect(p).toMatch(/Billing routes \(V-082\)\./);
  });

  it('CRITICAL endpoint roster — 4 routes (checkout-session / portal-session / the account/me billing-portal alias / billing-state); trial-pack retired 2026-05-27. The exhaustive header comment is the canonical contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts'));
    expect(p).toMatch(/POST \/v1\/billing\/checkout-session\s+— start a paid-tier subscription/);
    expect(p).toMatch(/POST \/v1\/billing\/portal-session\s+— open Stripe Customer Portal/);
    expect(p).toMatch(/GET\s+\/v1\/billing\s+— current subscription state/);
  });

  it('CRITICAL every billing route is requireAuth + global rate-limit; the 3 mutations also require admin:billing (V-481).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts'));
    // The 3 billing mutations carry app.requireScope('admin:billing')
    // between requireAuth and rateLimit, so count each guard
    // independently rather than as an adjacent pair.
    expect((p.match(/app\.requireAuth/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((p.match(/app\.rateLimit\('global'\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect((p.match(/app\.requireScope\('admin:billing'\)/g) ?? []).length).toBe(3);
  });

  // ─── V-248 open-redirect gate ────────────────────────────────

  it("CRITICAL V-248 + V-246-P1-001 open-redirect framing — 'Stripe checkout return URL allowlist. Customer-supplied success_url + cancel_url are passed through to Stripe Checkout; without validation, a customer could craft a URL pointing at attacker.com and share the checkout link with a colleague who'd land on the phishing site after entering their card'. The allowlist-not-redirect-validation prevents the customer-facing phishing-via-Stripe-link vector.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts'));
    expect(p).toMatch(/V-248 \/ V-246-P1-001 — Stripe checkout return URL allowlist\./);
    expect(p).toMatch(/Customer-supplied success_url \+ cancel_url are passed through to/);
    expect(p).toMatch(/Stripe Checkout; without validation, a customer could craft a URL/);
    expect(p).toMatch(/pointing at attacker\.com and share the checkout link with a colleague/);
    expect(p).toMatch(/who'd land on the phishing site after entering their card\./);
  });

  it("CRITICAL ALLOWED_RETURN_ORIGINS — 3 entries (https://app.driftstack.dev / http://localhost:5173 / http://app.driftstack.local). The 3-entry list balances 'prod + dev + e2e' against attack surface.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts'));
    expect(p).toMatch(/'https:\/\/app\.driftstack\.dev',/);
    expect(p).toMatch(/'http:\/\/localhost:5173', \/\/ dashboard dev server/);
    expect(p).toMatch(/'http:\/\/app\.driftstack\.local', \/\/ e2e fixture/);
  });

  it("CRITICAL hardcoded-not-env rationale — 'The allowlist is hardcoded rather than env-driven because it anchors the security guarantee — a typo in env config would silently re-introduce the open-redirect'. The hardcoded design is the load-bearing choice.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts'));
    expect(p).toMatch(/The allowlist is hardcoded rather than env-driven because it/);
    expect(p).toMatch(/anchors the security guarantee — a typo in env config would silently/);
    expect(p).toMatch(/re-introduce the open-redirect\./);
  });

  it('CRITICAL allowlist-failure error — \'origin "<parsed.origin>" is not on the allowlist. Contact support if you need a custom origin allowlisted.\'. The explicit error routes legitimate enterprise customers to a support channel rather than silent reject.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts'));
    expect(p).toMatch(/`\$\{label\} origin "\$\{parsed\.origin\}" is not on the allowlist\./);
    expect(p).toMatch(/Contact support if you need a custom origin allowlisted\.`/);
  });

  it("CRITICAL invalid-URL → 'is not a valid URL.' error before the allowlist check. The defensive-parsing reject prevents a URL-parser-quirk bypass.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts'));
    expect(p).toMatch(/throw new BadRequestError\(`\$\{label\} is not a valid URL\.`\)/);
  });

  // ─── publicSubscription envelope ─────────────────────────────

  it('CRITICAL publicSubscription envelope — 8 fields (tier / status / stripe_subscription_id / current_period_end ISO|null / cancel_at_period_end / canceled_at ISO|null / created_at ISO / updated_at ISO). The flat shape is what the dashboard /billing page renders.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts'));
    expect(p).toMatch(/tier: s\.tier,/);
    expect(p).toMatch(/status: s\.status,/);
    expect(p).toMatch(/stripe_subscription_id: s\.stripeSubscriptionId,/);
    expect(p).toMatch(
      /current_period_end: s\.currentPeriodEnd \? s\.currentPeriodEnd\.toISOString\(\) : null,/,
    );
    expect(p).toMatch(/cancel_at_period_end: s\.cancelAtPeriodEnd,/);
    expect(p).toMatch(/canceled_at: s\.canceledAt \? s\.canceledAt\.toISOString\(\) : null,/);
    expect(p).toMatch(/created_at: s\.createdAt\.toISOString\(\),/);
    expect(p).toMatch(/updated_at: s\.updatedAt\.toISOString\(\),/);
  });

  // ─── /v1/billing response envelope ───────────────────────────

  it('CRITICAL /v1/billing response shape — { subscription } only (trial_pack envelope removed 2026-05-27).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts'));
    expect(p).toMatch(
      /subscription: state\.subscription !== null \? publicSubscription\(state\.subscription\) : null,/,
    );
    expect(p).not.toMatch(/state\.trialPack/);
  });

  // ─── checkout-session / trial-pack response ──────────────────

  it('CRITICAL checkout response shape — { checkout_url, checkout_session_id }. The checkout-session 2-field shape drives the dashboard redirect helper.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts'));
    expect(p).toMatch(/checkout_url: result\.url,/);
    expect(p).toMatch(/checkout_session_id: result\.sessionId,/);
  });

  it("CRITICAL portal-session response — { portal_url }. The single-field response matches the dashboard's redirect-to-Stripe-portal flow.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts'));
    expect(p).toMatch(/return \{ portal_url: result\.url \};/);
  });
});
