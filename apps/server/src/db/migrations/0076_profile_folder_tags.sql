-- 2026-06-12 — profile organization metadata (folders + tags), the backend
-- half of the GUI's profiles-meta surface (apps/gui-client/src/lib/
-- profiles-meta.ts kept these client-side as the migration source; these
-- columns let organization sync across devices). Additive + idempotent:
-- nullable folder (NULL = unfiled) and a NOT NULL jsonb tags array
-- defaulting to '[]' so existing rows need no backfill. Caps (folder ≤32,
-- ≤12 unique tags ≤24 chars) are enforced at the api-types validation
-- layer, mirroring the GUI's own caps.
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "folder" text;
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "tags" jsonb NOT NULL DEFAULT '[]'::jsonb;
