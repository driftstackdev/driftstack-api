-- 2026-09-16 (ITEM 4) — bookkeeping for the BACKGROUND proxy-freshness refresher
-- (`proxy.freshness_refresh`, services/proxy-freshness-job.ts).
--
-- The refresher re-probes a saved SOCKS5/HTTP proxy on a slow cadence so the
-- reading stored on the row (exit identity, OS fingerprint) is still true on a
-- machine that has never run a Test — the reading the desktop client caches for
-- 30 minutes and loses on a reinstall. It needs two facts the row did not carry:
--
--   freshness_attempted_at          — when the refresher last ATTEMPTED this row,
--     success or failure. It is the cooldown clock AND the claim: the tick stamps
--     it inside the same statement that selects the row FOR UPDATE SKIP LOCKED, so
--     a second worker can neither claim the same row nor find it due again.
--
--     ⛔ DELIBERATELY NOT `updated_at`. Every customer edit of the row (a relabel,
--     a credential rotation) bumps updated_at, so reusing it as the cooldown would
--     let an unrelated edit schedule a dial through the customer's proxy, and a
--     refresh would look like an edit to anything reading updated_at. The two
--     clocks measure different things and must not share a column.
--
--   freshness_consecutive_failures  — consecutive BACKGROUND probe failures, reset
--     to 0 by the next success. Nothing customer-facing reads it. It exists so a
--     SUSTAINED run of failures can be told apart from one transient miss, which is
--     the webhooks precedent (db/webhooks-repo.ts recordRetry deliberately does not
--     bump consecutive_failures; only recordDlq does). A single failed background
--     probe writes this counter and NOTHING else — no customer-visible field moves.
--
-- The partial index matches the due predicate exactly (VPN rows are never
-- refreshed here — a tunnel needs a fleet node to bring it up, see the job's
-- comment), so the scan stays on the population the sweep can actually probe.
-- Built non-concurrently for the reason 0109 and 0113 record: the drizzle
-- postgres-js migrator wraps each file in a transaction and CREATE INDEX
-- CONCURRENTLY cannot run inside one. IF NOT EXISTS keeps that path idempotent.
--
-- EXPAND ONLY. The timestamp is nullable with no back-fill (NULL = never
-- attempted, which is exactly "due now" for a row that predates this column); the
-- counter is NOT NULL DEFAULT 0, which is true of every existing row by
-- construction. Reversible by dropping what it adds; it changes nothing that
-- already exists.

ALTER TABLE "account_proxies" ADD COLUMN "freshness_attempted_at" timestamptz;

ALTER TABLE "account_proxies" ADD COLUMN "freshness_consecutive_failures" integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "account_proxies_freshness_due_idx"
  ON "account_proxies" ("freshness_attempted_at")
  WHERE "scheme" IN ('socks5', 'http');
