// W1039 — routes/webhooks-nowpayments V-666 + V-487 cross-source
// invariant. Three-hundred-… in the drift-guard series. Pins the
// apps/server/src/routes/webhooks-nowpayments.ts IPN handler:
//
//   V-666 anchor — 'V-666 — NowPayments IPN webhook route (V-487
//   follow-through)'.
//
//   Posture comment — 'Public, no auth — x-nowpayments-sig header IS
//   the auth. The route captures the raw request body via the shared
//   webhook raw-body parser (see _webhook-raw-body.ts) and verifies
//   the HMAC-SHA512 signature against the IPN secret from the
//   NowPayments dashboard'.
//
//   Wire-ready posture — 'Posture: wire-ready. Until the founder lands
//   a merchant account + NOWPAYMENTS_IPN_SECRET, the route stays
//   unregistered (the wiring in lib/app.ts is gated on
//   deps.nowpaymentsIpnSecret)'.
//
//   Route path — 'POST /v1/webhooks/nowpayments'.
//
//   Signature header — 'x-nowpayments-sig'.
//
//   Missing-sig → 401 with 'x-nowpayments-sig header missing.'.
//
//   Empty body → 400 with 'Empty request body.'.
//
//   Invalid-sig → 401 with 'Invalid NowPayments signature.' and a
//   warn-level log with component 'nowpayments-webhooks'.
//
//   Missing-fields → 400 with 'NowPayments IPN is missing required
//   fields.' (payment_id must be string|number, payment_status must be
//   a string).
//
//   V-666.B forwarding — 'forward verified IPN into the order-status
//   state machine. When ordersService is omitted (W44 wire-ready
//   posture) the route still acks 200 + logs'.
//
//   Success response shape — 200 with {received: true, order_state}.
//
// stays in lockstep across apps/server/src/routes/webhooks-nowpayments.ts.

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

describe('W1039 routes/webhooks-nowpayments V-666 + V-487 cross-source invariant', () => {
  // ─── V-666 + V-487 framing ───────────────────────────────────

  it("CRITICAL V-666 + V-487 header anchor — 'V-666 — NowPayments IPN webhook route (V-487 follow-through)'. The dual-anchor design ties the IPN handler back to both the V-666 scaffold and the V-487 crypto-rail.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/V-666 — NowPayments IPN webhook route \(V-487 follow-through\)\./);
  });

  it("CRITICAL signature-IS-auth framing — 'Public, no auth — x-nowpayments-sig header IS the auth. The route captures the raw request body via the shared webhook raw-body parser (see _webhook-raw-body.ts) and verifies the HMAC-SHA512 signature against the IPN secret from the NowPayments dashboard'. The HMAC-SHA512-as-auth design matches the Stripe-webhook signature precedent.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/Public, no auth — `x-nowpayments-sig` header IS the auth\. The route/);
    expect(p).toMatch(/captures the raw request body via the shared webhook raw-body parser/);
    expect(p).toMatch(/\(see `_webhook-raw-body\.ts`\) and verifies the HMAC-SHA512 signature/);
    expect(p).toMatch(/against the IPN secret from the NowPayments dashboard\./);
  });

  it("CRITICAL wire-ready posture framing — 'Posture: wire-ready. Until the founder lands a merchant account + NOWPAYMENTS_IPN_SECRET, the route stays unregistered (the wiring in lib/app.ts is gated on deps.nowpaymentsIpnSecret)'. The unregistered-until-keyed design lets launch-day flip the rail on without a redeploy.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/Posture: wire-ready\. Until the founder lands a merchant account \+/);
    expect(p).toMatch(/`NOWPAYMENTS_IPN_SECRET`, the route stays unregistered \(the wiring in/);
    expect(p).toMatch(/`lib\/app\.ts` is gated on `deps\.nowpaymentsIpnSecret`\)\./);
  });

  // ─── Route surface ───────────────────────────────────────────

  it('CRITICAL route path — POST /v1/webhooks/nowpayments. The fixed path lets the merchant-dashboard webhook config point at one stable URL.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/app\.post\('\/v1\/webhooks\/nowpayments',/);
  });

  it("CRITICAL signature header — 'x-nowpayments-sig'. The fixed header name matches NowPayments' merchant API spec.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/req\.headers\['x-nowpayments-sig'\]/);
  });

  // ─── Error paths ─────────────────────────────────────────────

  it("CRITICAL missing-sig → 401 with 'x-nowpayments-sig header missing.'. The explicit 401-not-400 design treats absent-sig the same as bad-sig.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/UnauthorizedError\('x-nowpayments-sig header missing\.'\)/);
  });

  it("CRITICAL empty-body → 400 with 'Empty request body.'. The 400-on-empty-body separates client-mistake from auth failure.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/BadRequestError\('Empty request body\.'\)/);
  });

  it("CRITICAL bad-sig → 401 + warn log with component 'nowpayments-webhooks'. The structured warn-with-component lets ops dashboards filter the failure mode.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/deps\.logger\.warn\(/);
    expect(p).toMatch(/component: 'nowpayments-webhooks'/);
    expect(p).toMatch(/'NowPayments IPN signature verification failed'/);
    expect(p).toMatch(/UnauthorizedError\('Invalid NowPayments signature\.'\)/);
  });

  it("CRITICAL missing-fields → 400 with 'NowPayments IPN is missing required fields.' The payment_id type-union (number|string) + payment_status type-narrowing happens at the route, not in the verifier.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(
      /typeof payload\.payment_id !== 'number' && typeof payload\.payment_id !== 'string'/,
    );
    expect(p).toMatch(/typeof payload\.payment_status !== 'string'/);
    expect(p).toMatch(/BadRequestError\('NowPayments IPN is missing required fields\.'\)/);
  });

  // ─── V-666.B forwarding posture ──────────────────────────────

  it("CRITICAL V-666.B forwarding framing — 'forward verified IPN into the order-status state machine. When ordersService is omitted (W44 wire-ready posture) the route still acks 200 + logs'. The optional-service slot lets V-666.B land separately from V-666.A wiring.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/V-666\.B — forward verified IPN into the order-status state/);
    expect(p).toMatch(/machine\. When ordersService is omitted \(W44 wire-ready posture\)/);
    expect(p).toMatch(/the route still acks 200 \+ logs\./);
  });

  it('CRITICAL ordersService applyIpnStatus call shape — order_id + payment_id (stringified) + provider_status. The exact-three-field call is the IPN-to-domain-state mapping.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/deps\.ordersService\.applyIpnStatus\(\{/);
    expect(p).toMatch(/order_id: payload\.order_id,/);
    expect(p).toMatch(/payment_id: String\(payload\.payment_id\),/);
    expect(p).toMatch(/provider_status: payload\.payment_status,/);
  });

  // ─── Success ack ─────────────────────────────────────────────

  it('CRITICAL success ack — 200 with {received: true, order_state}. The order_state field carries the post-transition status when ordersService is wired, null otherwise.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/reply\.code\(200\)\.send\(\{ received: true, order_state: orderState \}\)/);
  });

  it("CRITICAL success info log — 5 structured fields ('component: nowpayments-webhooks' + payment_id + payment_status + order_id + order_state) + 'NowPayments IPN received (signature OK)' message. The 5-field log gives ops a complete state snapshot per IPN.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/deps\.logger\.info\(/);
    expect(p).toMatch(/component: 'nowpayments-webhooks',/);
    expect(p).toMatch(/payment_id: payload\.payment_id,/);
    expect(p).toMatch(/payment_status: payload\.payment_status,/);
    expect(p).toMatch(/order_id: payload\.order_id,/);
    expect(p).toMatch(/order_state: orderState,/);
    expect(p).toMatch(/'NowPayments IPN received \(signature OK\)'/);
  });

  // ─── Raw-body parser wiring ──────────────────────────────────

  it('CRITICAL raw-body parser registered at the top of registerNowpaymentsWebhookRoutes. The single registerWebhookRawBodyParser(app) call is the seam to the shared parser.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/webhooks-nowpayments.ts'));
    expect(p).toMatch(/registerWebhookRawBodyParser\(app\);/);
  });
});
