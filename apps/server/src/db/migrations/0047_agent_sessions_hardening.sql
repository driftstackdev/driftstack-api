-- v2-#9: agent_sessions schema hardening — pure Tier-1.
--
-- Adds three customer-protective columns + one composite index that
-- the AI chat layer needs once load exceeds single-developer testing:
--
--   - `idempotency_key` (TEXT, nullable + unique-when-set) — lets the
--     route layer accept POST /v1/agent-sessions with an Idempotency-
--     Key header (Stripe-pattern) so a double-fire from a flaky
--     dashboard tab doesn't burn through the customer's per-account
--     concurrent-agent cap.
--
--   - `created_by_user_id` (UUID, nullable) — for team accounts (V-298
--     RBAC) so we can attribute an agent-session to the specific team
--     member who started it. Customer audit log already captures the
--     actor via the actor_account_id / actor_key_id columns, but
--     surfacing the owner of an active session on the agent-session
--     row itself is what dashboards need for "started by alice@ team
--     14 minutes ago" UI without a JOIN to the audit log.
--
--   - `closed_at` (TIMESTAMPTZ, nullable) — when the session
--     transitioned out of `active` status. Today the closedReason
--     column carries the WHY but there's no separate WHEN; the
--     updated_at column moves on every transcript append so it's not
--     a reliable closed-at signal. Backfill on existing rows is left
--     null (we don't know retroactively).
--
-- Composite index on (account_id, status, created_at DESC) so the
-- "list my active agent sessions" query stays under the same latency
-- budget as the analogous sessions query.
--
-- All columns nullable; no backfill needed. Idempotency-key uniqueness
-- is a partial unique index (only enforces when key is non-null).

ALTER TABLE "agent_sessions" ADD COLUMN "idempotency_key" text;
ALTER TABLE "agent_sessions" ADD COLUMN "created_by_user_id" uuid REFERENCES "accounts"("id") ON DELETE SET NULL;
ALTER TABLE "agent_sessions" ADD COLUMN "closed_at" timestamptz;

-- Partial unique index — `idempotency_key` MUST be unique per
-- (account_id, key), but null keys are allowed unbounded times.
-- Scope is per-account so customer A's "key=foo" doesn't collide
-- with customer B's "key=foo".
CREATE UNIQUE INDEX "agent_sessions_idempotency_key_unique"
  ON "agent_sessions" ("account_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- Composite list-by-status index. status='active' is the common
-- filter; ordering by created_at DESC matches the dashboard UI.
CREATE INDEX "agent_sessions_account_status_created_idx"
  ON "agent_sessions" ("account_id", "status", "created_at" DESC);
