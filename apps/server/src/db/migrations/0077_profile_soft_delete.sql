-- 2026-06-16 — L4b recycle bin (profile soft delete). Adds a nullable
-- deleted_at marker (NULL = live profile; non-NULL = trashed: hidden from
-- list/cap/lookup, restorable, hard-purged later by the retention job). The
-- wrapped DEK stays at rest while trashed; restore re-exposes it, purge
-- deletes the row. All repo read paths filter `deleted_at IS NULL`.
--
-- The name-uniqueness index becomes PARTIAL (only live profiles reserve a
-- name) so trashing "shopper" frees the name for a new profile while the
-- trashed row keeps its own copy. Additive + idempotent.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
--> statement-breakpoint
DROP INDEX IF EXISTS "profiles_account_name_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_account_name_unique" ON "profiles" USING btree ("account_id","name") WHERE "deleted_at" IS NULL;
