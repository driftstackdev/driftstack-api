// W419.B — drift guard for apps/server/src/routes/billing-crypto.ts.
// V-666.C customer-facing crypto-checkout. POST /v1/billing/
// crypto-checkout mints CryptoOrder. V-666.AO Idempotency-Key for
// 24h replay window. V-666.AQ replay-info-log + V-666.AR body-
// fingerprint-mismatch warn. Drift here either breaks idempotency
// replay (double-charges customer) or drops the fingerprint-mismatch
// warn (silent accidental key reuse).
//
//   • V-666.C framing pinned: stub provider posture until
//     NowPayments merchant + NOWPAYMENTS_API_KEY land; pay_address
//     null + provider 'stub' until V-666.D follow-up.
//   • V-666.AO framing pinned: Idempotency-Key 24h-window dup
//     returns original order; Idempotent-Replayed: 1 header on
//     replays.
//   • V-666.AQ framing pinned: replay info-log (event=
//     'crypto_checkout_idempotency_replay') answers "is my checkout
//     button double-firing" without polling counters endpoint.
//     Fresh writes don't log — request-completed log already
//     captures them.
//   • V-666.AR framing pinned: body-fingerprint mismatch warn-log
//     (event='crypto_checkout_idempotency_body_mismatch'); contract
//     still replays.
//   • SUPPORTED_PRODUCTS allowlist: trial_pack + solo_manual +
//     solo_automated + team_growth + team_scale + api_starter +
//     api_pro (as const 7-tuple).
//   • CreateCryptoCheckoutSchema: zod product enum + price_cents
//     int positive max 1_000_000 + price_currency 3-letter
//     uppercase ISO regex.
//   • newOrderId: 12 random hex chars (randomBytes(6)) + ord_ prefix.
//   • IdempotencyHeader discriminated union: absent | valid | invalid;
//     trim + 1..255 ASCII printable [\x21-\x7e] regex.
//   • Reply 201: order_id/product/price/status + stub provider/
//     payment_address null/pay_currency null + created_at ISO.
//   • Auth: requireAuth + rateLimit('global').

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/routes/billing-crypto.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W419.B apps/server/src/routes/billing-crypto.ts content parity', () => {
  const body = read(LIB);

  it('V-666.C framing pinned: POST /v1/billing/crypto-checkout mints CryptoOrder; stub provider until NowPayments merchant + NOWPAYMENTS_API_KEY land', () => {
    expect(body).toMatch(/V-666\.C — customer-facing crypto-checkout route\./);
    expect(body).toMatch(/POST \/v1\/billing\/crypto-checkout/);
    expect(body).toMatch(
      /Customers on the `\/checkout\/crypto` page hit this to mint a new\s*\/\/\s*CryptoOrder\. The response carries an order_id \+ a stubbed payment\s*\/\/\s*context: until the founder lands a NowPayments merchant account \+\s*\/\/\s*`NOWPAYMENTS_API_KEY`, we cannot call NowPayments's\s*\/\/\s*`POST \/v1\/payment` to mint a real `pay_address`\. The route therefore\s*\/\/\s*returns `payment_address: null` and `provider: 'stub'` — the front\s*\/\/\s*end shows a "set up by support" notice in that posture\./,
    );
  });

  it('V-666.AO Idempotency-Key framing pinned: 24h window replay returns original order verbatim; Idempotent-Replayed:1 header distinguishes retry-success from fresh create', () => {
    expect(body).toMatch(
      /V-666\.AO — when the caller sends an `Idempotency-Key` header, the\s*\/\/\s*route hands the key to service\.createIdempotent\(\); duplicate keys\s*\/\/\s*within the 24h window return the original order verbatim\. The\s*\/\/\s*response carries an `Idempotent-Replayed: 1` header on replays so\s*\/\/\s*clients can distinguish a retry-success from a fresh create\./,
    );
    expect(body).toMatch(/void reply\.header\('Idempotent-Replayed', '1'\);/);
  });

  it('V-666.AQ replay info-log framing pinned: answers "double-firing button" without polling endpoint; fresh writes don\'t log (request-completed log already captures)', () => {
    expect(body).toMatch(
      /V-666\.AQ — replays fire a structured info log \(`event:\s*\/\/\s*'crypto_checkout_idempotency_replay'`\)\. Aggregated, the log line\s*\/\/\s*answers "is my checkout button double-firing" without depending on\s*\/\/\s*the polling counters endpoint\. Fresh writes don't log — they're\s*\/\/\s*already captured by the existing request-completed log\./,
    );
    expect(body).toMatch(/event: 'crypto_checkout_idempotency_replay',/);
  });

  it('V-666.AR body-fingerprint mismatch warn-log framing pinned: contract still replays; warn surfaces accidental key reuse for ops', () => {
    expect(body).toMatch(
      /V-666\.AR — replays whose body fingerprint differs from the stored\s*\/\/\s*one fire an additional warn log \(`event:\s*\/\/\s*'crypto_checkout_idempotency_body_mismatch'`\)\. The contract still\s*\/\/\s*replays — the warn surfaces accidental key reuse for ops to see\./,
    );
    expect(body).toMatch(/event: 'crypto_checkout_idempotency_body_mismatch',/);
    expect(body).toMatch(/'idempotency-key replayed with a different request body',/);
  });

  it('SUPPORTED_PRODUCTS derives from TIER_PRICE_CENTS map keys — the allowlist of the 6 self-serve paid tiers. 2026-05-21 — V-666.SEC: the prior 7-tuple included stale scaffold tier names (solo_automated/team_growth/team_scale/api_pro) AND trusted customer-supplied price_cents (price-tampering vulnerability). 2026-06-04 (pricing-as-data Phase A): TIER_PRICE_CENTS is now the SEED + FALLBACK (the charge reads PricingService); SUPPORTED_PRODUCTS is still `Object.keys(TIER_PRICE_CENTS)` cast (the purchasable-tier domain is constant). trial_pack was removed 2026-05-27 (free tier is not purchasable).', () => {
    expect(body).not.toMatch(/trial_pack: 299/);
    expect(body).toMatch(/solo_manual: 7900,/);
    expect(body).toMatch(/team_manual: 24900,/);
    expect(body).toMatch(/agency_manual: 69900,/);
    expect(body).toMatch(/api_starter: 14900,/);
    expect(body).toMatch(/api_builder: 49900,/);
    expect(body).toMatch(/api_scale: 149900,/);
    expect(body).toMatch(
      /const SUPPORTED_PRODUCTS = Object\.keys\(TIER_PRICE_CENTS\) as \[string, \.\.\.string\[\]\];/,
    );
    expect(body).toMatch(/const NOWPAYMENTS_MIN_USD_CENTS = 2000;/);
  });

  it('pricing-as-data Phase A 2c: the authoritative charge reads PricingService.listEffective() (DB pricing table + constant fallback), NOT the inline constant directly — so the owner pricing editor moves the charged amount. TIER_PRICE_CENTS stays as the seed+fallback (still asserted above). A revert to a direct constant lookup for the charge would re-break the editable-pricing contract.', () => {
    // Route declares the PricingService dependency.
    expect(body).toMatch(/import type \{ PricingService \} from '\.\.\/services\/pricing\.js';/);
    expect(body).toMatch(/pricing: PricingService;/);
    // The charged amount is sourced from the effective (DB-backed) pricing,
    // keyed by the validated product slug.
    expect(body).toMatch(/const effectivePricing = await deps\.pricing\.listEffective\(\);/);
    expect(body).toMatch(
      /const serverPriceCents = effectivePricing\.find\(\s*\(row\) => row\.tier === parsed\.data\.product,\s*\)\?\.monthlyCents;/,
    );
    // Must NOT read the constant directly for the charge (the bug we're guarding
    // against): no `TIER_PRICE_CENTS[` index expression in the handler path.
    expect(body).not.toMatch(/serverPriceCents = TIER_PRICE_CENTS\[/);
  });

  it('CreateCryptoCheckoutSchema: zod enum product + price_cents int positive max 1_000_000 + price_currency 3-letter uppercase ISO regex. 2026-05-21 — V-666.SEC inserted explanatory comments between fields; pin matched on each line independently so the comments are admitted.', () => {
    // schema declaration + product field
    expect(body).toMatch(
      /const CreateCryptoCheckoutSchema = z\.object\(\{\s*product: z\.enum\(SUPPORTED_PRODUCTS\),/,
    );
    // price_cents field (still in schema; ignored at the handler)
    expect(body).toMatch(/price_cents: z\.number\(\)\.int\(\)\.positive\(\)\.max\(1_000_000\),/);
    // price_currency 3-letter uppercase ISO regex
    expect(body).toMatch(
      /price_currency: z\s*\.string\(\)\s*\.length\(3\)\s*\.regex\(\/\^\[A-Z\]\{3\}\$\/, 'price_currency must be a 3-letter uppercase ISO code'\),/,
    );
  });

  it("newOrderId: ord_ prefix + randomBytes(6).toString('hex') = 12 hex chars; banner-fit rationale", () => {
    expect(body).toMatch(
      /\* Generate a public order id\. 12 random hex chars is enough entropy\s*\*\s*for the in-memory store \+ the customer-facing URL while staying\s*\*\s*short enough to fit on a checkout page banner without wrapping\./,
    );
    expect(body).toMatch(
      /function newOrderId\(\): string \{\s*return `ord_\$\{randomBytes\(6\)\.toString\('hex'\)\}`;/,
    );
  });

  it('IdempotencyHeader discriminated union: absent | valid (trimmed <=255 ASCII printable [\\x21-\\x7e]) | invalid — extracted to shared lib/idempotency-key.ts. billing-crypto imports readIdempotencyKey from there.', () => {
    // Route imports the shared helper.
    expect(body).toMatch(/import \{ readIdempotencyKey \} from '\.\.\/lib\/idempotency-key\.js';/);

    // Type + parser live on the lib file.
    const libPath = resolve(REPO_ROOT, 'apps/server/src/lib/idempotency-key.ts');
    const lib = readFileSync(libPath, 'utf8');
    expect(lib).toMatch(
      /export type IdempotencyHeader =[\s\S]*?\| \{ kind: 'absent' \}[\s\S]*?\| \{ kind: 'valid'; key: string \}[\s\S]*?\| \{ kind: 'invalid' \};/,
    );
    expect(lib).toMatch(
      /export function readIdempotencyKey\(req: FastifyRequest\): IdempotencyHeader \{\s*const raw = req\.headers\['idempotency-key'\];/,
    );
    expect(lib).toMatch(/if \(trimmed\.length > 255\) return \{ kind: 'invalid' \};/);
    expect(lib).toMatch(
      /if \(!\/\^\[\\x21-\\x7e\]\+\$\/\.test\(trimmed\)\) return \{ kind: 'invalid' \};/,
    );
  });

  it('Idempotency invalid → 400 ValidationError "Idempotency-Key must be 1-255 ASCII chars (no whitespace)."', () => {
    expect(body).toMatch(
      /if \(idempotency\.kind === 'invalid'\) \{\s*throw new ValidationError\(\{\s*fieldErrors: \{\},\s*formErrors: \['Idempotency-Key must be 1-255 ASCII chars \(no whitespace\)\.'\],\s*\}\);/,
    );
  });

  it('Service dispatch branch: idempotency valid → createIdempotent (idempotency_key + bodyFingerprintMismatch return); else → create (fresh). 2026-05-21 — V-666.SEC: service receives serverPriceCents + serverPriceCurrency (authoritative, from PricingService.listEffective() as of pricing-as-data Phase A 2c), NOT parsed.data.price_cents/currency (client-supplied values are ignored to prevent price tampering).', () => {
    expect(body).toMatch(
      /if \(idempotency\.kind === 'valid'\) \{\s*const result = await deps\.service\.createIdempotent\(\{\s*idempotency_key: idempotency\.key,\s*order_id: newOrderId\(\),\s*account_id: ctx\.account\.id,\s*product: parsed\.data\.product,\s*price_cents: serverPriceCents,\s*price_currency: serverPriceCurrency,\s*\}\);\s*order = result\.order;\s*replayed = result\.replayed;\s*bodyFingerprintMismatch = result\.bodyFingerprintMismatch;/,
    );
    expect(body).toMatch(
      /\} else \{\s*order = await deps\.service\.create\(\{\s*order_id: newOrderId\(\),\s*account_id: ctx\.account\.id,\s*product: parsed\.data\.product,\s*price_cents: serverPriceCents,\s*price_currency: serverPriceCurrency,\s*\}\);/,
    );
  });

  it("Reply 201: order_id + product + price + status + provider (nowpayments | stub) + payment_address + pay_currency + pay_amount + created_at ISO. 2026-05-21 — V-666.D landed: route now calls NowPaymentsApiClient.createPayment when wired and returns the real pay_address; falls through to the stub posture (provider:'stub' + null fields) when the client is undefined OR the upstream call throws.", () => {
    expect(body).toMatch(
      /return reply\.code\(201\)\.send\(\{\s*order_id: order\.order_id,\s*product: order\.product,\s*price_cents: order\.price_cents,\s*price_currency: order\.price_currency,\s*status: order\.status,/,
    );
    // Stub-vs-real branch: both providers reachable.
    expect(body).toMatch(/let provider: 'stub' \| 'nowpayments' = 'stub';/);
    expect(body).toMatch(/let paymentAddress: string \| null = null;/);
    expect(body).toMatch(/let payCurrency: string \| null = null;/);
    expect(body).toMatch(/let payAmount: number \| null = null;/);
    // Real-mint path: NowPayments client + IPN callback URL gate +
    // min-amount floor (2026-05-21 V-666.SEC short-circuit to avoid
    // amount_too_low errors when serverPriceCents < $20).
    expect(body).toMatch(/deps\.nowpayments !== undefined &&/);
    expect(body).toMatch(/deps\.nowpaymentsIpnCallbackUrl !== undefined &&/);
    expect(body).toMatch(/serverPriceCents >= NOWPAYMENTS_MIN_USD_CENTS/);
    expect(body).toMatch(/payment = await deps\.nowpayments\.createPayment\(\{/);
    expect(body).toMatch(/provider = 'nowpayments';/);
    expect(body).toMatch(/created_at: new Date\(order\.created_at\)\.toISOString\(\),/);
  });

  it('provider mint admission is explicit: fresh or pending-unbound only; every non-pending replay remains addressless', () => {
    expect(body).toMatch(
      /const mayMintPayment =\s*!replayed \|\| \(order\.status === 'pending' && order\.payment_id === null\);/,
    );
    expect(body).toMatch(/serverPriceCents >= NOWPAYMENTS_MIN_USD_CENTS &&\s*mayMintPayment/);
    expect(body).toMatch(
      /Every other replay state is non-minting: confirming\/partial already has/,
    );
    expect(
      body.replace(
        /serverPriceCents >= NOWPAYMENTS_MIN_USD_CENTS &&\s*mayMintPayment/,
        'serverPriceCents >= NOWPAYMENTS_MIN_USD_CENTS',
      ),
    ).not.toMatch(/serverPriceCents >= NOWPAYMENTS_MIN_USD_CENTS &&\s*mayMintPayment/);
  });

  it('fails acting-as checkout closed before body, pricing, order, or provider work', () => {
    // The header NAME now comes from the shared EFFECTIVE_ACCOUNT_HEADER
    // constant so this rejection cannot drift from the name the membership
    // resolver parses; the load-bearing property here is unchanged ordering —
    // the guard still runs before body parse, pricing and order creation.
    const headerGuard = body.indexOf(
      'const rawActAsAccount = req.headers[EFFECTIVE_ACCOUNT_HEADER]',
    );
    const bodyParse = body.indexOf('CreateCryptoCheckoutSchema.safeParse(req.body)');
    const pricingRead = body.indexOf('await deps.pricing.listEffective()');
    const orderCreate = body.indexOf('await deps.service.createIdempotent');
    expect(body).toMatch(
      /import \{ EFFECTIVE_ACCOUNT_HEADER \} from '\.\.\/lib\/effective-account-header\.js';/,
    );
    expect(headerGuard).toBeGreaterThan(-1);
    expect(headerGuard).toBeLessThan(bodyParse);
    expect(headerGuard).toBeLessThan(pricingRead);
    expect(headerGuard).toBeLessThan(orderCreate);
    expect(body).toContain('Crypto checkout is available only in the Self workspace.');
  });

  it('never exposes a provider address before the exact payment is durably bound', () => {
    expect(body).toContain('nowpayments_payment_not_safely_bound');
    expect(body).toContain(
      'minted NowPayments payment is not safely bound and will not be exposed',
    );
    expect(body).toMatch(
      /boundOrder\.payment_id === payment\.paymentId[\s\S]*boundOrder\.status === 'pending'[\s\S]*mapNowpaymentsStatus\(payment\.paymentStatus\) === 'pending'/,
    );
  });

  it("Auth posture (W496): requireAuth + requireScope('admin:billing') + rateLimit('global') — checkout is a subscription-change action; account_owner satisfies admin:billing (V-481) so the dashboard works, a read/write-only key is blocked", () => {
    expect(body).toMatch(
      /\{ preHandler: \[app\.requireAuth, app\.requireScope\('admin:billing'\), app\.rateLimit\('global'\)\] \},/,
    );
  });

  it('imports: FastifyInstance/FastifyRequest + zod + randomBytes from node:crypto + CryptoOrdersService + ValidationError', () => {
    expect(body).toMatch(/import type \{ FastifyInstance, FastifyRequest \} from 'fastify';/);
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(/import \{ randomBytes \} from 'node:crypto';/);
    expect(body).toMatch(
      /import type \{ CryptoOrdersService \} from '\.\.\/services\/crypto-orders\.js';/,
    );
    expect(body).toMatch(
      /import \{ BadRequestError, FeatureUnavailableError, ValidationError \} from '\.\.\/lib\/errors\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
