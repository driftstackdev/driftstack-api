-- V-298a — readable account handle. Lowercase a-z + 0-9 + hyphen,
-- 3-32 chars. Unique-when-set; null is distinct (Postgres default).
ALTER TABLE "accounts" ADD COLUMN "slug" text;
CREATE UNIQUE INDEX "accounts_slug_unique" ON "accounts" ("slug");
