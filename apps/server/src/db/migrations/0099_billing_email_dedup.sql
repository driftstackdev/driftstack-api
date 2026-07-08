-- C6 — per-billing-email dedup ledger. The processed_stripe_events ledger
-- dedups a whole Stripe event, but it is written AFTER the handler's side
-- effects, so a crash between a billing email send and that ledger write — or
-- two concurrent Stripe deliveries of the same event (at-least-once) — could
-- send the same receipt / failure / renewal-reminder email twice. A
-- claim-before-send row keyed on (stripe_event_id, kind) makes each billing
-- email fire at most once (INSERT ... ON CONFLICT DO NOTHING; the winner sends).
CREATE TABLE "billing_email_sends" (
  "stripe_event_id" text NOT NULL,
  "kind" text NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE cascade,
  "claimed_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_email_sends_stripe_event_id_kind_pk" PRIMARY KEY ("stripe_event_id", "kind")
);
