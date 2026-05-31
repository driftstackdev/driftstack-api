# 2026-05-31 — Crypto (NOWPayments) IPN → order state machine: VERIFIED CLEAN (Agent 2)

Fresh audit of the money-path crypto-order IPN handling — untrusted external input
(the NOWPayments IPN) driving an order state machine that grants paid product/tier.
A distinct dimension from the prior crypto memories (sweepExpiredOrders order;
webhook signature verification). **No bug found — the state machine is sound.** Do
NOT re-audit.

## What was checked (the real crypto-IPN bug classes)

- **Underpayment accepted as paid?** No. `mapNowpaymentsStatus`
  (`crypto-orders.ts`) maps `partially_paid → 'partial'` (a distinct, non-granting
  state), `confirming`/`sending → 'confirming'`, and ONLY `finished → 'paid'`.
  `waiting → 'pending'`; `failed`/`expired`/`refunded → 'failed'`; unknown → `null`
  (caller leaves state alone). Conservative — a partial/confirming payment never
  unlocks goods.
- **Double-grant on re-delivered IPN?** No. `applyIpnStatus` fires
  `crypto.order.paid` (+ the paid-receipt email) ONLY on the transition
  `order.status !== 'paid' && mapped === 'paid'`. A re-delivered `finished` IPN on an
  already-`paid` order touches `updated_at` but re-fires nothing. The failed-event is
  guarded the same way (`order.status !== 'failed' && mapped === 'failed'`).
- **Out-of-order / stale IPN downgrade?** No. `isTerminalForward(current, next)`
  gates every transition: terminal states (`paid`/`failed`/`cancelled`) never move
  ("a late IPN payment cannot revive an abandoned order"); `partial` only advances to
  `paid`/`failed`; `pending`/`confirming` can't regress to `pending`. So a stale
  `confirming` arriving after `finished` is a no-op — no un-granting.
- **Unknown provider status:** `mapNowpaymentsStatus` returns `null` →
  `applyIpnStatus` leaves the order state untouched (records the `payment_id` only).
- **payment_id capture:** recorded even on a no-op transition (so reconciliation has
  it). Best-effort event/email emission is wrapped in try/catch so the IPN still
  ACKs 200 (NOWPayments won't hammer retries on our emitter hiccup).

Amount validation is intentionally delegated to NOWPayments' own `payment_status`
(the standard integration pattern — `finished` is emitted only when fully paid); the
route forwards `payment_status`, not `actually_paid`, and trusts the provider's
status as source of truth. Signature verification of the IPN is covered separately
(payment-webhook-sigs clean).

## One deliberate design note (not a bug)

`paid` is terminal, so a provider `refunded` status arriving AFTER `finished` is a
no-op — the order stays `paid`. Refunds are handled out-of-band / manually rather than
auto-revoking a granted tier on a provider status (which could mis-fire or be abused).
Defensible; flagged only so it isn't mistaken for a missed transition.

Recorded in memory `project_crypto_ipn_state_machine_clean`.
