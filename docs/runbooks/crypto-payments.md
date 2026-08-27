# Crypto-payments operator runbook (V-675)

Operational reference for the V-666 family — NowPayments IPN
ingestion, the `CryptoOrdersService` order state machine,
the customer-facing `/v1/billing/crypto-checkout` route (V-666.C),
and the admin lookup routes (V-666.D).

Read this when:

- A customer reports "I sent the crypto payment but my account is
  still pending."
- A NowPayments IPN webhook returns 4xx in the logs.
- An order is stuck in `partial` or `confirming` longer than the
  asset's expected settle time (see `pricing/crypto`).
- The founder needs to issue a manual refund / credit for a
  failed-but-paid order.

## Posture at a glance

```
   customer dashboard
         │
         ▼
   POST /v1/billing/crypto-checkout  (V-666.C)
         │   creates CryptoOrder { status:'pending', provider:'stub' }
         ▼
   InMemoryCryptoOrdersRepo
         ▲
         │  applyIpnStatus(order_id, payment_id, provider_status)
         │
   POST /v1/webhooks/nowpayments  (V-666 + V-666.B)
         │
         └── HMAC-SHA512 signature verification gate
```

> **Persistence.** Orders live in the `crypto_orders` table and survive
> deploys and restarts. `CryptoOrdersService` takes `repo` as a
> REQUIRED constructor field and bootstrap passes
> `new DrizzleCryptoOrdersRepo(dbHandle)`, so no production path can
> run against an in-memory store. This is acceptable today because (a) we have no live merchant account
> wired, (b) the early-customer cadence is manual-handoff (founder
> reconciles each order in Stripe Dashboard / NowPayments dashboard
> separately). The V-666.E follow-up wires a `crypto_orders` table
> when live volume justifies it.

## Order lifecycle

| State        | Set by                                            | Next states                       |
| ------------ | ------------------------------------------------- | --------------------------------- |
| `pending`    | Initial state on `POST /crypto-checkout`          | confirming, partial, paid, failed |
| `confirming` | NowPayments IPN `confirming` / `sending`          | paid, failed, partial             |
| `partial`    | NowPayments IPN `partially_paid`                  | paid, failed (terminal otherwise) |
| `paid`       | NowPayments IPN `finished`                        | terminal                          |
| `failed`     | NowPayments IPN `failed` / `expired` / `refunded` | terminal                          |

The state machine is **forward-only**. Once an order reaches `paid`
or `failed` it cannot move back to a non-terminal state, even if
NowPayments retries an IPN (e.g. a delayed `confirming` IPN
arriving after the `finished` IPN — we ignore the late one).

## Triage workflow

### Customer reports "I sent crypto but my account is still pending"

1. Get the customer's `order_id` from their dashboard / support email.
2. Fetch the order via the admin route:

   curl -H "Authorization: Bearer <internal-admin-key>" \
    "$BASE_URL/v1/admin/crypto-orders/<order_id>"

3. Read `status`:
   - **`pending` + no `payment_id`** — NowPayments hasn't seen the
     payment yet. Confirm with the customer that they sent to the
     correct deposit address. If they did, ask for the transaction
     hash and confirm on a block explorer.
   - **`pending` + has `payment_id`** — NowPayments saw the
     payment but no status IPN has fired. Check the NowPayments
     dashboard for the payment_id; expected within seconds.
   - **`confirming`** — payment is mid-flight. Wait the expected
     settle time for that asset (see `pricing/crypto.astro` table).
   - **`partial`** — customer underpaid. Follow up with the customer
     about a top-up or refund.
   - **`failed`** — order expired or refunded. **First check whether
     money actually arrived**: search the logs for
     `ipn_settled_payment_dropped_on_terminal_order` with this
     `order_id` (V-743). The expiry sweep flips an order to `failed`
     on age alone, so a slow-settling payment can land after it. If
     that alarm fired, the customer HAS paid and the order will never
     grant. Either refund (see _Forcing a refund_) or grant the tier by
     hand via admin change-tier — the same remediation the
     `crypto_paid_tier_activation_failed` alarm names. Do NOT ask them
     to pay again. Only if no payment arrived should you
     open a new order for the customer to retry.

### Customer was charged an amount that doesn't match the published price

The quote and the charge both read `PricingService.listEffective()`, which serves
the DB pricing table with `TIER_MONTHLY_PRICE_CENTS` as the seed AND the fallback.
Two alarms say the fallback was used, which is the only way a charge can silently
disagree with an edited price (V-746):

- **`pricing_db_read_failed_serving_constants`** (error) — the pricing table read
  FAILED and seeded constants were served. If a price had been edited via
  `PATCH /v1/admin/owner/pricing/:tier`, every quote and charge during the outage
  used the PRE-EDIT amount. Cross-check the order's `price_cents` against the
  intended price for its `product` and refund the difference if the edit was a
  discount. Check DB health first — this alarm means the pricing table
  specifically was unreadable.
- **`pricing_rows_missing_serving_constants`** (warn, once per process) — the read
  succeeded but a priced tier has no row. Migration 0067 seeds every priced tier,
  so a gap means the table was never seeded (fresh environment) or lost rows.
  Re-run the migration; until then that tier charges its seeded constant.

**Editing a price is a TWO-step operation.** `PATCH /v1/admin/owner/pricing/:tier`
changes what checkout CHARGES. The advertised price is a static build artefact in
`apps/marketing-site/src/data/pricing.ts` with no link to the pricing table, so an
edit that is not mirrored there leaves the site advertising one price while
customers are charged another. Nothing detects this: the marketing-pricing drift
guard pins that file's own literals and has no view of the DB. After any price
edit, update `apps/marketing-site/src/data/pricing.ts` (and the `apps/docs`
pricing copy) and redeploy the marketing site.

Note the quote and the checkout are SEPARATE requests, each doing its own price
read. "Quote equals charge" means they read the same source, not that the amount is
frozen between them — there is no quote-binding token, so an owner edit in between
legitimately changes the charged amount.

### NowPayments IPN webhook is rejecting

Check the server logs for `nowpayments-webhooks` component entries:

- **`"x-nowpayments-sig header missing"`** — NowPayments retried
  without the signature header. Almost always indicates a misconfig
  in the NowPayments dashboard (wrong webhook URL or stripped
  headers by an intermediate proxy).
- **`"NowPayments IPN signature verification failed"`** — IPN
  secret mismatch. Compare the `NOWPAYMENTS_IPN_SECRET` env var
  against the value in the NowPayments dashboard; rotation in only
  one place is the usual cause.

  ⛔ A **second, different** cause produces this same log line, and
  comparing secrets will not find it. The verifier canonicalises the
  body before the HMAC — `JSON.stringify(sortKeys(JSON.parse(body)))`
  — while the security audit records that NowPayments signs using PHP
  `json_encode`, which can emit float fields (`price_amount`,
  `actually_paid`) as different bytes. When the two serialisations
  diverge for a payload, a **genuine IPN fails verification and a real
  payment is silently dropped** while the secrets match perfectly.

  **Distinguish before rotating anything.** Recompute the HMAC over the
  RAW body exactly as received, and separately over the canonical form.
  If the raw form verifies and the canonical form does not, this is the
  serialisation divergence, not a secret mismatch — do not rotate the
  secret, and escalate. Tracked as the open item in
  `docs/internal/2026-06-03-crypto-payment-path-security-audit.md`,
  which is to be confirmed against a real sandbox IPN before the rail
  is enabled.

- **`"NowPayments IPN is missing required fields"`** — schema drift.
  NowPayments shipped an IPN with no `payment_status` or no
  `payment_id`. Read the body in the log and decide whether to
  patch our parser or open a NowPayments support ticket.

### Order stuck in `confirming` longer than expected

1. Get the `payment_id` from the order.
2. Look up the transaction in the NowPayments dashboard
   (or via NowPayments API:
   `GET https://api.nowpayments.io/v1/payment/<payment_id>`).
3. If NowPayments shows the transaction confirmed but no
   `finished` IPN arrived, manually trigger an IPN resend from
   their dashboard, OR call `applyIpnStatus` directly via the
   admin tooling (V-666.E follow-up — not yet exposed as a route).

### Forcing a refund

Refunds are issued by the founder via the NowPayments dashboard,
not by Driftstack. The flow:

1. Founder issues the refund in NowPayments (asset + amount + the
   customer's forwarding address).
2. NowPayments fires a `refunded` IPN once the on-chain refund
   transaction confirms.
3. Our applyIpnStatus maps `refunded` → `failed`. The order moves
   to terminal `failed`.
4. If the customer needs to retry, mint a new order via the
   normal checkout flow.

Do NOT edit `crypto_orders` rows by hand — the order's terminal
state is the customer-visible truth, and the IPN flow will
overwrite manual changes.

## Failure modes

| Symptom                                         | Likely cause + action                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orders missing after a deploy                   | NOT expected — `crypto_orders` is a Postgres table and survives restarts. Query the table by `order_id` before assuming loss; if rows really are absent, that is a real incident, not the storage model.                                                                |
| Order shows `paid` but customer not upgraded    | The downstream tier-flip wiring (V-666.E) is not yet built — founder runs it manually until the wiring lands.                                                                                                                                                           |
| Duplicate `paid` IPN                            | Idempotent — service is no-op on same-state writes. No action needed.                                                                                                                                                                                                   |
| Late `confirming` IPN after `paid`              | Rejected by `isTerminalForward` — logged, no state change.                                                                                                                                                                                                              |
| Charge disagrees with an edited price           | `pricing_db_read_failed_serving_constants` / `pricing_rows_missing_serving_constants` (V-746) — the pricing-table read fell back to seeded constants, so an owner price edit was not reflected. See the triage section above.                                           |
| Settled payment on a `failed`/`cancelled` order | `ipn_settled_payment_dropped_on_terminal_order` (V-743). Real money arrived on a dead order; the anti-revival guard correctly refuses to apply it, so NO entitlement was granted and no revenue row exists. Refund or grant manually — this alarm always needs a human. |
| Customer signed up off-platform (no account)    | Order's `account_id` may be null. Admin list still shows it; founder maps to a customer account post-paid manually.                                                                                                                                                     |

## When the merchant account lands (V-666.E follow-up)

The current "wire-ready" posture flips to "live" when:

1. NowPayments merchant account is approved + API keys minted.
2. `NOWPAYMENTS_API_KEY` env var is set in production.
3. The `/v1/billing/crypto-checkout` route's stubbed
   `payment_address: null` response is replaced with a real
   NowPayments `POST /v1/payment` call before the order is returned
   to the customer.
4. The customer-facing crypto checkout flow is unblocked in the
   GUI (V-534.J button + view).
5. ~~A `crypto_orders` table replaces the in-memory repo (V-666.E
   DB migration).~~ **Done** — the table exists and bootstrap wires
   `DrizzleCryptoOrdersRepo`; this is no longer a prerequisite.

Until then: the route mints orders + accepts IPNs, but the
customer-visible payment-address flow is documented as "support
will reach out" in `apps/marketing-site/src/pages/pricing/crypto.astro`.

## Related runbooks

- [`incidents.md`](incidents.md) — if a crypto-payment failure is
  the trigger for an external customer-facing incident.
- [`../deployment/stripe-webhook-testing.md`](../deployment/stripe-webhook-testing.md)
  — for signature-rotation drills that apply to NowPayments too.
- [`cost-monitoring.md`](cost-monitoring.md) — when sub-processor
  cost is the actual concern (NowPayments takes a per-transaction
  fee that flows into V-541 cost monitoring).
