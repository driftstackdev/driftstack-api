-- 2026-08-25 (V-1611 #14) — a team becomes a THING, not an account id.
--
-- Until now there is no `teams` table. A "team" is implicitly an account with
-- other accounts pointing at it: `team_members.owner_account_id` and
-- `team_invites.owner_account_id` both reference `accounts`. Two consequences
-- the customer actually sees:
--
--   * the workspace switcher renders "Team 3f9a2c1d · admin", because the
--     payload carries an owner account id and there is no name to show.
--     Sidebar.tsx's own comment says so: "no team name yet ... a friendlier
--     team name is a follow-up once the API surfaces one"
--   * one owner can never have two teams, because the owner IS the team
--
-- EXPAND ONLY. This adds and backfills; it drops nothing and makes nothing NOT
-- NULL. `owner_account_id` stays on both child tables and stays authoritative,
-- so every existing reader keeps working untouched and this is reversible by
-- dropping what it added. The contract phase — team_id NOT NULL,
-- owner_account_id dropped — is a separate migration once every reader has
-- moved, and must not be folded into this one.
--
-- SLUG IS NULLABLE, mirroring `accounts_slug_unique` exactly. That column is
-- nullable-unique-when-set and its comment records why: whether slugs become
-- public URL components is an open product decision. Minting required team
-- slugs here would quietly settle it. Unique when present, absent by default.
CREATE TABLE IF NOT EXISTS "teams" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "slug" text,
  "owner_account_id" uuid NOT NULL REFERENCES "accounts" ("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Nullable-unique-when-set, the accounts_slug_unique pattern.
CREATE UNIQUE INDEX IF NOT EXISTS "teams_slug_unique" ON "teams" ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "teams_owner_idx" ON "teams" ("owner_account_id");
--> statement-breakpoint
-- BACKFILL: one team per account that already owns a membership or an invite.
--
-- Named from the account, with a deterministic ladder so the result does not
-- depend on which rows happen to be present: the account's own name, else the
-- local part of its email, else a short id. NEVER the bare uuid alone — that is
-- the string the customer is already complaining about.
--
-- Scoped to accounts that actually own team rows. An account on a team-capable
-- tier with no members has nothing to migrate, and minting an empty team for it
-- would invent state the customer never created.
INSERT INTO "teams" ("owner_account_id", "name")
SELECT
  a."id",
  COALESCE(
    NULLIF(BTRIM(a."name"), ''),
    NULLIF(SPLIT_PART(a."email", '@', 1), ''),
    'Team ' || LEFT(a."id"::text, 8)
  )
FROM "accounts" a
WHERE (
        EXISTS (SELECT 1 FROM "team_members" tm WHERE tm."owner_account_id" = a."id")
     OR EXISTS (SELECT 1 FROM "team_invites" ti WHERE ti."owner_account_id" = a."id")
      )
  -- ⛔ IDEMPOTENCE. Without this, re-running the backfill mints a SECOND team
  -- for every owner: there is deliberately no unique constraint on
  -- `owner_account_id`, because "one owner can never have two teams" is the bug
  -- this migration exists to fix. Verified by running the INSERT twice against a
  -- seeded database — 3 teams became 6. Drizzle records applied migrations so it
  -- would not normally re-run, but a migration that fails midway is re-applied
  -- from the top, and every other statement in this file is already IF NOT
  -- EXISTS. This is the one that was not.
  AND NOT EXISTS (SELECT 1 FROM "teams" t WHERE t."owner_account_id" = a."id");
--> statement-breakpoint
-- The forward pointers. Nullable and NOT yet authoritative: `owner_account_id`
-- remains the source of truth until the contract migration.
ALTER TABLE "team_members"
  ADD COLUMN IF NOT EXISTS "team_id" uuid REFERENCES "teams" ("id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "team_invites"
  ADD COLUMN IF NOT EXISTS "team_id" uuid REFERENCES "teams" ("id") ON DELETE CASCADE;
--> statement-breakpoint
UPDATE "team_members" tm
   SET "team_id" = t."id"
  FROM "teams" t
 WHERE t."owner_account_id" = tm."owner_account_id"
   AND tm."team_id" IS NULL;
--> statement-breakpoint
UPDATE "team_invites" ti
   SET "team_id" = t."id"
  FROM "teams" t
 WHERE t."owner_account_id" = ti."owner_account_id"
   AND ti."team_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_members_team_idx" ON "team_members" ("team_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_invites_team_idx" ON "team_invites" ("team_id");
