// W411.B — drift guard for apps/server/src/routes/webhooks-stripe.ts.
// V-080 inbound Stripe webhook route. Public, no auth — Stripe-Signature
// header IS the auth. Raw body required for HMAC verification over
// `<timestamp>.<raw body>`. Drift here either breaks signature
// verification (lets unauthenticated callers mutate subscription state)
// or returns non-2xx on legitimate events (Stripe retries forever).
//
//   • V-080 framing pinned: POST /v1/webhooks/stripe; public, no auth;
//     Stripe-Signature header IS the auth; sha256 HMAC over
//     `<timestamp>.<raw body>`.
//   • V-666 raw-body framing pinned: shared raw-body content-type
//     parser; Fastify one-parser-per-content-type constraint;
//     registerWebhookRawBodyParser is the only sanctioned path.
//   • Always 2xx on verified+parseable events (including duplicate/
//     ignored) — Stripe interprets non-2xx as delivery failure and
//     retries; record-and-acknowledge posture.
//   • Stripe-Signature header missing → 401 UnauthorizedError.
//   • Empty rawBody → 400 BadRequestError.
//   • Signature verification fail → warn-log with reason + 401 with
//     opaque "Invalid Stripe signature." (don't leak which check failed).
//   • Event shape guard: id/type strings + data non-null object → 400.
//   • Dispatch: deps.service.handle(event, rawBody) → reply 200 with
//     { received: true, outcome }.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-stripe.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W411.B apps/server/src/routes/webhooks-stripe.ts content parity', () => {
  const body = read(LIB);

  it('V-080 framing pinned: POST /v1/webhooks/stripe + public no-auth + Stripe-Signature header IS auth + sha256 HMAC', () => {
    expect(body).toMatch(/Inbound Stripe webhook route \(V-080\)\./);
    expect(body).toMatch(/POST \/v1\/webhooks\/stripe/);
    expect(body).toMatch(
      /Public, no auth — Stripe-Signature header IS the auth\. The route\s*\/\/\s*captures the raw request body \(Stripe verifies a sha256 HMAC over\s*\/\/\s*`<timestamp>\.<raw body>`\) and rejects everything that doesn't\s*\/\/\s*pass signature verification before reaching the dispatch layer\./,
    );
  });

  it('V-666 raw-body framing pinned: shared content-type parser; Fastify one-parser-per-content-type; registerWebhookRawBodyParser sanctioned', () => {
    expect(body).toMatch(
      /Body parsing: V-666 — the raw-body content-type parser is shared\s*\/\/\s*across all webhook routes \(Stripe \+ NowPayments \+ future\) via\s*\/\/\s*`registerWebhookRawBodyParser`\. Fastify only allows ONE parser per\s*\/\/\s*content-type, so the shared module is the only sanctioned path\./,
    );
    expect(body).toMatch(/registerWebhookRawBodyParser\(app\);/);
  });

  it('RegisterStripeWebhookRoutesDeps: service + signingSecret (whsec_) + logger', () => {
    expect(body).toMatch(/export interface RegisterStripeWebhookRoutesDeps \{/);
    expect(body).toMatch(/service: StripeWebhooksService;/);
    expect(body).toMatch(
      /\/\*\* Webhook signing secret as configured in Stripe \(`whsec_\.\.\.`\)\. \*\/\s*signingSecret: string;/,
    );
    expect(body).toMatch(/logger: Logger;/);
  });

  it('Stripe-Signature header missing → 401 UnauthorizedError (+ bumpOutcome metric)', () => {
    expect(body).toMatch(/const sigHeader = req\.headers\['stripe-signature'\];/);
    expect(body).toMatch(
      /if \(typeof sigHeader !== 'string' \|\| sigHeader\.length === 0\) \{\s*bumpOutcome\('signature_missing'\);[\s\S]*?throw new UnauthorizedError\('Stripe-Signature header missing\.'\);/,
    );
  });

  it('Empty rawBody → 400 BadRequestError "Empty request body." (+ bumpOutcome metric)', () => {
    expect(body).toMatch(/const rawBody = req\.rawBody;/);
    expect(body).toMatch(
      /if \(typeof rawBody !== 'string' \|\| rawBody\.length === 0\) \{\s*bumpOutcome\('empty_body'\);[\s\S]*?throw new BadRequestError\('Empty request body\.'\);/,
    );
  });

  it('verifyStripeSignature: rawBody + header + secret; on !ok warn-log reason + opaque 401 "Invalid Stripe signature." (no leak)', () => {
    expect(body).toMatch(
      /const verified = verifyStripeSignature\(\{\s*rawBody,\s*header: sigHeader,\s*secret: deps\.signingSecret,\s*\}\);/,
    );
    expect(body).toMatch(
      /deps\.logger\.warn\(\s*\{ component: 'stripe-webhooks', reason: verified\.reason \},\s*'Stripe webhook signature verification failed',\s*\);/,
    );
    expect(body).toMatch(
      /\/\/ Don't leak which check failed in the response — Stripe's docs\s*\/\/ say "any 4xx" causes a retry, so 401 is fine\. Log the reason\./,
    );
    expect(body).toMatch(/throw new UnauthorizedError\('Invalid Stripe signature\.'\);/);
  });

  it('Event shape guard: id/type strings + data non-null object → 400 with "Stripe event is missing required fields." (+ bumpOutcome metric)', () => {
    expect(body).toMatch(/const event = req\.body as StripeEvent;/);
    expect(body).toMatch(
      /if \(\s*typeof event\.id !== 'string' \|\|\s*typeof event\.type !== 'string' \|\|\s*typeof event\.data !== 'object' \|\|\s*event\.data === null\s*\) \{\s*bumpOutcome\('malformed_event'\);[\s\S]*?throw new BadRequestError\('Stripe event is missing required fields\.'\);/,
    );
  });

  it('Dispatch: deps.service.handle wrapped so a transient rethrow 500s (C5); else always 200 on verified+parseable with {received:true, outcome}', () => {
    expect(body).toMatch(/outcome = await deps\.service\.handle\(event, rawBody\);/);
    // C5 — a transient rethrow from handle() surfaces as a 500 so Stripe retries.
    expect(body).toMatch(/bumpOutcome\('handler_transient_error'\);\s*throw err;/);
    expect(body).toMatch(
      /\/\/ Always reply 200 to a verified, parseable event that was processed —[\s\S]+?even on duplicate or ignored\. Stripe interprets non-2xx as a delivery[\s\S]+?transient infra error above, which we deliberately let 500/,
    );
    expect(body).toMatch(
      /return reply\.code\(200\)\.send\(\{\s*received: true,\s*outcome,\s*\}\);/,
    );
  });

  it('imports: FastifyInstance/FastifyRequest + verifyStripeSignature + StripeEvent/StripeWebhooksService + Errors + Logger + raw-body parser', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(
      /import \{ verifyStripeSignature \} from '\.\.\/lib\/stripe-signing\.js';/,
    );
    expect(body).toMatch(
      /import \{ type StripeEvent, type StripeWebhooksService \} from '\.\.\/services\/stripe-webhooks\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, UnauthorizedError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(
      /import \{ registerWebhookRawBodyParser \} from '\.\/_webhook-raw-body\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
