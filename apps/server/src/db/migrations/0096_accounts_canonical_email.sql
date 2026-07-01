-- 2026-07-01 security fix (real fix — supersedes the signup-time-only
-- pre-check added 2026-06-30) — Gmail dot/+tag alias dedup needs to catch
-- BOTH registration orderings, not just "canonical form registered first,
-- variant second". The prior fix only re-canonicalized the INCOMING
-- signup email and looked it up against the literal accounts.email column,
-- so it silently missed the realistic abuse ordering: a variant registers
-- FIRST (e.g. attacker+1@gmail.com), then a second variant or the bare
-- address (attacker+2@gmail.com / attacker@gmail.com) signs up — both land
-- in the same real mailbox as "distinct" accounts, unblocked.
--
-- `canonical_email` stores the SAME canonicalizeEmailForDedup(email) value
-- (services/auth-flows.ts) computed at INSERT time for every account
-- (password signup + OAuth IDP signup), so signup's dedup check becomes a
-- single lookup against this column — race-free via the unique index
-- below, mirroring how accounts_email_unique already backs the literal-
-- email uniqueness guarantee — regardless of which literal variant was
-- stored first.
--
-- Column is nullable (NOT a blocking NOT NULL migration): a couple of
-- narrow dev/test-only direct-insert paths (src/db/seed.ts's local dev
-- seed; tests/e2e/helpers/seed.ts's e2e account fixture) create `accounts`
-- rows without going through AuthFlowsRepo.createAccount, so they never
-- populate this column — those rows simply opt out of canonical-email
-- dedup (harmless: they aren't customer signups). Every REAL account-
-- creation path (password signup + OAuth IDP signup) always sets it, via
-- AuthFlowsRepo.createAccount. The unique index below follows the exact
-- "unique-when-set, NULLs are distinct" pattern accounts_slug_unique
-- (V-298a) already uses in this same table.
--
-- Backfill: existing rows predate this column, so it starts NULL for all
-- of them. The UPDATE below computes the same canonicalization in SQL.
-- It assumes (true for every INSERT/UPDATE path in this codebase, and
-- enforced by the zod .email() validator at signup) that accounts.email
-- is already trim+lowercased and contains exactly one '@'. Idempotent /
-- safe to re-run: the WHERE clause only touches NULL rows, and re-running
-- recomputes the identical value for any row it touches. This backfill
-- doesn't need to DETECT new duplicates among historical rows (existing
-- accounts' literal emails already predate any alias-variant duplicate,
-- since canonical-form dedup didn't exist before this migration); it only
-- needs the column populated so FUTURE signups' lookups against existing
-- rows work correctly.
--
-- Risk note for whoever deploys this: existing accounts' LITERAL emails
-- are already unique (accounts_email_unique predates this fix), but
-- nothing before today enforced canonical-form uniqueness, so it is
-- theoretically possible for two PRE-EXISTING accounts to already be
-- Gmail dot/+tag variants of each other (e.g. both attacker@gmail.com and
-- attacker+1@gmail.com already registered before this migration ships).
-- If so, the CREATE UNIQUE INDEX below will fail and this migration will
-- NOT commit (this file runs as a single transaction; the deploy
-- pipeline's post-migration row-count check + auto-revert in
-- db/migrate.ts covers this failure mode — the app never boots on a
-- half-applied schema). A human should reconcile any such existing
-- duplicate accounts before this migration can land; this was NOT
-- verified against production data as part of this change.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "canonical_email" text;

UPDATE "accounts"
SET "canonical_email" =
  CASE
    WHEN split_part(email, '@', 2) IN ('gmail.com', 'googlemail.com')
      THEN replace(split_part(split_part(email, '@', 1), '+', 1), '.', '') || '@' || split_part(email, '@', 2)
    ELSE split_part(split_part(email, '@', 1), '+', 1) || '@' || split_part(email, '@', 2)
  END
WHERE "canonical_email" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "accounts_canonical_email_unique" ON "accounts" ("canonical_email");
