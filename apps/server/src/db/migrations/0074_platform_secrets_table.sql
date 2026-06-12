-- 2026-06-12 — admin-cockpit secrets Phase A (founder-locked decision 3,
-- 2026-06-04): DB-backed platform secret store, encrypted at rest with the
-- BYOK blob pattern ([12 IV | 16 tag | N ct] AES-256-GCM under the shared
-- MFA_ENCRYPTION_KEY — same Q1-verdict reuse as accounts.byok_anthropic_
-- api_key_ciphertext). Owner-gated management routes + audit land in the
-- next slice; this is the storage layer. `name` is the stable slug PK
-- (e.g. 'stripe_secret_key'); ciphertext is never returned by list reads.
-- Hand-authored per the established migration workflow (snapshot frozen at
-- 0022; td-002 tracks reinstatement).
CREATE TABLE IF NOT EXISTS "platform_secrets" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text,
	"ciphertext" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_key_id" uuid
);
