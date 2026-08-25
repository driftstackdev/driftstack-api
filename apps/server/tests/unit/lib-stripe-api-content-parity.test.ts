// W392.A — drift guard for apps/server/src/lib/stripe-api.ts.
// V-088 minimal Stripe HTTP client. We deliberately do NOT depend on
// the `stripe` npm package (same reasoning as V-080's hand-rolled
// signature verifier). Drift here either breaks the Checkout / Portal
// flow or — worse — quietly switches off Stripe Tax for new
// subscriptions (ADR-002 BTW reverse-charge).
//
//   • V-088 framing pinned + 3-reason "no stripe SDK" rationale.
//   • application/x-www-form-urlencoded + BasicAuth + JSON response.
//   • DEFAULT_API_VERSION = '2024-12-18.acacia'.
//   • DEFAULT_TIMEOUT_MS = 10_000.
//   • DEFAULT_BASE_URL = 'https://api.stripe.com'.
//   • 4 touched operations framing (Customers / search / subscription Checkout /
//     Billing Portal).
//   • createSubscriptionCheckoutSession: mode='subscription' +
//     ADR-002 automatic_tax[enabled]='true' + Checkout address collection
//     + client_reference_id correlation.
//   • createBillingPortalSession.
//   • post(): URLSearchParams form body, BasicAuth = base64(`${sk}:`),
//     Stripe-Version header, AbortController timeout, JSON parse +
//     malformed_response branch + !res.ok → StripeApiError.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W392.A apps/server/src/lib/stripe-api.ts content parity', () => {
  const body = read(LIB);

  it('V-088 framing + "we deliberately do NOT depend on stripe npm package" rationale pinned', () => {
    expect(body).toMatch(/Minimal Stripe API HTTP client \(V-088\)\./);
    expect(body).toMatch(/We deliberately do NOT depend on the `stripe` npm package\. Reasons:/);
  });

  it('Reason 1: same reasoning as V-080 hand-rolled signature verifier (small touched surface)', () => {
    expect(body).toMatch(
      /Same reasoning as V-080's hand-rolled signature verification:\s*\/\/\s*we touch a small surface area of Stripe's API \(Customers,\s*\/\/\s*Checkout Sessions, Billing Portal Sessions\)\. The official SDK\s*\/\/\s*is hundreds of types \+ dozens of resource-method paths we'll\s*\/\/\s*never call/,
    );
  });

  it('Reason 2: supply-chain risk framing pinned (slim dependency graph)', () => {
    expect(body).toMatch(
      /Keeps the dependency graph slim\. Every additional npm package\s*\/\/\s*adds supply-chain risk \(the Stripe SDK is well-maintained, but\s*\/\/\s*its transitive dep tree is non-trivial\)/,
    );
  });

  it('Reason 3: test-friendly BillingProvider interface (in-memory test impl)', () => {
    expect(body).toMatch(
      /The integration shape stays test-friendly: BillingProvider is\s*\/\/\s*an interface with an in-memory test implementation; the real\s*\/\/\s*Stripe-backed implementation is one of many possible providers/,
    );
  });

  it('Stripe wire framing: form-urlencoded + BasicAuth + JSON response + 4xx/5xx error envelope', () => {
    expect(body).toMatch(
      /Stripe's API uses application\/x-www-form-urlencoded for request\s*\/\/\s*bodies, BasicAuth for the secret key, and returns JSON\. Errors come\s*\/\/\s*back as `\{ error: \{ type, message, code, \.\.\. \} \}` with a 4xx\/5xx/,
    );
  });

  it('4 live operations pinned in module-comment touched-surface list', () => {
    expect(body).toMatch(/POST \/v1\/customers/);
    expect(body).toMatch(/GET {2}\/v1\/customers \(search by email\)/);
    expect(body).toMatch(/POST \/v1\/checkout\/sessions {2}\(subscription mode\)/);
    expect(body).toMatch(/POST \/v1\/billing_portal\/sessions/);
    expect(body).not.toMatch(/payment mode for trial-pack/);
  });

  it('Default constants: API_VERSION="2024-12-18.acacia", TIMEOUT_MS=10_000, BASE_URL="https://api.stripe.com"', () => {
    expect(body).toMatch(/const DEFAULT_API_VERSION = '2024-12-18\.acacia';/);
    expect(body).toMatch(/const DEFAULT_TIMEOUT_MS = 10_000;/);
    expect(body).toMatch(/const DEFAULT_BASE_URL = 'https:\/\/api\.stripe\.com';/);
    expect(body).toMatch(/const MAX_STRIPE_RESPONSE_BODY_BYTES = 256 \* 1024;/);
  });

  it('StripeApiClientConfig: secretKey + optional apiVersion/timeoutMs/baseUrl/fetchImpl + logger', () => {
    expect(body).toMatch(/Stripe secret key \(sk_live_\.\.\. or sk_test_\.\.\.\)\./);
    expect(body).toMatch(/secretKey: string;/);
    expect(body).toMatch(/apiVersion\?: string;/);
    expect(body).toMatch(/timeoutMs\?: number;/);
    expect(body).toMatch(/baseUrl\?: string;/);
    expect(body).toMatch(/Test seam: substitute fetch implementation\./);
    expect(body).toMatch(/fetchImpl\?: typeof fetch;/);
    expect(body).toMatch(/logger: Logger;/);
  });

  it('StripeApiError: status + stripeError shape (type required, code/message/param/decline_code optional)', () => {
    expect(body).toMatch(/export interface StripeApiError extends Error \{/);
    expect(body).toMatch(/status: number;/);
    expect(body).toMatch(
      /stripeError: \{\s*type: string;\s*code\?: string;\s*message\?: string;\s*param\?: string;\s*decline_code\?: string;\s*\[key: string\]: unknown;\s*\};/,
    );
  });

  it('createCustomer: email required + optional name + metadata flattened to metadata[k] form fields + optional idempotencyKey forwarded to post()', () => {
    // Discrete pins (no long \s*\n? chain — the JSDoc on idempotencyKey would
    // break a single mega-regex; see feedback_no_long_chain_parity_regex).
    expect(body).toMatch(/async createCustomer\(args: \{/);
    expect(body).toMatch(/email: string;/);
    expect(body).toMatch(/name\?: string \| null;/);
    expect(body).toMatch(/metadata\?: Record<string, string>;/);
    expect(body).toMatch(/idempotencyKey\?: string;/);
    expect(body).toMatch(/\}\): Promise<\{ id: string; email: string \}>/);
    expect(body).toMatch(/body\[`metadata\[\$\{k\}\]`\] = v;/);
    // The optional Idempotency-Key is forwarded to post() (3rd arg) — the
    // safe-retry / no-duplicate-customer seam.
    expect(body).toMatch(
      /this\.post<\{ id: string; email: string \}>\(\s*'\/v1\/customers',\s*body,\s*args\.idempotencyKey,\s*\)/,
    );
  });

  it('createSubscriptionCheckoutSession: mode=subscription + ADR-002 automatic tax with Checkout-collected customer address + client_reference_id', () => {
    expect(body).toMatch(/mode: 'subscription',/);
    expect(body).toMatch(
      /BTW reverse-charge handling \(per ADR-002\): Stripe Tax must be\s*\/\/\s*enabled for the account\. Automatic tax also requires a customer\s*\/\/\s*tax location; newly-created Driftstack customers have no stored\s*\/\/\s*address, so Checkout must collect and save the billing address\.\s*\/\/\s*Omitting customer_update\[address\] makes Stripe reject the session\s*\/\/\s*before the hosted page can open/,
    );
    expect(body).toMatch(/'automatic_tax\[enabled\]': 'true',/);
    expect(body).toMatch(/'customer_update\[address\]': 'auto',/);
    expect(body).toMatch(/client_reference_id: args\.clientReferenceId,/);
    expect(body).toMatch(/'line_items\[0\]\[price\]': args\.priceId,/);
    expect(body).toMatch(/'line_items\[0\]\[quantity\]': '1',/);
    expect(body).toMatch(/body\[`subscription_data\[metadata\]\[\$\{k\}\]`\] = v;/);
  });

  it('createSubscriptionCheckoutSession: clientReferenceId correlation framing (surfaced in checkout.session.completed webhook)', () => {
    expect(body).toMatch(
      /Create a Checkout Session in `subscription` mode for a recurring price\.\s*\*\s*`clientReferenceId` is the local account UUID — surfaced back to us in\s*\*\s*the `checkout\.session\.completed` webhook event for correlation/,
    );
  });

  it('retired one-time trial-pack Checkout surface stays absent', () => {
    expect(body).not.toMatch(/createOneTimeCheckoutSession/);
    expect(body).not.toMatch(/mode: 'payment'/);
    expect(body).not.toMatch(/payment_intent_data\[metadata\]/);
  });

  it('createBillingPortalSession: customer + return_url → /v1/billing_portal/sessions', () => {
    expect(body).toMatch(
      /async createBillingPortalSession\(args: \{\s*customerId: string;\s*returnUrl: string;\s*\}\): Promise<\{ id: string; url: string \}>/,
    );
    expect(body).toMatch(
      /return this\.post<\{ id: string; url: string \}>\('\/v1\/billing_portal\/sessions', body\);/,
    );
  });

  it('post() helper: URLSearchParams body + BasicAuth base64(`${sk}:`) + Stripe-Version header + AbortController timeout', () => {
    expect(body).toMatch(/const formBody = new URLSearchParams\(body\)\.toString\(\);/);
    expect(body).toMatch(
      /const auth = `Basic \$\{Buffer\.from\(`\$\{this\.config\.secretKey\}:`\)\.toString\('base64'\)\}`;/,
    );
    expect(body).toMatch(/const ac = new AbortController\(\);/);
    expect(body).toMatch(/const timer = setTimeout\(\(\) => ac\.abort\(\), timeoutMs\);/);
    expect(body).toMatch(/'Stripe-Version': this\.config\.apiVersion \?\? DEFAULT_API_VERSION,/);
    expect(body).toMatch(/'Content-Type': 'application\/x-www-form-urlencoded',/);
    expect(body).toMatch(/body: formBody,\s*redirect: 'error',\s*signal: ac\.signal,/);
    // Optional Idempotency-Key header — only sent when the caller supplies a key.
    expect(body).toMatch(
      /\.\.\.\(idempotencyKey !== undefined \? \{ 'Idempotency-Key': idempotencyKey \} : \{\}\),/,
    );
  });

  it('post() error paths: malformed_response on JSON parse fail + StripeApiError on !res.ok', () => {
    expect(body).toMatch(/readBoundedResponseBody\(res, MAX_STRIPE_RESPONSE_BODY_BYTES\)/);
    expect(body).toMatch(/err instanceof ResponseBodyLimitError/);
    expect(body).toMatch(
      /stripeError: \{ type: 'malformed_response', message: 'Stripe response was not JSON' \},/,
    );
    expect(body).toMatch(/const stripeError = parseStripeError\(parsed\);/);
    expect(body).toMatch(/err\.name = 'StripeApiError';/);
    expect(body).toMatch(
      /this\.config\.logger\.warn\(\s*\{\s*component: 'stripe-api',\s*path,\s*status: res\.status,\s*stripeErrorType: stripeError\.type,\s*stripeErrorCode: stripeError\.code,\s*\},\s*'Stripe API error',\s*\);/,
    );
  });

  it('fetchImpl seam: config.fetchImpl ?? globalThis.fetch.bind(globalThis)', () => {
    expect(body).toMatch(
      /this\.fetchImpl = config\.fetchImpl \?\? globalThis\.fetch\.bind\(globalThis\);/,
    );
  });

  it('imports: Logger type only (no stripe SDK)', () => {
    expect(body).toMatch(/import type \{ Logger \} from '\.\/logger\.js';/);
    expect(body).not.toMatch(/from 'stripe'/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
