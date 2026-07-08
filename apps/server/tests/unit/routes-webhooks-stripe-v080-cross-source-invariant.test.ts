// W1023 — routes/webhooks-stripe V-080 cross-source invariant. Three-
// hundred-forty-ninth in the drift-guard series. Pins the apps/
// server/src/routes/webhooks-stripe.ts inbound-Stripe-webhook route:
//
//   V-080 anchor — 'Inbound Stripe webhook route (V-080). POST /v1/
//   webhooks/stripe'.
//
//   Auth-via-signature framing — 'Public, no auth — Stripe-Signature
//   header IS the auth. The route captures the raw request body
//   (Stripe verifies a sha256 HMAC over <timestamp>.<raw body>) and
//   rejects everything that doesn't pass signature verification
//   before reaching the dispatch layer'.
//
//   V-666 raw-body-shared framing — 'Body parsing: V-666 — the raw-
//   body content-type parser is shared across all webhook routes
//   (Stripe + NowPayments + future) via registerWebhookRawBodyParser.
//   Fastify only allows ONE parser per content-type, so the shared
//   module is the only sanctioned path'.
//
//   registerWebhookRawBodyParser(app) called inside route registrar.
//
//   3-step validation ladder:
//     1. Missing/empty stripe-signature header → UnauthorizedError.
//     2. Missing/empty req.rawBody → BadRequestError.
//     3. verifyStripeSignature fails → UnauthorizedError (no leak
//        of which check failed; Stripe retries on any 4xx).
//
//   Event-shape 4-field check — id (string) + type (string) + data
//     (object) + data !== null.
//
//   Always-200 framing — 'Always reply 200 to a verified, parseable
//   event — even on duplicate or ignored. Stripe interprets non-2xx
//   as a delivery failure and retries; we'd rather acknowledge and
//   record than force a re-delivery loop on every ignored event-type'.
//
//   Response — 200 + { received: true, outcome }.
//
//   Failure log — 'Stripe webhook signature verification failed' warn
//     with component:'stripe-webhooks' + reason.
//
// stays in lockstep across apps/server/src/routes/webhooks-stripe.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1023 routes/webhooks-stripe V-080 cross-source invariant', () => {
  it("CRITICAL V-080 anchor — 'Inbound Stripe webhook route (V-080)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-stripe.ts'));
    expect(p).toMatch(/\/\/ Inbound Stripe webhook route \(V-080\)\./);
    expect(p).toMatch(/POST \/v1\/webhooks\/stripe/);
  });

  it("CRITICAL auth-via-signature framing — 'Public, no auth — Stripe-Signature header IS the auth. The route captures the raw request body (Stripe verifies a sha256 HMAC over <timestamp>.<raw body>) and rejects everything that doesn't pass signature verification before reaching the dispatch layer'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-stripe.ts'));
    expect(p).toMatch(/Public, no auth — Stripe-Signature header IS the auth\./);
    expect(p).toMatch(/captures the raw request body \(Stripe verifies a sha256 HMAC over/);
    expect(p).toMatch(/`<timestamp>\.<raw body>`\) and rejects everything that doesn't/);
    expect(p).toMatch(/pass signature verification before reaching the dispatch layer\./);
  });

  it("CRITICAL V-666 raw-body-shared framing — 'Body parsing: V-666 — the raw-body content-type parser is shared across all webhook routes (Stripe + NowPayments + future) via registerWebhookRawBodyParser. Fastify only allows ONE parser per content-type, so the shared module is the only sanctioned path'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-stripe.ts'));
    expect(p).toMatch(/Body parsing: V-666 — the raw-body content-type parser is shared/);
    expect(p).toMatch(/across all webhook routes \(Stripe \+ NowPayments \+ future\) via/);
    expect(p).toMatch(/`registerWebhookRawBodyParser`\. Fastify only allows ONE parser per/);
    expect(p).toMatch(/content-type, so the shared module is the only sanctioned path\./);
    expect(p).toMatch(/registerWebhookRawBodyParser\(app\);/);
  });

  it('CRITICAL 3-step validation — missing sig → UnauthorizedError + missing rawBody → BadRequestError + verify-fails → UnauthorizedError.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-stripe.ts'));
    expect(p).toMatch(/if \(typeof sigHeader !== 'string' \|\| sigHeader\.length === 0\) \{/);
    expect(p).toMatch(/throw new UnauthorizedError\('Stripe-Signature header missing\.'\);/);
    expect(p).toMatch(/if \(typeof rawBody !== 'string' \|\| rawBody\.length === 0\) \{/);
    expect(p).toMatch(/throw new BadRequestError\('Empty request body\.'\);/);
    expect(p).toMatch(/if \(!verified\.ok\) \{/);
    expect(p).toMatch(/throw new UnauthorizedError\('Invalid Stripe signature\.'\);/);
  });

  it("CRITICAL no-leak-of-reason framing — 'Don't leak which check failed in the response — Stripe's docs say any 4xx causes a retry, so 401 is fine. Log the reason'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-stripe.ts'));
    expect(p).toMatch(/\/\/ Don't leak which check failed in the response — Stripe's docs/);
    expect(p).toMatch(/\/\/ say "any 4xx" causes a retry, so 401 is fine\. Log the reason\./);
  });

  it('CRITICAL failure log — warn with component:stripe-webhooks + reason + message Stripe webhook signature verification failed.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-stripe.ts'));
    expect(p).toMatch(/deps\.logger\.warn\(/);
    expect(p).toMatch(/\{ component: 'stripe-webhooks', reason: verified\.reason \},/);
    expect(p).toMatch(/'Stripe webhook signature verification failed',/);
  });

  it('CRITICAL event-shape 4-field check — id (string) + type (string) + data (object) + data !== null.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-stripe.ts'));
    expect(p).toMatch(/typeof event\.id !== 'string' \|\|/);
    expect(p).toMatch(/typeof event\.type !== 'string' \|\|/);
    expect(p).toMatch(/typeof event\.data !== 'object' \|\|/);
    expect(p).toMatch(/event\.data === null/);
    expect(p).toMatch(/throw new BadRequestError\('Stripe event is missing required fields\.'\);/);
  });

  it("CRITICAL always-200 framing — 'Always reply 200 to a verified, parseable event that was processed — even on duplicate or ignored... the one exception is a transient infra error, which we deliberately let 500 (C5)'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-stripe.ts'));
    expect(p).toMatch(/\/\/ Always reply 200 to a verified, parseable event that was processed —/);
    expect(p).toMatch(
      /\/\/ even on duplicate or ignored\. Stripe interprets non-2xx as a delivery/,
    );
    expect(p).toMatch(/\/\/ failure and retries; we'd rather acknowledge and record than force a/);
    expect(p).toMatch(/\/\/ transient infra error above, which we deliberately let 500 \(C5\)\./);
    expect(p).toMatch(/return reply\.code\(200\)\.send\(\{/);
    expect(p).toMatch(/received: true,/);
    expect(p).toMatch(/outcome,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/routes-webhooks-stripe-v080-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
