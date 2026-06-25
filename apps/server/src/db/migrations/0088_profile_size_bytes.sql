-- 2026-06-24 — per-profile sealed-store size surface (doc-150 item 5). The
-- harness emits a `size_bytes` on the `profileSaved` frame at save-back; the
-- control plane persists it (plus the save-back time) on the profile row so the
-- dashboard can show per-profile storage + an account-wide total. The 1GB/5GB
-- quota enforcement is doc-150 item 6 — this slice only surfaces the numbers.
--
-- size_bytes is BIGINT: a sealed store (LZFSE + AES-GCM-256, opaque to the
-- server) can exceed the 2^31 int ceiling. last_saved_at = the time the harness
-- last saved this profile's sealed store back. Both nullable + additive +
-- idempotent — existing rows need no backfill (NULL = never saved / pre-column /
-- a harness that didn't emit the field).
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "size_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "last_saved_at" timestamp with time zone;
