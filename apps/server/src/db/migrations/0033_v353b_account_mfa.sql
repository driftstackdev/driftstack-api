-- V-353b — MFA (TOTP) enrollment + recovery codes + web-session
-- mfa_satisfied_at marker.

-- Web session step-up freshness marker.
ALTER TABLE "web_sessions"
  ADD COLUMN "mfa_satisfied_at" timestamp with time zone;

-- TOTP enrollment row per account (absent = not enrolled).
CREATE TABLE "account_mfa" (
  "account_id" uuid PRIMARY KEY REFERENCES "accounts"("id") ON DELETE CASCADE,
  "totp_secret_ciphertext" text NOT NULL,
  "totp_secret_iv" text NOT NULL,
  "totp_secret_tag" text NOT NULL,
  "enrolled_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Recovery codes (10 per enrollment / regen; single-use).
CREATE TABLE "account_mfa_recovery_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "code_hash" text NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "account_mfa_recovery_codes_account_idx"
  ON "account_mfa_recovery_codes" ("account_id");
