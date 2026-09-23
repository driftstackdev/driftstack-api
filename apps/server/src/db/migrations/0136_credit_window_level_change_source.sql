-- 0136 — a window's level change says WHICH coverage it came from.
--
-- S17's audit found that a refund of a mid-month upgrade could not be measured:
-- the proration lot an upgrade grants is keyed `proration:<window>:<seq>`, and
-- nothing recorded which paid invoice that step was for. A refund of the
-- upgrade invoice therefore found no lot of its own to take back (the refresh
-- later took the WHOLE new level's share instead), and a refund of the base
-- month took the upgrade's lot along with its own.
--
-- `source_ref` records it: for a plan change, the coverage that supplied the
-- new level (a Stripe invoice id, a crypto order id, or the override marker);
-- for a refund, a dispute or a won dispute, the invoice or order whose payment
-- moved. A proration lot is then attributable to exactly the invoice its step
-- names, and the level a partly refunded upgrade invoice still covers can be
-- measured from the level the upgrade started at.
--
-- ADDITIVE. One nullable column, no default, no backfill: existing rows keep
-- NULL, which every reader treats as "attributable to no invoice". Production
-- holds no level changes (AI credits ship dark), so nothing is left unattributed
-- there. Adding a nullable column with no default rewrites nothing and takes
-- ACCESS EXCLUSIVE only for the moment of the catalogue change; the lock timeout
-- makes a busy table fail the batch fast and whole, which is safe to retry.
--
-- The table's append-only guard is untouched: a row is still never updated, so
-- the column is written once, with the row, by `setWindowLevel`.
--
-- Reversible by dropping the column.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "credit_window_level_changes" ADD COLUMN IF NOT EXISTS "source_ref" text;
