// W1040 — routes/billing-crypto V-666.C + V-666.AO/AQ/AR cross-source
// invariant. Pins the apps/server/src/routes/billing-crypto.ts
// customer-facing crypto-checkout route:
//
//   V-666.C anchor — 'V-666.C — customer-facing crypto-checkout route'.
//
//   Route path — 'POST /v1/billing/crypto-checkout'.
//
//   Stub-posture framing — 'until the founder lands a NowPayments
//   merchant account + NOWPAYMENTS_API_KEY, we cannot call
//   NowPayments's POST /v1/payment to mint a real pay_address. The
//   route therefore returns payment_address: null and provider:
//   stub'.
//
//   V-666.AO idempotency framing — 'when the caller sends an
//   Idempotency-Key header, the route hands the key to
//   service.createIdempotent(); duplicate keys within the 24h window
//   return the original order verbatim. The response carries an
//   Idempotent-Replayed: 1 header on replays'.
//
//   V-666.AQ replay-log framing — 'replays fire a structured info log
//   (event: crypto_checkout_idempotency_replay). Aggregated, the log
//   line answers "is my checkout button double-firing" without
//   depending on the polling counters endpoint. Fresh writes don't
//   log — they're already captured by the existing request-completed
//   log'.
//
//   V-666.AR body-mismatch warn — 'replays whose body fingerprint
//   differs from the stored one fire an additional warn log
//   (event: crypto_checkout_idempotency_body_mismatch). The contract
//   still replays — the warn surfaces accidental key reuse for ops
//   to see'.
//
//   Supported product enum — 7 entries (trial_pack / solo_manual /
//   solo_automated / team_growth / team_scale / api_starter / api_pro).
//
//   Idempotency-key validation — ASCII printable (\x21-\x7e), 1-255
//   chars, trimmed, no whitespace.
//
//   newOrderId — 'ord_' + 12 hex chars (6 random bytes).
//
// stays in lockstep across apps/server/src/routes/billing-crypto.ts.

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

describe('W1040 routes/billing-crypto V-666.C + V-666.AO/AQ/AR cross-source invariant', () => {
  // ─── V-666.C anchor + stub-posture framing ───────────────────

  it("CRITICAL V-666.C anchor — 'V-666.C — customer-facing crypto-checkout route'. The single-anchor design ties the route to its NowPayments-rail parent V-666.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(p).toMatch(/V-666\.C — customer-facing crypto-checkout route\./);
  });

  it("CRITICAL stub posture — 'until the founder lands a NowPayments merchant account + NOWPAYMENTS_API_KEY, we cannot call NowPayments's POST /v1/payment to mint a real pay_address. The route therefore returns payment_address: null and provider: stub'. The stub-until-keyed posture matches V-487 + V-666 wire-ready precedent.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(p).toMatch(/until the founder lands a NowPayments merchant account \+/);
    expect(p).toMatch(/`NOWPAYMENTS_API_KEY`, we cannot call NowPayments's/);
    expect(p).toMatch(/`POST \/v1\/payment` to mint a real `pay_address`\. The route therefore/);
    expect(p).toMatch(/returns `payment_address: null` and `provider: 'stub'`/);
  });

  // ─── Route path + handler shape ──────────────────────────────

  it('CRITICAL route path — POST /v1/billing/crypto-checkout, gated by requireAuth + global rate-limit. The fixed path is what the customer-dashboard /checkout/crypto page calls.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(p).toMatch(/'\/v1\/billing\/crypto-checkout'/);
    expect(p).toMatch(/preHandler: \[app\.requireAuth, app\.rateLimit\('global'\)\]/);
  });

  it("CRITICAL 201 response shape — order_id + product + price_cents + price_currency + status + provider + payment_address + pay_currency + pay_amount + created_at. 2026-05-21 — V-666.D landed: response fields are now dynamic (real `payment_address` when NowPayments client wired; null stub posture otherwise). Cross-source contract still requires the 10-field envelope so the customer-dashboard's checkout page can render both states.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(p).toMatch(/reply\.code\(201\)\.send\(\{/);
    expect(p).toMatch(/order_id: order\.order_id,/);
    expect(p).toMatch(/product: order\.product,/);
    expect(p).toMatch(/price_cents: order\.price_cents,/);
    expect(p).toMatch(/price_currency: order\.price_currency,/);
    expect(p).toMatch(/status: order\.status,/);
    // V-666.D — dynamic provider + address fields. Both code paths
    // (real-mint + stub fallback) write the same shape; the literal
    // values come from let-bound vars.
    expect(p).toMatch(/provider,/);
    expect(p).toMatch(/payment_address: paymentAddress,/);
    expect(p).toMatch(/pay_currency: payCurrency,/);
    expect(p).toMatch(/pay_amount: payAmount,/);
    expect(p).toMatch(/created_at: new Date\(order\.created_at\)\.toISOString\(\),/);
  });

  // ─── Supported-product enum ──────────────────────────────────

  it('CRITICAL supported-product enum — 7 entries (trial_pack + 6 canonical AccountTier paid tiers). 2026-05-21 — V-666.SEC: enum + price table merged into TIER_PRICE_CENTS so price is server-side authoritative. Trial pack stays in the map for SDK + integration-test backwards-compat; route short-circuits to stub posture when amount < NOWPAYMENTS_MIN_USD_CENTS so the customer never sees amount_too_low.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(p).toMatch(/trial_pack: 299,/);
    expect(p).toMatch(/solo_manual: 7900,/);
    expect(p).toMatch(/team_manual: 24900,/);
    expect(p).toMatch(/agency_manual: 69900,/);
    expect(p).toMatch(/api_starter: 14900,/);
    expect(p).toMatch(/api_builder: 49900,/);
    expect(p).toMatch(/api_scale: 149900,/);
    expect(p).toMatch(/const NOWPAYMENTS_MIN_USD_CENTS = 2000;/);
  });

  it('CRITICAL request schema — product enum + price_cents (int positive <=1_000_000) + price_currency (3-letter uppercase ISO). The constraints catch malformed checkout-page form posts at the boundary.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(p).toMatch(/product: z\.enum\(SUPPORTED_PRODUCTS\),/);
    expect(p).toMatch(/price_cents: z\.number\(\)\.int\(\)\.positive\(\)\.max\(1_000_000\),/);
    expect(p).toMatch(/price_currency must be a 3-letter uppercase ISO code/);
  });

  // ─── V-666.AO idempotency-key plumbing ───────────────────────

  it("CRITICAL V-666.AO idempotency framing — 'when the caller sends an Idempotency-Key header, the route hands the key to service.createIdempotent(); duplicate keys within the 24h window return the original order verbatim. The response carries an Idempotent-Replayed: 1 header on replays so clients can distinguish a retry-success from a fresh create'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(p).toMatch(/V-666\.AO — when the caller sends an `Idempotency-Key` header, the/);
    expect(p).toMatch(/route hands the key to service\.createIdempotent\(\); duplicate keys/);
    expect(p).toMatch(/within the 24h window return the original order verbatim\. The/);
    expect(p).toMatch(/response carries an `Idempotent-Replayed: 1` header on replays so/);
    expect(p).toMatch(/clients can distinguish a retry-success from a fresh create\./);
  });

  it('CRITICAL idempotency-key validation — ASCII printable \\x21-\\x7e, length 1-255, no whitespace, trimmed. Extracted to shared lib/idempotency-key.ts; billing-crypto imports readIdempotencyKey from there. The strict regex catches client-side template bugs that submit raw template syntax as the key.', () => {
    const route = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(route).toMatch(/import \{ readIdempotencyKey \} from '\.\.\/lib\/idempotency-key\.js';/);
    expect(route).toMatch(/Idempotency-Key must be 1-255 ASCII chars \(no whitespace\)\./);

    const lib = read(resolve(REPO_ROOT, 'apps/server/src/lib/idempotency-key.ts'));
    expect(lib).toMatch(/if \(trimmed\.length > 255\) return \{ kind: 'invalid' \};/);
    expect(lib).toMatch(
      /if \(!\/\^\[\\x21-\\x7e\]\+\$\/\.test\(trimmed\)\) return \{ kind: 'invalid' \};/,
    );
  });

  it('CRITICAL idempotency discriminated union — three kinds (absent / valid / invalid). Defined in the shared lib/idempotency-key.ts type IdempotencyHeader. The union lets the route distinguish "client did not send a key" from "client sent a malformed key" without coupling validation to the service.', () => {
    const lib = read(resolve(REPO_ROOT, 'apps/server/src/lib/idempotency-key.ts'));
    expect(lib).toMatch(
      /export type IdempotencyHeader =[\s\S]*?\| \{ kind: 'absent' \}[\s\S]*?\| \{ kind: 'valid'; key: string \}[\s\S]*?\| \{ kind: 'invalid' \};/,
    );
  });

  // ─── V-666.AQ replay info log ────────────────────────────────

  it("CRITICAL V-666.AQ replay info log — 'replays fire a structured info log (event: crypto_checkout_idempotency_replay). Fresh writes don't log — they're already captured by the existing request-completed log'. The replay-only emission keeps the signal high.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(p).toMatch(/V-666\.AQ — replays fire a structured info log \(`event:/);
    expect(p).toMatch(/'crypto_checkout_idempotency_replay'`\)\. Aggregated, the log line/);
    expect(p).toMatch(/answers "is my checkout button double-firing" without depending on/);
    expect(p).toMatch(/the polling counters endpoint\. Fresh writes don't log — they're/);
  });

  it("CRITICAL replay info log shape — 4 fields (event + account_id + order_id + product) + 'crypto checkout replayed via idempotency key' message. The exact field set lets ops dashboards filter by account or by product.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(p).toMatch(/event: 'crypto_checkout_idempotency_replay',/);
    expect(p).toMatch(/account_id: ctx\.account\.id,/);
    expect(p).toMatch(/order_id: order\.order_id,/);
    expect(p).toMatch(/product: order\.product,/);
    expect(p).toMatch(/'crypto checkout replayed via idempotency key'/);
  });

  // ─── V-666.AR body-mismatch warn log ─────────────────────────

  it("CRITICAL V-666.AR body-mismatch warn — 'replays whose body fingerprint differs from the stored one fire an additional warn log (event: crypto_checkout_idempotency_body_mismatch). The contract still replays — the warn surfaces accidental key reuse for ops to see'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(p).toMatch(/V-666\.AR — replays whose body fingerprint differs from the stored/);
    expect(p).toMatch(/one fire an additional warn log \(`event:/);
    expect(p).toMatch(/'crypto_checkout_idempotency_body_mismatch'`\)\. The contract still/);
    expect(p).toMatch(/replays — the warn surfaces accidental key reuse for ops to see\./);
  });

  it("CRITICAL body-mismatch warn shape — 5 fields (event + account_id + order_id + attempted_product + attempted_price_cents + attempted_price_currency) + 'idempotency-key replayed with a different request body' message. The 3 attempted_* fields are the comparison ops use to confirm accidental reuse.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(p).toMatch(/event: 'crypto_checkout_idempotency_body_mismatch',/);
    expect(p).toMatch(/attempted_product: parsed\.data\.product,/);
    expect(p).toMatch(/attempted_price_cents: parsed\.data\.price_cents,/);
    expect(p).toMatch(/attempted_price_currency: parsed\.data\.price_currency,/);
    expect(p).toMatch(/'idempotency-key replayed with a different request body'/);
  });

  // ─── newOrderId shape ────────────────────────────────────────

  it("CRITICAL newOrderId — 'ord_' + 12 hex chars (6 random bytes). The 12-hex-char design is 'enough entropy for the in-memory store + the customer-facing URL while staying short enough to fit on a checkout page banner without wrapping'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts'));
    expect(p).toMatch(/`ord_\$\{randomBytes\(6\)\.toString\('hex'\)\}`/);
    expect(p).toMatch(/12 random hex chars is enough entropy/);
    expect(p).toMatch(/for the in-memory store \+ the customer-facing URL while staying/);
    expect(p).toMatch(/short enough to fit on a checkout page banner without wrapping\./);
  });
});
