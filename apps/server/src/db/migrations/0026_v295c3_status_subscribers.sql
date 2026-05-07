-- V-295c3 — public status-page email subscribers (double-opt-in).
--
-- Email is the natural unique key. confirm_token_hash + confirm_expires_at
-- gate the initial double-opt-in; unsubscribe_token_hash supports the
-- one-click unsubscribe link in every notification email.
--
-- Tokens are sha256 hex of the plaintext (V-070 auth-tokens.ts pattern).
-- The plaintext only ever appears inside the URL of the email body
-- and is never logged.

CREATE TABLE IF NOT EXISTS "status_subscribers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL UNIQUE,
  "confirm_token_hash" text,
  "confirm_expires_at" timestamp with time zone,
  "confirmed_at" timestamp with time zone,
  "unsubscribe_token_hash" text,
  "unsubscribed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "status_subscribers_confirmed_idx"
  ON "status_subscribers" ("confirmed_at", "unsubscribed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_subscribers_unsub_token_idx"
  ON "status_subscribers" ("unsubscribe_token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_subscribers_confirm_token_idx"
  ON "status_subscribers" ("confirm_token_hash");
