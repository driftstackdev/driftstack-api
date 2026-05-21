-- V-666 — crypto checkout orders backing table.
--
-- CryptoOrdersService upserts the full envelope per state transition;
-- the events[] array is stored as JSONB so a single getById returns
-- both the current state + complete history.
--
-- order_id is the customer-facing identifier (e.g. ord_a1b2c3d4e5f6)
-- minted at the route layer via randomBytes(6).toString('hex'); used
-- as the primary key + the NowPayments order_id field.
--
-- account_id is nullable to support pre-signup checkouts (V-666
-- anonymous flow: customer pays → server creates a pending order with
-- account_id=null → customer signs up → order is claimed by setting
-- account_id). FK constraint deferred until the claim flow lands.
--
-- status uses 6 values matching CryptoOrderStatus in the service:
-- pending / confirming / paid / failed / partial / cancelled.
-- CHECK constraint enforces the union at the DB.
--
-- events stores the append-only state-transition log
-- (CryptoOrderEvent[]) as JSONB so support can reconstruct an order's
-- history without grepping logs.

CREATE TABLE IF NOT EXISTS "crypto_orders" (
  "order_id" text PRIMARY KEY NOT NULL,
  "account_id" uuid,
  "product" text NOT NULL,
  "price_cents" integer NOT NULL,
  "price_currency" text NOT NULL,
  "payment_id" text,
  "status" text NOT NULL,
  "customer_note" text,
  "internal_note" text,
  "events" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "crypto_orders_status_check" CHECK (
    "status" IN ('pending', 'confirming', 'paid', 'failed', 'partial', 'cancelled')
  )
);

CREATE INDEX IF NOT EXISTS "crypto_orders_account_id_idx" ON "crypto_orders" ("account_id");
CREATE INDEX IF NOT EXISTS "crypto_orders_status_idx" ON "crypto_orders" ("status");
CREATE INDEX IF NOT EXISTS "crypto_orders_created_at_idx" ON "crypto_orders" ("created_at");
