-- 2026-06-16 — ARC A slice 1: per-account customer proxy storage.
-- Customer proxies were client-only (the GUI's Tauri store). This table holds
-- them per ACCOUNT so a session can be dispatched through the customer's own
-- proxy (ARC A). The password is wrapped under the account TMK
-- (base64([iv|tag|ct]), see lib/profile-key-hierarchy.ts wrapAccountSecret) —
-- the plaintext is NEVER stored or returned over the API. NULL wrapped_password
-- = no password / inert (PROFILE_MASTER_KEY unset). host/port/username are not
-- secret. Additive + idempotent; no backfill needed (new table).
CREATE TABLE IF NOT EXISTS "account_proxies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "label" text NOT NULL,
  "scheme" text NOT NULL DEFAULT 'socks5',
  "host" text NOT NULL,
  "port" integer NOT NULL,
  "username" text,
  "wrapped_password" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "account_proxies_account_idx" ON "account_proxies" ("account_id");
