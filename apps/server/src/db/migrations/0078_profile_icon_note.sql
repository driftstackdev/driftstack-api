-- 2026-06-16 — per-profile UI organization metadata (icon + note), the
-- server-side half so it syncs per ACCOUNT instead of living only in each
-- machine's local Tauri store (founder: "profiles/folders/tags might not be
-- per account, but per machine — should be account constants"). Folder + tags
-- already sync via 0076; this closes the icon + inline-note gap.
--
-- icon = a short emoji string (NULL/empty = use the monogram). note = a short
-- inline annotation, distinct from the longer `description` set at create.
-- Additive + idempotent; existing rows need no backfill (both nullable).
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "icon" text;
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "note" text;
