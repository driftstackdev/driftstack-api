// W418.C — drift guard for apps/server/src/routes/billing.ts.
// V-082 billing endpoints + V-248/V-246-P1-001 return-URL allowlist.
// Drift here either drops the allowlist (open-redirect phishing
// vector via attacker-supplied success_url to Stripe Checkout) or
// breaks the hardcoded-allowlist anchor (env-driven allowlist =
// silent typo-bypass).
//
//   • V-082 framing pinned: 4 endpoints — POST checkout-session +
//     POST trial-pack + POST portal-session + GET / (state).
//   • Trial-pack framing: self-serve from onboarding (Workstream F)
//     before tier selection.
//   • V-248 / V-246-P1-001 allowlist framing pinned: open-redirect
//     attack surface rationale ("attacker.com phishing site"); 3-
//     origin hardcoded list (cloud dashboard + localhost dev +
//     app.driftstack.local e2e); enterprise allowlists out-of-scope
//     for launch.
//   • Hardcoded-allowlist rationale: anchors security guarantee; env
//     typo would silently re-introduce open-redirect.
//   • validateReturnUrl: defensive parse (malformed URL = reject) +
//     origin allowlist match.
//   • publicSubscription: 7-field shape (tier/status/
//     stripe_subscription_id/current_period_end nullable ISO/
//     cancel_at_period_end/canceled_at nullable ISO/created_at/
//     updated_at).
//   • Schemas: CreateCheckoutSession + StartTrialPack from
//     @driftstack/api-types (SDK mirror).
//   • Auth: requireAuth + rateLimit('global') on all 4.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/billing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W418.C apps/server/src/routes/billing.ts content parity', () => {
  const body = read(LIB);

  it('V-082 framing pinned: 4 routes (checkout-session + trial-pack + portal-session + state); trial-pack also self-serve from onboarding Workstream F', () => {
    expect(body).toMatch(/Billing routes \(V-082\)\./);
    expect(body).toMatch(/POST \/v1\/billing\/checkout-session\s+— start a paid-tier subscription/);
    expect(body).toMatch(/POST \/v1\/billing\/trial-pack\s+— start the \$2\.99 trial pack/);
    expect(body).toMatch(/POST \/v1\/billing\/portal-session\s+— open Stripe Customer Portal/);
    expect(body).toMatch(/GET\s+\/v1\/billing\s+— current subscription \+ trial state/);
    expect(body).toMatch(
      /All auth-gated\. Trial-pack endpoint is also self-serve from the\s*\n?\s*\/\/\s*onboarding flow \(Workstream F\) before tier selection\./,
    );
  });

  it('V-248 / V-246-P1-001 framing pinned: attacker.com phishing rationale + 3-origin hardcoded allowlist + enterprise out-of-scope', () => {
    expect(body).toMatch(/V-248 \/ V-246-P1-001 — Stripe checkout return URL allowlist\./);
    expect(body).toMatch(
      /Customer-supplied success_url \+ cancel_url are passed through to\s*\n?\s*\/\/\s*Stripe Checkout; without validation, a customer could craft a URL\s*\n?\s*\/\/\s*pointing at attacker\.com and share the checkout link with a colleague\s*\n?\s*\/\/\s*who'd land on the phishing site after entering their card\./,
    );
    expect(body).toMatch(
      /Allowlist: by default the Driftstack cloud dashboard origin and\s*\n?\s*\/\/\s*`app\.driftstack\.local` \(e2e\)\. Per-customer enterprise allowlists are\s*\n?\s*\/\/\s*out of scope for the launch posture; customers needing a custom URL\s*\n?\s*\/\/\s*get a clear "contact support" error\./,
    );
  });

  it('Hardcoded-allowlist rationale pinned: anchors security guarantee; env typo would silently re-introduce open-redirect', () => {
    expect(body).toMatch(
      /\/\/ The allowlist is hardcoded rather than env-driven because it\s*\n?\s*\/\/ anchors the security guarantee — a typo in env config would silently\s*\n?\s*\/\/ re-introduce the open-redirect\. Founder edits this list when a\s*\n?\s*\/\/ legitimate origin needs to be added \(paired with PR review\)\./,
    );
  });

  it('ALLOWED_RETURN_ORIGINS: readonly 3-origin tuple (https://app.driftstack.dev + http://localhost:5173 + http://app.driftstack.local)', () => {
    expect(body).toMatch(
      /const ALLOWED_RETURN_ORIGINS: readonly string\[\] = \[\s*\n?\s*'https:\/\/app\.driftstack\.dev',\s*\n?\s*'http:\/\/localhost:5173',\s*\/\/\s*dashboard dev server\s*\n?\s*'http:\/\/app\.driftstack\.local',\s*\/\/\s*e2e fixture\s*\n?\s*\];/,
    );
  });

  it('validateReturnUrl: defensive new URL parse (malformed → BadRequestError "not a valid URL"); origin allowlist match → "not on the allowlist" hint', () => {
    expect(body).toMatch(
      /function validateReturnUrl\(url: string, label: 'success_url' \| 'cancel_url'\): string \{\s*\n?\s*let parsed: URL;\s*\n?\s*try \{\s*\n?\s*parsed = new URL\(url\);\s*\n?\s*\} catch \{\s*\n?\s*throw new BadRequestError\(`\$\{label\} is not a valid URL\.`\);\s*\n?\s*\}\s*\n?\s*if \(!ALLOWED_RETURN_ORIGINS\.includes\(parsed\.origin\)\) \{\s*\n?\s*throw new BadRequestError\(\s*\n?\s*`\$\{label\} origin "\$\{parsed\.origin\}" is not on the allowlist\. Contact support if you need a custom origin allowlisted\.`,\s*\n?\s*\);/,
    );
  });

  it('publicSubscription: tier/status/stripe_subscription_id + current_period_end nullable ISO + cancel_at_period_end + canceled_at nullable ISO + created/updated ISO', () => {
    expect(body).toMatch(
      /function publicSubscription\(s: SubscriptionMirror\): Record<string, unknown> \{/,
    );
    expect(body).toMatch(/tier: s\.tier,/);
    expect(body).toMatch(/status: s\.status,/);
    expect(body).toMatch(/stripe_subscription_id: s\.stripeSubscriptionId,/);
    expect(body).toMatch(
      /current_period_end: s\.currentPeriodEnd \? s\.currentPeriodEnd\.toISOString\(\) : null,/,
    );
    expect(body).toMatch(/cancel_at_period_end: s\.cancelAtPeriodEnd,/);
    expect(body).toMatch(/canceled_at: s\.canceledAt \? s\.canceledAt\.toISOString\(\) : null,/);
    expect(body).toMatch(/created_at: s\.createdAt\.toISOString\(\),/);
    expect(body).toMatch(/updated_at: s\.updatedAt\.toISOString\(\),/);
  });

  it('Schemas: CreateCheckoutSessionRequestSchema + StartTrialPackRequestSchema from @driftstack/api-types (SDK mirror)', () => {
    expect(body).toMatch(
      /import \{\s*\n?\s*CreateCheckoutSessionRequestSchema,\s*\n?\s*StartTrialPackRequestSchema,\s*\n?\s*\} from '@driftstack\/api-types';/,
    );
  });

  it("Auth posture: requireAuth + rateLimit('global') on all 4 routes", () => {
    const matches = body.match(/preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\] \},/g);
    expect(matches?.length).toBe(4);
  });

  it('Checkout-session: V-248 allowlist gate on customer-supplied success/cancel URLs; service.createCheckoutSession with snake→camel; reply checkout_url + checkout_session_id', () => {
    expect(body).toMatch(/\/\/ V-248 — gate customer-supplied return URLs against the allowlist\./);
    expect(body).toMatch(
      /const successUrl =\s*\n?\s*parsed\.data\.success_url !== undefined\s*\n?\s*\? validateReturnUrl\(parsed\.data\.success_url, 'success_url'\)\s*\n?\s*: undefined;\s*\n?\s*const cancelUrl =\s*\n?\s*parsed\.data\.cancel_url !== undefined\s*\n?\s*\? validateReturnUrl\(parsed\.data\.cancel_url, 'cancel_url'\)\s*\n?\s*: undefined;/,
    );
    expect(body).toMatch(
      /const result = await service\.createCheckoutSession\(\{\s*\n?\s*accountId: ctx\.account\.id,\s*\n?\s*tier: parsed\.data\.tier,\s*\n?\s*billingPeriod: parsed\.data\.billing_period,\s*\n?\s*\.\.\.\(successUrl !== undefined \? \{ successUrl \} : \{\}\),\s*\n?\s*\.\.\.\(cancelUrl !== undefined \? \{ cancelUrl \} : \{\}\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /return \{\s*\n?\s*checkout_url: result\.url,\s*\n?\s*checkout_session_id: result\.sessionId,\s*\n?\s*\};/,
    );
  });

  it('Trial-pack: same V-248 allowlist gate ("same allowlist gate as checkout-session"); service.startTrialPack dispatch; same reply shape', () => {
    expect(body).toMatch(/\/\/ V-248 — same allowlist gate as checkout-session\./);
    expect(body).toMatch(
      /const result = await service\.startTrialPack\(\{\s*\n?\s*accountId: ctx\.account\.id,\s*\n?\s*\.\.\.\(successUrl !== undefined \? \{ successUrl \} : \{\}\),\s*\n?\s*\.\.\.\(cancelUrl !== undefined \? \{ cancelUrl \} : \{\}\),\s*\n?\s*\}\);/,
    );
  });

  it('Portal session: service.createPortalSession(accountId); reply { portal_url }', () => {
    expect(body).toMatch(
      /const result = await service\.createPortalSession\(ctx\.account\.id\);\s*\n?\s*return \{ portal_url: result\.url \};/,
    );
  });

  it('GET billing state: subscription null-handled via publicSubscription; trial_pack envelope (active/credit_cents_remaining/expires_at nullable ISO/redeemed)', () => {
    expect(body).toMatch(
      /const state = await service\.getBillingState\(ctx\.account\.id\);\s*\n?\s*return \{\s*\n?\s*subscription: state\.subscription !== null \? publicSubscription\(state\.subscription\) : null,\s*\n?\s*trial_pack: \{\s*\n?\s*active: state\.trialPack\.active,\s*\n?\s*credit_cents_remaining: state\.trialPack\.creditCentsRemaining,\s*\n?\s*expires_at: state\.trialPack\.expiresAt \? state\.trialPack\.expiresAt\.toISOString\(\) : null,\s*\n?\s*redeemed: state\.trialPack\.redeemed,\s*\n?\s*\},\s*\n?\s*\};/,
    );
  });

  it('imports: FastifyInstance/FastifyRequest + BillingService/SubscriptionMirror + BadRequestError/ValidationError', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(
      /import type \{ BillingService, SubscriptionMirror \} from '\.\.\/services\/billing\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, FeatureUnavailableError, ValidationError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('Wave 1119 / Slice 1119.2 B1 server-side leg: registerBillingDisabledRoutes wires the same 4 paths to 503 FeatureUnavailable stubs when Stripe env is unconfigured (so the customer dashboard 503-detection leg in select-tier.astro gets a machine-readable signal instead of 404)', () => {
    expect(body).toMatch(
      /\/\/ Wave 1119 \/ Slice 1119\.2 B1 server-side leg — when Stripe env is not\s*\n?\s*\/\/ configured \(no STRIPE_SECRET_KEY \/ DRIFTSTACK_TIER_PRICE_IDS \/\s*\n?\s*\/\/ STRIPE_TRIAL_PACK_PRICE_ID\), `registerBillingRoutes` doesn't run and\s*\n?\s*\/\/ the four `\/v1\/billing\/\*` paths fall through to the global 404 handler\./,
    );
    expect(body).toMatch(
      /export function registerBillingDisabledRoutes\(app: FastifyInstance\): void \{/,
    );
    expect(body).toMatch(
      /const detail =\s*\n?\s*'Billing is not configured on this server\. Reach out to support@driftstack\.dev if you expected to use this endpoint\.';/,
    );
    expect(body).toMatch(
      /const stub = \(\): never => \{\s*\n?\s*throw new FeatureUnavailableError\(detail\);\s*\n?\s*\};/,
    );
    expect(body).toMatch(/app\.post\('\/v1\/billing\/checkout-session', stub\);/);
    expect(body).toMatch(/app\.post\('\/v1\/billing\/trial-pack', stub\);/);
    expect(body).toMatch(/app\.post\('\/v1\/billing\/portal-session', stub\);/);
    expect(body).toMatch(/app\.get\('\/v1\/billing', stub\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
