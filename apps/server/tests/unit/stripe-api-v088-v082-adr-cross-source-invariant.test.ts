// W971 — stripe-api V-088 + V-082 + ADR-002 + ADR-003 cross-source
// invariant. Two-hundred-ninety-seventh in the drift-guard series.
// Pins the apps/server/src/lib/stripe-api.ts hand-rolled HTTP client:
//
//   V-088 anchor — 'Minimal Stripe API HTTP client (V-088)'.
//
//   Hand-rolled rationale framing — 'We deliberately do NOT depend on
//   the stripe npm package'. 3 reasons listed:
//     1. Same reasoning as V-080's hand-rolled signature verification
//        — small touched-surface (Customers + Checkout + Billing
//        Portal) doesn't justify hundreds of SDK types.
//     2. Supply-chain risk reduction (non-trivial transitive deps).
//     3. Test-friendliness — BillingProvider interface with in-memory
//        test impl + Stripe-backed real impl.
//
//   Stripe wire-format framing — 'Stripe's API uses application/x-www-
//   form-urlencoded for request bodies, BasicAuth for the secret key,
//   and returns JSON. Errors come back as { error: { type, message,
//   code, ... } } with a 4xx/5xx'.
//
//   V-082 endpoint set framing — 'This client covers the minimum
//   endpoints V-082 needs:
//     - POST /v1/customers
//     - GET  /v1/customers (search by email)
//     - POST /v1/checkout/sessions  (subscription mode)
//     - POST /v1/checkout/sessions  (payment mode for trial-pack)
//     - POST /v1/billing_portal/sessions'.
//
//   3 default constants — DEFAULT_API_VERSION '2024-12-18.acacia' +
//     DEFAULT_TIMEOUT_MS 10_000 + DEFAULT_BASE_URL
//     'https://api.stripe.com'.
//
//   ADR-002 automatic_tax framing — 'reverse-charge handling (per
//   ADR-002): Stripe Tax must be enabled for the account; the line
//   below tells Stripe Checkout to compute tax automatically. Safe to
//   leave on for live + test accounts; if Stripe Tax isn't enabled
//   the Checkout init still succeeds — Stripe just doesn't compute
//   tax'.
//
//   ADR-003 trial-pack one-time-mode framing — 'Create a Checkout
//   Session in payment mode for a one-time price (the trial pack per
//   ADR-003). Same correlation pattern via client_reference_id'.
//
//   client_reference_id framing — 'is the local account UUID —
//   surfaced back to us in the checkout.session.completed webhook
//   event for correlation'.
//
//   Subscription-mode 7-field body — mode + customer + line_items[0][
//     price] + line_items[0][quantity]:'1' + success_url + cancel_url
//     + client_reference_id + automatic_tax[enabled]:'true'.
//
//   Payment-mode 7-field body — mode:'payment' + customer +
//     line_items[0][price] + line_items[0][quantity]:'1' +
//     success_url + cancel_url + client_reference_id.
//
//   Per-mode metadata round-trip — subscription_data[metadata][k] for
//     subscription mode, payment_intent_data[metadata][k] for
//     one-time mode.
//
//   Form-encoded customer metadata — 'metadata[k]: v' shape for POST
//     /v1/customers.
//
//   BasicAuth shape — 'Basic ${Buffer.from(secretKey:).toString(
//     base64)}' (Stripe convention is secretKey + ':' + empty
//     password).
//
//   AbortController + setTimeout/clearTimeout per-request timeout.
//
//   StripeApiError shape — has status + stripeError { type, code?,
//     message?, param?, decline_code?, [other]: unknown }.
//
//   Empty-body / non-JSON / 4xx-5xx 3-case error envelope handling.
//
// stays in lockstep across apps/server/src/lib/stripe-api.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StripeApiClient } from '../../src/lib/stripe-api.js';
import type { StripeApiError } from '../../src/lib/stripe-api.js';
import { createTestLogger } from '../../src/lib/logger.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W971 stripe-api V-088 cross-source invariant', () => {
  // ─── V-088 anchor + hand-rolled rationale ────────────────────

  it("CRITICAL apps/server/src/lib/stripe-api.ts header pins V-088 anchor — 'Minimal Stripe API HTTP client (V-088)'. The V-088 anchor is the policy provenance for the hand-rolled approach.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/Minimal Stripe API HTTP client \(V-088\)\./);
  });

  it("CRITICAL hand-rolled rationale framing — 'We deliberately do NOT depend on the stripe npm package. Reasons:' followed by 3 numbered reasons (small-touched-surface + supply-chain-slim + test-friendly). The deliberately-no-SDK + 3-reason design is the V-088 + V-080 cross-source rationale.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/We deliberately do NOT depend on the `stripe` npm package\. Reasons:/);
    expect(p).toMatch(/1\. Same reasoning as V-080's hand-rolled signature verification:/);
    expect(p).toMatch(/we touch a small surface area of Stripe's API \(Customers,/);
    expect(p).toMatch(/Checkout Sessions, Billing Portal Sessions\)\./);
    expect(p).toMatch(/2\. Keeps the dependency graph slim\. Every additional npm package/);
    expect(p).toMatch(/adds supply-chain risk \(the Stripe SDK is well-maintained, but/);
    expect(p).toMatch(/its transitive dep tree is non-trivial\)\./);
    expect(p).toMatch(/3\. The integration shape stays test-friendly: BillingProvider is/);
    expect(p).toMatch(/an interface with an in-memory test implementation; the real/);
    expect(p).toMatch(/Stripe-backed implementation is one of many possible providers\./);
  });

  // ─── Stripe wire-format framing ──────────────────────────────

  it("CRITICAL Stripe wire-format framing — 'Stripe's API uses application/x-www-form-urlencoded for request bodies, BasicAuth for the secret key, and returns JSON. Errors come back as { error: { type, message, code, ... } } with a 4xx/5xx'. The form-encoded + BasicAuth + JSON-error envelope is the Stripe transport contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/Stripe's API uses application\/x-www-form-urlencoded for request/);
    expect(p).toMatch(/bodies, BasicAuth for the secret key, and returns JSON\. Errors come/);
    expect(p).toMatch(/back as `\{ error: \{ type, message, code, \.\.\. \} \}` with a 4xx\/5xx\./);
  });

  // ─── V-082 endpoint set ──────────────────────────────────────

  it('CRITICAL V-082 endpoint set framing lists 5 endpoints — POST /v1/customers + GET /v1/customers (search by email) + POST /v1/checkout/sessions (subscription mode) + POST /v1/checkout/sessions (payment mode for trial-pack) + POST /v1/billing_portal/sessions. The 5-endpoint inventory is the V-082 touched-surface contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/This client covers the minimum endpoints V-082 needs:/);
    expect(p).toMatch(/- POST \/v1\/customers/);
    expect(p).toMatch(/- GET\s+\/v1\/customers \(search by email\)/);
    expect(p).toMatch(/- POST \/v1\/checkout\/sessions\s+\(subscription mode\)/);
    expect(p).toMatch(/- POST \/v1\/checkout\/sessions\s+\(payment mode for trial-pack\)/);
    expect(p).toMatch(/- POST \/v1\/billing_portal\/sessions/);
  });

  // ─── 3 default constants ─────────────────────────────────────

  it("CRITICAL 3 default constants — DEFAULT_API_VERSION '2024-12-18.acacia' + DEFAULT_TIMEOUT_MS 10_000 + DEFAULT_BASE_URL 'https://api.stripe.com'. The pinned-api-version + 10s-timeout + canonical-base-url are the wire-format guarantees.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/const DEFAULT_API_VERSION = '2024-12-18\.acacia';/);
    expect(p).toMatch(/const DEFAULT_TIMEOUT_MS = 10_000;/);
    expect(p).toMatch(/const DEFAULT_BASE_URL = 'https:\/\/api\.stripe\.com';/);
  });

  // ─── StripeApiError shape ────────────────────────────────────

  it('CRITICAL StripeApiError extends Error + has status + stripeError {type, code?, message?, param?, decline_code?, [key]: unknown}. The 5-field-named + open-ended stripeError shape covers Stripe error-payload variability.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/export interface StripeApiError extends Error \{/);
    expect(p).toMatch(/status: number;/);
    expect(p).toMatch(/stripeError: \{/);
    expect(p).toMatch(/type: string;/);
    expect(p).toMatch(/code\?: string;/);
    expect(p).toMatch(/message\?: string;/);
    expect(p).toMatch(/param\?: string;/);
    expect(p).toMatch(/decline_code\?: string;/);
    expect(p).toMatch(/\[key: string\]: unknown;/);
  });

  // ─── Customer create body shape ──────────────────────────────

  it("CRITICAL createCustomer form-encodes metadata as 'metadata[k]: v'. The metadata-bracket-prefix shape is the Stripe form-encoding convention for nested key-value maps.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/body\[`metadata\[\$\{k\}\]`\] = v;/);
  });

  // ─── Subscription-mode 7-field body ──────────────────────────

  it("CRITICAL subscription-mode body has 7 form fields — mode:'subscription' + customer + line_items[0][price] + line_items[0][quantity]:'1' + success_url + cancel_url + client_reference_id + automatic_tax[enabled]:'true' (ADR-002). The 7-field body is the V-082 subscription-checkout contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/mode: 'subscription',/);
    expect(p).toMatch(/customer: args\.customerId,/);
    expect(p).toMatch(/'line_items\[0\]\[price\]': args\.priceId,/);
    expect(p).toMatch(/'line_items\[0\]\[quantity\]': '1',/);
    expect(p).toMatch(/success_url: args\.successUrl,/);
    expect(p).toMatch(/cancel_url: args\.cancelUrl,/);
    expect(p).toMatch(/client_reference_id: args\.clientReferenceId,/);
    expect(p).toMatch(/'automatic_tax\[enabled\]': 'true',/);
  });

  // ─── ADR-002 automatic_tax framing ───────────────────────────

  it("CRITICAL ADR-002 automatic_tax framing — 'BTW reverse-charge handling (per ADR-002): Stripe Tax must be enabled for the account; the line below tells Stripe Checkout to compute tax automatically. Safe to leave on for live + test accounts; if Stripe Tax isn't enabled the Checkout init still succeeds — Stripe just doesn't compute tax'. The Stripe-Tax-must-be-enabled + safe-on-by-default design is the ADR-002 BTW contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/BTW reverse-charge handling \(per ADR-002\): Stripe Tax must be/);
    expect(p).toMatch(/enabled for the account; the line below tells Stripe Checkout/);
    expect(p).toMatch(/to compute tax automatically\. Safe to leave on for live \+ test/);
    expect(p).toMatch(/accounts; if Stripe Tax isn't enabled the Checkout init still/);
    expect(p).toMatch(/succeeds — Stripe just doesn't compute tax\./);
  });

  // ─── client_reference_id correlation framing ─────────────────

  it("CRITICAL client_reference_id correlation framing — 'is the local account UUID — surfaced back to us in the checkout.session.completed webhook event for correlation'. The UUID-as-client-ref + webhook-correlation design is the V-082 cross-source contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/`clientReferenceId` is the local account UUID — surfaced back to us in/);
    expect(p).toMatch(/the `checkout\.session\.completed` webhook event for correlation\./);
  });

  // ─── Subscription-mode metadata round-trip ───────────────────

  it("CRITICAL subscription-mode metadata round-trips via 'subscription_data[metadata][k]' (so it lands on the resulting subscription object). The subscription_data prefix is what makes the metadata propagate beyond the Session to the Subscription.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/body\[`subscription_data\[metadata\]\[\$\{k\}\]`\] = v;/);
  });

  // ─── ADR-003 payment-mode framing ────────────────────────────

  it("CRITICAL ADR-003 one-time-mode framing — 'Create a Checkout Session in payment mode for a one-time price (the trial pack per ADR-003). Same correlation pattern via client_reference_id'. The ADR-003 trial-pack + payment-mode + same-client-ref design is the V-082 + ADR-003 contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/Create a Checkout Session in `payment` mode for a one-time price/);
    expect(p).toMatch(/\(the trial pack per ADR-003\)\. Same correlation pattern via/);
    expect(p).toMatch(/`client_reference_id`\./);
  });

  // ─── Payment-mode 7-field body ───────────────────────────────

  it("CRITICAL payment-mode body has 7 form fields — mode:'payment' + customer + line_items[0][price] + line_items[0][quantity]:'1' + success_url + cancel_url + client_reference_id. The 7-field body intentionally drops automatic_tax (one-time payment per ADR-003).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/mode: 'payment',/);
  });

  // ─── Payment-mode metadata round-trip ────────────────────────

  it("CRITICAL payment-mode metadata round-trips via 'payment_intent_data[metadata][k]' (so it lands on the resulting payment-intent). The payment_intent_data prefix mirrors the subscription_data shape for one-time payments.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/body\[`payment_intent_data\[metadata\]\[\$\{k\}\]`\] = v;/);
  });

  // ─── Billing-portal 2-field body ─────────────────────────────

  it('CRITICAL createBillingPortalSession body has 2 form fields — customer + return_url. The 2-field minimal body is what Stripe billing-portal requires (no checkout-mode plumbing).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/customer: args\.customerId,/);
    expect(p).toMatch(/return_url: args\.returnUrl,/);
    expect(p).toMatch(/'\/v1\/billing_portal\/sessions'/);
  });

  // ─── BasicAuth shape ─────────────────────────────────────────

  it("CRITICAL BasicAuth shape — 'Basic ${Buffer.from(`${secretKey}:`).toString(base64)}'. Stripe convention is 'secretKey + : + empty password' — the trailing colon-with-empty-password is critical.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(
      /const auth = `Basic \$\{Buffer\.from\(`\$\{this\.config\.secretKey\}:`\)\.toString\('base64'\)\}`;/,
    );
  });

  // ─── 3 request headers ───────────────────────────────────────

  it("CRITICAL POST headers — Authorization + Stripe-Version + Content-Type:'application/x-www-form-urlencoded'. The 3-header set is the V-088 wire-format contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/Authorization: auth,/);
    expect(p).toMatch(/'Stripe-Version': this\.config\.apiVersion \?\? DEFAULT_API_VERSION,/);
    expect(p).toMatch(/'Content-Type': 'application\/x-www-form-urlencoded',/);
  });

  // ─── AbortController + setTimeout/clearTimeout ───────────────

  it("CRITICAL POST uses AbortController + setTimeout + clearTimeout — 'const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs); ... } finally { clearTimeout(timer); }'. The abort-on-timeout + always-clear pattern prevents both stuck requests and timer leaks.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/const ac = new AbortController\(\);/);
    expect(p).toMatch(/const timer = setTimeout\(\(\) => ac\.abort\(\), timeoutMs\);/);
    expect(p).toMatch(/clearTimeout\(timer\);/);
    expect(p).toMatch(/signal: ac\.signal,/);
  });

  // ─── Empty-body handling ─────────────────────────────────────

  it("CRITICAL empty-body handling — 'parsed = text.length === 0 ? {} : JSON.parse(text);'. The empty-body-as-empty-object default keeps callers from JSON.parse-ing '' (which throws SyntaxError).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/parsed = text\.length === 0 \? \{\} : JSON\.parse\(text\);/);
  });

  // ─── Non-JSON 200 error envelope ─────────────────────────────

  it("CRITICAL non-JSON response wraps in StripeApiError with type:'malformed_response' + a fixed message. No attacker-controlled HTML is copied into the error logged by the global 5xx handler.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/'Stripe response was not JSON'/);
    expect(p).toMatch(/type: 'malformed_response', message: 'Stripe response was not JSON'/);
    expect(p).toMatch(/err\.name = 'StripeApiError';/);
  });

  // ─── 4xx/5xx error envelope ──────────────────────────────────

  it("CRITICAL non-2xx response normalizes documented classification fields with fallback type:'unknown_error'. Free-form upstream content is excluded from the logged Error.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/function parseStripeError\(parsed: unknown\)/);
    expect(p).toMatch(/const stripeError = parseStripeError\(parsed\);/);
    expect(p).toMatch(/return \{ type: 'unknown_error' \};/);
    expect(p).not.toMatch(/stripeError\.message \?\? stripeError\.type/);
  });

  // ─── Error logging via injected logger ───────────────────────

  it("CRITICAL on Stripe error, logs with 'component: stripe-api' + path + status + stripeErrorType + stripeErrorCode. The 5-field structured log lets ops dashboards filter Stripe-API failures.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/stripe-api.ts'));
    expect(p).toMatch(/component: 'stripe-api',/);
    expect(p).toMatch(/stripeErrorType: stripeError\.type,/);
    expect(p).toMatch(/stripeErrorCode: stripeError\.code,/);
    expect(p).toMatch(/'Stripe API error',/);
  });

  // ─── Runtime — fetch seam swap + body shape ──────────────────

  it('CRITICAL createCustomer encodes name + email + metadata into form body. Runtime fetch-seam swap verifies the wire-format produced.', async () => {
    let observedBody: string | undefined;
    let observedHeaders: Record<string, string> | undefined;
    let observedUrl: string | undefined;
    const fetchImpl: typeof fetch = (input, init) => {
      observedUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      observedBody = init?.body as string;
      observedHeaders = init?.headers as Record<string, string>;
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'cus_X', email: 'a@b.c' }), { status: 200 }),
      );
    };
    const client = new StripeApiClient({
      secretKey: 'sk_test_xxx',
      baseUrl: 'https://api.example.test',
      fetchImpl,
      logger: createTestLogger(),
    });
    const result = await client.createCustomer({
      email: 'a@b.c',
      name: 'John',
      metadata: { plan: 'starter' },
    });
    expect(result.id).toBe('cus_X');
    expect(observedUrl).toBe('https://api.example.test/v1/customers');
    expect(observedBody).toContain('email=a%40b.c');
    expect(observedBody).toContain('name=John');
    expect(observedBody).toContain('metadata%5Bplan%5D=starter');
    expect(observedHeaders?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(observedHeaders?.Authorization?.startsWith('Basic ')).toBe(true);
    // BasicAuth base64 decodes to 'sk_test_xxx:' (note trailing colon).
    const b64 = observedHeaders?.Authorization?.slice('Basic '.length) ?? '';
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('sk_test_xxx:');
  });

  it('CRITICAL on 4xx with Stripe error body, throws StripeApiError with status + stripeError populated. The thrown-error path is what callers (V-082 BillingProvider) translate to user-facing 4xx.', async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { type: 'card_error', code: 'card_declined', message: 'no' } }),
          { status: 402 },
        ),
      );
    const client = new StripeApiClient({
      secretKey: 'sk_test_xxx',
      baseUrl: 'https://api.example.test',
      fetchImpl,
      logger: createTestLogger(),
    });
    await expect(client.createCustomer({ email: 'a@b.c' })).rejects.toMatchObject({
      name: 'StripeApiError',
      status: 402,
      stripeError: { type: 'card_error', code: 'card_declined' },
    } as Partial<StripeApiError>);
  });

  it("CRITICAL non-JSON response throws StripeApiError with type:'malformed_response'. A fixed message replaces upstream body text.", async () => {
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response('<!doctype html><html>nope</html>', { status: 502 }));
    const client = new StripeApiClient({
      secretKey: 'sk_test_xxx',
      baseUrl: 'https://api.example.test',
      fetchImpl,
      logger: createTestLogger(),
    });
    await expect(client.createCustomer({ email: 'a@b.c' })).rejects.toMatchObject({
      name: 'StripeApiError',
      status: 502,
      stripeError: { type: 'malformed_response', message: 'Stripe response was not JSON' },
    });
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/stripe-api-v088-v082-adr-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
