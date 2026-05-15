-- V-667.C — OAuth-CLIENT (sign-in-with-Google/GitHub) DB tables.
-- Per founder verdict 2026-05-15:
--   Verdict 1 (existing-email-collision): merge-with-verification —
--     oauth_pending_links carries a one-shot 60-min token sent to the
--     existing account's email; clicking the link merges the
--     IDP identity into the existing account.
--   Verdict 2 (IDP revocation): graceful fallback — last_revoked_at
--     on the active link, never auto-delete-account.
--   Verdict 3 (avatar/name sync): first-link-only, user-overridable
--     via accounts.avatar_source enum (NONE/IDP/USER).

-- ─── enum: where the avatar value came from ─────────────────────────
CREATE TYPE "account_avatar_source" AS ENUM ('none', 'idp', 'user');

ALTER TABLE "accounts"
  ADD COLUMN "avatar_source" "account_avatar_source" NOT NULL DEFAULT 'none';

-- ─── account_oauth_links — active identity-provider memberships ─────
-- (provider, provider_sub) uniquely identifies one IDP identity; the
-- pair maps 1:1 to a Driftstack account_id. An account may have
-- multiple links (one per provider). last_revoked_at marks links that
-- the user has revoked via the IDP console but not unlinked here;
-- next login attempts gracefully fall back to password per Verdict 2.
CREATE TABLE "account_oauth_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "provider_sub" text NOT NULL,
  "provider_email" text,
  "provider_name" text,
  "provider_avatar_url" text,
  "linked_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_login_at" timestamp with time zone,
  "last_revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- One (provider, provider_sub) can only map to one account.
CREATE UNIQUE INDEX "account_oauth_links_provider_sub_idx"
  ON "account_oauth_links" ("provider", "provider_sub");
-- Lookup-by-account for the profile-page "my linked accounts" list.
CREATE INDEX "account_oauth_links_account_idx"
  ON "account_oauth_links" ("account_id");

-- ─── oauth_pending_links — V-667.C Verdict-1 collision flow ────────
-- When an IDP login arrives for an email that already has a password
-- account, we insert a row here + email the existing account a
-- confirmation link. The user clicks the link → we consume the token
-- + insert the matching account_oauth_links row + delete this pending
-- row. Tokens are single-use + expire after 60 minutes.
CREATE TABLE "oauth_pending_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "provider_sub" text NOT NULL,
  "provider_email" text NOT NULL,
  "provider_name" text,
  "provider_avatar_url" text,
  -- sha256 hash of the plaintext token sent in the email link;
  -- plaintext is never stored. Same pattern as auth_flow_tokens.
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "oauth_pending_links_token_idx"
  ON "oauth_pending_links" ("token_hash");
CREATE INDEX "oauth_pending_links_account_idx"
  ON "oauth_pending_links" ("account_id");
CREATE INDEX "oauth_pending_links_expires_idx"
  ON "oauth_pending_links" ("expires_at");
