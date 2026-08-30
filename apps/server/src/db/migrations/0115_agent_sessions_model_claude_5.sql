-- 0115 — Claude 5 agent-session models.
--
-- Adds 'claude-opus-5' and 'claude-sonnet-5' as accepted models and makes Opus 5
-- the new column default. ADDITIVE, exactly like 0087: every 4.x id stays in the
-- CHECK, so no existing row violates the new set and a session created before
-- this bump still reads back.
--
-- ⛔ The CHECK is why the TypeScript enum alone is not enough: without this
-- migration the database REJECTS every insert naming a 5-generation model, and
-- the failure lands at session-create time in production, not in a test.
--
-- The inline column CHECK from 0066 is auto-named "agent_sessions_model_check"
-- (Postgres convention for an unnamed column constraint: <table>_<column>_check).
-- DROP IF EXISTS + re-ADD keeps this re-runnable.
ALTER TABLE "agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_model_check";

ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_model_check"
  CHECK ("model" IN ('claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'));

ALTER TABLE "agent_sessions" ALTER COLUMN "model" SET DEFAULT 'claude-opus-5';
