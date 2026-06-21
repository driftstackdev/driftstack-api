-- 0087 — Opus 4.8 agent-session model.
--
-- Adds 'claude-opus-4-8' (the latest Opus) as an accepted model and makes it the
-- new column default. ADDITIVE: 'claude-opus-4-7' stays in the CHECK so sessions
-- created before this bump remain valid (no existing row violates the new set).
--
-- The inline column CHECK from 0066 is auto-named "agent_sessions_model_check"
-- (Postgres convention for an unnamed column constraint: <table>_<column>_check).
-- DROP IF EXISTS + re-ADD keeps this re-runnable.
ALTER TABLE "agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_model_check";

ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_model_check"
  CHECK ("model" IN ('claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'));

ALTER TABLE "agent_sessions" ALTER COLUMN "model" SET DEFAULT 'claude-opus-4-8';
