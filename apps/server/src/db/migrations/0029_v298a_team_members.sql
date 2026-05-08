-- V-298a — Team RBAC v1, schema-only.
--
-- Two tables + one enum. No service / route / auth-path integration in
-- this slice; the schema lands first so V-298b/c/d can build against
-- a stable shape.
--
--   team_members  — confirmed membership; (owner, member) unique
--   team_invites  — pending double-opt-in invites; token-hashed at rest

CREATE TYPE "public"."team_role" AS ENUM ('member', 'admin');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "team_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "member_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "role" "team_role" NOT NULL DEFAULT 'member',
  "invited_at" timestamp with time zone NOT NULL,
  "accepted_at" timestamp with time zone NOT NULL,
  "invited_by_account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "team_members_owner_member_unique"
  ON "team_members" ("owner_account_id", "member_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_members_member_idx"
  ON "team_members" ("member_account_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "team_invites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_account_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "invitee_email" text NOT NULL,
  "role" "team_role" NOT NULL DEFAULT 'member',
  "invite_token_hash" text NOT NULL,
  "invite_expires_at" timestamp with time zone NOT NULL,
  "invited_by_account_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL,
  "accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "team_invites_token_idx"
  ON "team_invites" ("invite_token_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_invites_owner_idx"
  ON "team_invites" ("owner_account_id", "accepted_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_invites_email_idx"
  ON "team_invites" ("invitee_email");
