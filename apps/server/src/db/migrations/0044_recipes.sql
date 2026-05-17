-- AI-B4 recipes table — write-only at v1.0 launch. POST /v1/recipes
-- snapshots a finished agent_session's intent_log + transcript so
-- the customer can replay the same flow later via the SDK without
-- re-paying the LLM decomposition cost. Read / list / execute /
-- delete surfaces are v1.1 D2/D3 scope (orchestrator handoff #3 Q.5).
--
-- Design choices:
--
--   - text PK (`rec_<uuid>`), minted by the app at create.
--     Matches the agent_sessions PK shape; `rec_` is the visible
--     discriminator in logs + SDK.
--
--   - agent_session_id is NULLABLE FK ON DELETE SET NULL. The
--     recipe SURVIVES agent-session cleanup — a customer's recipe
--     is theirs to keep even after the source agent session is
--     pruned. ON DELETE SET NULL preserves the recipe row while
--     dropping the dangling reference.
--
--   - jsonb intent_log captures the array of AgentIntent objects
--     the agent executed. Read pattern from the recipe-replay path
--     (v1.1) iterates this array in order; insert pattern is one
--     atomic snapshot per recipe.
--
--   - jsonb transcript_snapshot captures the user+agent turns at
--     snapshot time. Useful context for "what did I ask?" when the
--     customer revisits the recipe months later.
--
--   - label CHECK (1..120 chars) — short customer-facing name.
--     description CHECK (<=2000 chars) — optional longer context.
--     Both bound the per-row footprint so a malicious / accidental
--     huge label can't dominate storage.

CREATE TABLE "recipes" (
  "id"                  text PRIMARY KEY,
  "account_id"          uuid NOT NULL REFERENCES "accounts"("id") ON DELETE CASCADE,
  "agent_session_id"    text NULL REFERENCES "agent_sessions"("id") ON DELETE SET NULL,
  "label"               text NOT NULL CHECK (length("label") BETWEEN 1 AND 120),
  "description"         text NULL CHECK ("description" IS NULL OR length("description") <= 2000),
  "intent_log"          jsonb NOT NULL,
  "transcript_snapshot" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

-- Account-scoped read (dashboard "list my recipes" — v1.1).
CREATE INDEX "recipes_account_id_idx" ON "recipes"("account_id");

-- Source-session lookup for the rare "which recipe came from this
-- agent session?" path. Partial index because once an agent session
-- is deleted the FK is nulled out, leaving most rows NULL on this
-- column.
CREATE INDEX "recipes_agent_session_id_idx"
  ON "recipes"("agent_session_id")
  WHERE "agent_session_id" IS NOT NULL;
