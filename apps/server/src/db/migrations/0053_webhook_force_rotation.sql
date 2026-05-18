-- Arc 3 sub-slice 28.1 (v2-#28 webhook secret server-initiated force-rotation).
--
-- Founder verdicts locked 2026-05-18:
--   Q1=B auto-rotate at 91 days (with grace) instead of block/audit-only
--   Q2=B 7-day grace window for the auto-rotation
--   Q3=B single rotation email + one 24h-before-expiry reminder
--   Q4=A no per-endpoint opt-out flag (TTL is a hard floor)
--
-- Two new columns on webhook_endpoints:
--
--   grace_window_ends_at TIMESTAMPTZ NULL
--     Distinct from the existing secret_prev_expires_at: that one is
--     the customer-initiated 24h dual-sign window. This column holds
--     the longer 7-day server-initiated grace deadline. The sub-slice
--     28.3 HMAC validator reads THIS column to decide whether
--     secret_prev is still acceptable.
--
--   force_rotated_at TIMESTAMPTZ NULL
--     Stamped when the server fired the 91-day auto-rotation (sub-
--     slice 28.2). The daily sweep keys off `force_rotated_at IS
--     NULL` so the auto-rotation never fires twice for the same
--     rotation cycle. Reset to NULL on the next customer-initiated
--     rotation so the 91-day clock restarts.

ALTER TABLE "webhook_endpoints"
  ADD COLUMN "grace_window_ends_at" timestamptz,
  ADD COLUMN "force_rotated_at" timestamptz;
