# Stripe webhook testing — staging + production verification

V-197 — operational procedures for verifying Stripe webhook delivery
end-to-end on staging and (post-launch) production. Pairs with the
reference-vector unit tests in
`apps/server/tests/unit/stripe-signing-reference-vectors.test.ts` —
those confirm the algorithm is correct in-process; the procedures
below confirm the wire is correct between Stripe and our endpoint.

## What's already covered automatically

- **Algorithm correctness** — `verifyStripeSignature` is tested against
  HMAC-SHA256 reference vectors computed by `openssl dgst -sha256
-hmac`. If our impl drifts from Stripe's algorithm, those tests fail
  loud.
- **Failure modes** — missing header, invalid signature, wrong secret,
  malformed header, timestamp outside tolerance window all return
  401 with the reason captured in the error body. Covered in
  `apps/server/tests/integration/stripe-webhooks.test.ts`.
- **Idempotency** — duplicate `event.id` returns 200 with
  `outcome=duplicate`; only the first is recorded. Covered in
  the same integration suite.
- **Concurrent delivery race** — two concurrent deliveries of the same
  event end with exactly one ledger row (V-085).
- **Dispatch** — subscription lifecycle + invoice payment events route
  to the right handler; unknown event types return
  `outcome=ignored`.

What the integration suite **does not** cover: actual wire delivery
from Stripe's network to our endpoint. The procedures below close
that gap.

## Local development — `stripe listen`

```bash
# Install the Stripe CLI once
brew install stripe/stripe-cli/stripe   # mac
# or follow https://stripe.com/docs/stripe-cli for other platforms

# Authenticate (test mode only — never use live keys here)
stripe login

# Forward webhook events to your local dev server
stripe listen --forward-to http://localhost:3000/v1/webhooks/stripe

# The CLI prints the signing secret on first connect:
#   > Ready! Your webhook signing secret is whsec_xxxxxxxx
# Set this in your .env as STRIPE_WEBHOOK_SECRET, restart server.
# (The env var is STRIPE_WEBHOOK_SECRET even though Stripe's UI and the
#  server's internal dep are both named "signing secret" — setting
#  STRIPE_WEBHOOK_SIGNING_SECRET leaves the endpoint UNREGISTERED, so
#  Stripe's deliveries 404 and no subscription event is ever processed.)

# In a second terminal, trigger test events:
stripe trigger customer.subscription.created
stripe trigger invoice.paid
stripe trigger invoice.payment_failed
stripe trigger customer.subscription.deleted
```

Verify against your local server log:

- 200 for known event types, 200 with `outcome=ignored` for unknown.
- The `processed_stripe_events` table gets one row per unique
  `event.id`.
- Duplicate triggers (run `stripe trigger` twice for the same type,
  or `stripe events resend <event_id>`) result in
  `outcome=duplicate` on the second hit.

## Staging environment

Once staging has a Hetzner host + a real public URL:

1. Create a **test-mode** webhook endpoint in the Stripe Dashboard
   pointed at `https://staging.driftstack.dev/v1/webhooks/stripe`.
2. Copy the signing secret. SSH into the staging host and write it
   to the staging .env (`STRIPE_WEBHOOK_SECRET=whsec_...`)
   per the locked stripe-credential-handling memory — never paste
   webhook secrets into chat or PR diffs.
3. Restart the staging server.
4. From the Stripe Dashboard → Developers → Webhooks → select the
   staging endpoint → "Send test webhook" for each event type we
   handle.
5. Validate the response body shows `outcome=processed` and the
   `processed_stripe_events` table has the corresponding row.

## Production cutover

After commercial activation (entity registered + KvK + BV in place):

1. **Live-mode** webhook endpoint in the Stripe Dashboard pointed at
   `https://api.driftstack.dev/v1/webhooks/stripe`.
2. Live-mode signing secret goes via SSH-write to the prod .env per
   the stripe-credential-handling memory (live keys NEVER through
   chat or PR).
3. **Before** enabling the endpoint, send a test webhook from the
   Dashboard's "Send test webhook" UI. Confirm 200 + ledger row
   before flipping the endpoint to `enabled` in Stripe.
4. After the first real customer event lands, double-check:
   - response body `outcome=processed`
   - `processed_stripe_events` row recorded
   - subscription / invoice mutation reflected in our DB
   - audit row written if customer-state changed (suspend, tier
     change, etc. — see admin audit log)

## Replay procedures

If a webhook delivery fails (Stripe Dashboard shows non-2xx response):

1. Check Pino logs for the request id of the failed delivery.
2. If transient (network blip / our server briefly down), Stripe
   auto-retries with exponential backoff for ~3 days.
3. To force-replay manually: Stripe Dashboard → event detail →
   "Resend webhook". Our endpoint returns `outcome=duplicate` if the
   first delivery did get recorded; replay only mutates state if it
   was the first successful processing.

## Failure-mode rotation

If the signing secret leaks (or is suspected compromised):

1. **Rotate in the Stripe Dashboard first**: Webhooks → endpoint →
   "Roll signing secret". This invalidates the old secret instantly;
   any in-flight retries from Stripe with the old secret will be
   rejected by our verifier.
2. SSH-write the new secret to the prod .env.
3. Restart the server (or send SIGHUP if hot-reload is wired).
4. Audit the period the old secret was live for any unauthorized
   webhook deliveries (they'd've failed sig check, but log + count
   `invalid_signature` reasons).

## Standing observability

- Log line per webhook delivery: `verifyStripeSignature` reason
  emitted on every 401. Set up a Sentry alert for sustained
  `invalid_signature` (would indicate either a misconfigured Stripe
  endpoint or active probing).
- `/v1/admin/audit-log?action=stripe_webhook.processed` (when this
  audit action exists — currently webhook ledger is the source of
  truth, not the admin audit log).
- Stripe Dashboard → Webhooks → endpoint → recent deliveries shows
  Stripe-side request/response history including their auto-retries.

## Related

- Algorithm reference: `apps/server/src/lib/stripe-signing.ts`
- Verification middleware: `apps/server/src/routes/webhooks-stripe.ts`
- Idempotency ledger: `processed_stripe_events` table
  (migration `0008_processed_stripe_events.sql`)
- Reference-vector tests:
  `apps/server/tests/unit/stripe-signing-reference-vectors.test.ts`
- Wire-shape tests:
  `apps/server/tests/integration/stripe-webhooks.test.ts`
- Dispatch tests:
  `apps/server/tests/integration/stripe-webhooks-mutations.test.ts`
