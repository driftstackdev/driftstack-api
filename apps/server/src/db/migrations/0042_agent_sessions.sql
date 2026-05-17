-- AI-A.b agent_sessions table — schema LOCKED 2026-05-17 (orchestrator
-- handoff post-AUTO #1). Matches the existing InMemoryAgentSessionsRepo
-- contract in services/agent-sessions.ts.
--
-- Design choices (founder-locked):
--
--   - text PK (`agt_<uuid>`), minted by the app at create. Matches the
--     in-memory variant + recipes.intent_log pattern; avoids the Drizzle
--     uuid type's tie to gen_random_uuid() when the prefix carries
--     domain meaning ("agt_" is the visible discriminator in logs).
--
--   - CHECK constraint over a status enum so future status additions
--     (e.g. 'archived', 'errored') ship as a single migration step
--     editing the constraint, not the full Postgres-enum-type dance.
--
--   - jsonb transcript with [] default; the transcript array grows
--     append-only via `appendTranscript`. Matches the recipes intent_log
--     pattern.
--
--   - Partial indexes on the hot/sparse paths:
--     * status='active' — list-active is the common dashboard query.
--     * driftstack_session_id IS NOT NULL — sessions attached to a
--       running browser session are the small subset that the harness
--       reads.
--
--   - account_id FK ON DELETE CASCADE — no orphan agent sessions if
--     the customer deletes their account (matches account-mfa /
--     recovery-codes lifecycle).
--
--   - token_budget_remaining <= token_budget_total enforced at the
--     DB layer; the decomposer/executor can't accidentally drift
--     remaining > total even via race conditions.

CREATE TABLE "agent_sessions" (
  "id"                      text PRIMARY KEY,
  "account_id"              uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "driftstack_session_id"   text NULL,
  "status"                  text NOT NULL CHECK ("status" IN ('active','paused','closed')),
  "transcript"              jsonb NOT NULL DEFAULT '[]'::jsonb,
  "token_budget_total"      integer NOT NULL CHECK ("token_budget_total" > 0),
  "token_budget_remaining"  integer NOT NULL CHECK ("token_budget_remaining" >= 0),
  "closed_reason"           text NULL,
  "created_at"              timestamptz NOT NULL DEFAULT now(),
  "updated_at"              timestamptz NOT NULL DEFAULT now(),

  -- Token budget invariant — remaining cannot exceed total. Enforced
  -- at the DB layer so the decomposer/executor can't drift this even
  -- via concurrent debits (single UPDATE with returning is still
  -- atomic; the constraint is the belt-and-suspenders backstop).
  CONSTRAINT "agent_sessions_remaining_le_total"
    CHECK ("token_budget_remaining" <= "token_budget_total")
);

-- account-scoped read (dashboard "list my agent sessions").
CREATE INDEX "agent_sessions_account_id_idx" ON "agent_sessions"("account_id");

-- Active-only partial index — list-active is the dashboard's hot read.
CREATE INDEX "agent_sessions_active_idx" ON "agent_sessions"("status")
  WHERE "status" = 'active';

-- Lookup-by-driftstack-session for the harness side ("which agent
-- session is driving this browser session?"). Partial index because
-- the vast majority of agent_sessions rows have NULL driftstack_session_id.
CREATE INDEX "agent_sessions_driftstack_session_id_idx"
  ON "agent_sessions"("driftstack_session_id")
  WHERE "driftstack_session_id" IS NOT NULL;
