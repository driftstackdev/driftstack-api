// W412.A — drift guard for apps/server/src/routes/webhooks-nowpayments.ts.
// V-666 NowPayments IPN webhook route (V-487 follow-through). Public,
// no auth — `x-nowpayments-sig` header IS the auth via HMAC-SHA512.
// Drift here either breaks signature verification (lets fake IPNs
// mutate order state) or breaks the V-666.B order-state forwarding
// (status updates stop reaching the customer).
//
//   • V-666 / V-487 framing pinned: POST /v1/webhooks/nowpayments;
//     public no-auth; x-nowpayments-sig IS the auth; HMAC-SHA512;
//     shared raw-body parser.
//   • Wire-ready posture pinned: registration gated on
//     NOWPAYMENTS_IPN_SECRET in lib/app.ts; when enabled before V-487
//     order flow, route verifies + logs without forwarding.
//   • V-666.B framing: when ordersService provided, forwards IPN
//     into crypto-orders state machine; when omitted, logs + acks only.
//   • Auth failures: missing header / empty body → 4xx via existing
//     errors (no signature leak in response).
//   • IPN payload shape guard: payment_id (number|string) +
//     payment_status (string) required → 400 otherwise.
//   • Reply: 200 { received: true, order_state } — order_state nullable.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W412.A apps/server/src/routes/webhooks-nowpayments.ts content parity', () => {
  const body = read(LIB);

  it('V-666 / V-487 framing pinned: POST /v1/webhooks/nowpayments + public no-auth + x-nowpayments-sig HMAC-SHA512 + shared raw-body parser', () => {
    expect(body).toMatch(/V-666 — NowPayments IPN webhook route \(V-487 follow-through\)\./);
    expect(body).toMatch(/POST \/v1\/webhooks\/nowpayments/);
    expect(body).toMatch(
      /Public, no auth — `x-nowpayments-sig` header IS the auth\. The route\s*\n?\s*\/\/\s*captures the raw request body via the shared webhook raw-body parser\s*\n?\s*\/\/\s*\(see `_webhook-raw-body\.ts`\) and verifies the HMAC-SHA512 signature\s*\n?\s*\/\/\s*against the IPN secret from the NowPayments dashboard\./,
    );
    expect(body).toMatch(/registerWebhookRawBodyParser\(app\);/);
  });

  it('Wire-ready posture pinned: registration gated on NOWPAYMENTS_IPN_SECRET in lib/app.ts; pre-V-487 logs + acks only', () => {
    expect(body).toMatch(
      /Posture: wire-ready\. Until the founder lands a merchant account \+\s*\n?\s*\/\/\s*`NOWPAYMENTS_IPN_SECRET`, the route stays unregistered \(the wiring in\s*\n?\s*\/\/\s*`lib\/app\.ts` is gated on `deps\.nowpaymentsIpnSecret`\)\. When enabled,\s*\n?\s*\/\/\s*the route verifies the signature and logs the event; the actual\s*\n?\s*\/\/\s*order-status-update flow \(V-487\) lands when the customer-side\s*\n?\s*\/\/\s*checkout pages at `\/checkout\/crypto` go live\./,
    );
  });

  it('Deps: ipnSecret + logger + optional ordersService with V-666.B JSDoc framing', () => {
    expect(body).toMatch(/export interface RegisterNowpaymentsWebhookRoutesDeps \{/);
    expect(body).toMatch(
      /\/\*\* IPN secret from the NowPayments merchant dashboard\. \*\/\s*\n?\s*ipnSecret: string;/,
    );
    expect(body).toMatch(/logger: Logger;/);
    expect(body).toMatch(
      /V-666\.B — when provided, the route forwards verified IPN updates\s*\n?\s*\*\s*into the crypto-orders state machine\. When omitted, the route\s*\n?\s*\*\s*logs \+ acks only \(W44 V-666 wire-ready posture\)\./,
    );
    expect(body).toMatch(/ordersService\?: CryptoOrdersService;/);
  });

  it('NowpaymentsIpnPayload: 9 optional fields including payment_id number|string + payment_status + order_id + pay_address + price/pay amounts', () => {
    expect(body).toMatch(/interface NowpaymentsIpnPayload \{/);
    expect(body).toMatch(/payment_id\?: number \| string;/);
    expect(body).toMatch(/payment_status\?: string;/);
    expect(body).toMatch(/order_id\?: string;/);
    expect(body).toMatch(/pay_address\?: string;/);
    expect(body).toMatch(/price_amount\?: number;/);
    expect(body).toMatch(/price_currency\?: string;/);
    expect(body).toMatch(/pay_amount\?: number;/);
    expect(body).toMatch(/pay_currency\?: string;/);
    expect(body).toMatch(/actually_paid\?: number;/);
  });

  it('Missing x-nowpayments-sig → 401 UnauthorizedError (+ bumpOutcome metric)', () => {
    expect(body).toMatch(/const sigHeader = req\.headers\['x-nowpayments-sig'\];/);
    expect(body).toMatch(
      /if \(typeof sigHeader !== 'string' \|\| sigHeader\.length === 0\) \{\s*\n?\s*bumpOutcome\('signature_missing'\);\s*\n?\s*throw new UnauthorizedError\('x-nowpayments-sig header missing\.'\);/,
    );
  });

  it('Empty rawBody → 400 BadRequestError "Empty request body." (+ bumpOutcome metric)', () => {
    expect(body).toMatch(/const rawBody = req\.rawBody;/);
    expect(body).toMatch(
      /if \(typeof rawBody !== 'string' \|\| rawBody\.length === 0\) \{\s*\n?\s*bumpOutcome\('empty_body'\);\s*\n?\s*throw new BadRequestError\('Empty request body\.'\);/,
    );
  });

  it('verifyNowpaymentsSignature: body+secret+signature; on !verified bumpOutcome + warn-log + opaque 401 "Invalid NowPayments signature."', () => {
    expect(body).toMatch(
      /const verified = verifyNowpaymentsSignature\(\{\s*\n?\s*body: rawBody,\s*\n?\s*secret: deps\.ipnSecret,\s*\n?\s*signature: sigHeader,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /if \(!verified\) \{\s*\n?\s*bumpOutcome\('signature_invalid'\);\s*\n?\s*deps\.logger\.warn\(\s*\n?\s*\{ component: 'nowpayments-webhooks' \},\s*\n?\s*'NowPayments IPN signature verification failed',\s*\n?\s*\);\s*\n?\s*throw new UnauthorizedError\('Invalid NowPayments signature\.'\);/,
    );
  });

  it('Payload shape guard: payment_id number|string + payment_status string → 400 otherwise (+ bumpOutcome metric)', () => {
    expect(body).toMatch(/const payload = req\.body as NowpaymentsIpnPayload;/);
    expect(body).toMatch(
      /if \(\s*\n?\s*payload === null \|\|\s*\n?\s*typeof payload !== 'object' \|\|\s*\n?\s*\(typeof payload\.payment_id !== 'number' && typeof payload\.payment_id !== 'string'\) \|\|\s*\n?\s*typeof payload\.payment_status !== 'string'\s*\n?\s*\) \{\s*\n?\s*bumpOutcome\('malformed_event'\);\s*\n?\s*throw new BadRequestError\('NowPayments IPN is missing required fields\.'\);/,
    );
  });

  it('V-666.B forward: ordersService.applyIpnStatus when ordersService AND payload.order_id string; updated.status ?? null; orderState defaults null', () => {
    expect(body).toMatch(
      /\/\/ V-666\.B — forward verified IPN into the order-status state\s*\n?\s*\/\/ machine\. When ordersService is omitted \(W44 wire-ready posture\)\s*\n?\s*\/\/ the route still acks 200 \+ logs\./,
    );
    expect(body).toMatch(/let orderState: string \| null = null;/);
    expect(body).toMatch(
      /if \(deps\.ordersService !== undefined && typeof payload\.order_id === 'string'\) \{\s*\n?\s*const updated = await deps\.ordersService\.applyIpnStatus\(\{\s*\n?\s*order_id: payload\.order_id,\s*\n?\s*payment_id: String\(payload\.payment_id\),\s*\n?\s*provider_status: payload\.payment_status,\s*\n?\s*\}\);\s*\n?\s*orderState = updated\?\.status \?\? null;/,
    );
  });

  it('Info-log + 200 reply { received: true, order_state }', () => {
    expect(body).toMatch(/'NowPayments IPN received \(signature OK\)',/);
    expect(body).toMatch(
      /return reply\.code\(200\)\.send\(\{ received: true, order_state: orderState \}\);/,
    );
  });

  it('imports: FastifyInstance/FastifyRequest + verifyNowpaymentsSignature + BadRequestError/UnauthorizedError + Logger + CryptoOrdersService + raw-body parser', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(
      /import \{ verifyNowpaymentsSignature \} from '\.\.\/lib\/nowpayments-signing\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, UnauthorizedError \} from '\.\.\/lib\/errors\.js';/,
    );
    expect(body).toMatch(/import type \{ Logger \} from '\.\.\/lib\/logger\.js';/);
    expect(body).toMatch(
      /import type \{ CryptoOrdersService \} from '\.\.\/services\/crypto-orders\.js';/,
    );
    expect(body).toMatch(
      /import \{ registerWebhookRawBodyParser \} from '\.\/_webhook-raw-body\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
