# Crypto payment-path security audit (2026-06-03, Agent-2)

Consolidated security review of the NowPayments crypto rail across three autopilot waves.
The rail is **dormant in production** (the IPN route registers only when `NOWPAYMENTS_IPN_SECRET`
is configured; no merchant account yet), so these are **pre-launch** findings. Scope: the customer
checkout + orders surface, the admin orders surface, and the IPN signature verifier.

## Verdict: clean, with one pre-launch item to confirm

The crypto money path is well-built and security-conscious. No exploitable defect was found. One
correctness risk (below) should be confirmed against a real NowPayments IPN before the rail is enabled.

## What was checked

### Customer surface — `routes/billing-crypto-orders.ts` + `routes/billing-crypto.ts`

- **IDOR / account-scoping (CLEAN):** every customer route is account-scoped. The detail GET loads via
  the unscoped `getById` then enforces `order.account_id === ctx.account.id`, returning **404 (not 403)**
  on a mismatch so order existence isn't leaked across accounts. List, PATCH-note, cancel, and all
  receipt variants pass `account_id: ctx.account.id` to the service (scoped at the service layer).
- **Price tampering (CLEAN — explicitly hardened):** `billing-crypto.ts` ignores client-supplied
  `price_cents` and looks the price up from the server-side `TIER_PRICE_CENTS` map keyed by the
  zod-enum'd product slug. A client/server price mismatch is logged
  (`crypto_checkout_price_override_attempt`) and the client value discarded. The header documents the
  prior vuln (a `{product:'api_scale', price_cents:100}` $1-charge) and its fix.
- **Content-type / XSS (CLEAN):** `receipt.txt` is served `text/plain; charset=utf-8`; `receipt.pdf` is
  `application/pdf` + `attachment`. The receipt payload does not include the customer-controlled
  `customer_note`, so there is no reflected-markup vector.
- **Input validation (CLEAN):** order ids length-capped; `customer_note` ≤500; `created_after/before`
  validated as `z.string().datetime()` (no NaN window); inverted-window guard; `limit` 1–100.
- **Caching (CLEAN):** list + detail set `cache-control: no-store, private` so mid-checkout status
  flips (pending→confirming→paid) are never served stale.
- **Header accuracy (CLEAN):** the route header enumerates all 7 routes correctly.

### Admin surface — `routes/admin-crypto-orders.ts` (audited a prior wave)

- All 11 routes scope-gated (`driftstack_internal_admin`) + rate-limited + zod-validated + capped.
- Aggregations sound; **FIXED** a daily-breakdown UTC-window misalignment (commit `b70366ea`) and the
  misleading "Read-only / 9-route" file header (commit `5e315eb7`).
- CSV export uses the shared `lib/csv.ts` formula-injection guard (CWE-1236) — sound.

### IPN signature verifier — `lib/nowpayments-signing.ts` (audited a prior wave)

- HMAC-SHA512, `timingSafeEqual`, digest-length guard before compare, recursive key-canonicalisation,
  false-on-malformed. The receiver requires the signature, captures the raw body, rejects malformed
  events, and forwards into the forward-only/idempotent order state machine (replay handled there;
  amount delegated to `payment_status` by design).
- **FIXED** a contradictory/stale verifier header (commit `1f1425cd`).

## Open item to confirm before enabling the rail (SURFACED — not auto-changed; money-critical)

The verifier canonicalises by **re-serialising** (`JSON.stringify(sortKeys(JSON.parse(body)))`) before
HMAC. This re-encodes numbers via the JS serialiser. NowPayments signs with PHP `json_encode`, which can
emit float fields (`price_amount`, `actually_paid`) with **different bytes** (trailing-zero / precision /
scientific-notation edge cases). If the two serialisations diverge for a given payload, a **valid IPN
would fail verification → the order stays pending → a real payment is silently dropped**.

Recommended action before turning the rail on:

1. Capture a real NowPayments IPN (sandbox) and confirm `verifyNowpaymentsSignature` accepts it.
2. If it rejects, verify the signature against **both** the raw body and the canonical form and accept
   either — this is additive and secret-gated (no security loss), and removes the serialisation
   dependency.

No code change is made here: changing money-path verification semantics without a real-IPN fixture is a
founder/integration-test decision.
