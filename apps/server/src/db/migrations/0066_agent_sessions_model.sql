-- 2026-05-28 — 6.c / #15: per-session model picker. Records which Claude
-- 4.x model the AI agent runs for each agent_session, so the per-model
-- cost-to-serve rate can be sourced from the api-types CLAUDE_MODELS
-- registry (Opus 4.7 / Sonnet 4.6 / Haiku 4.5). CHECK over the canonical
-- model ids so a future model addition ships as a constraint-edit migration
-- (mirrors the `mode` column added in 0052). Existing rows pick up the
-- 'claude-opus-4-7' default (the prior hardcoded model in
-- agent-decomposer-claude.ts) so no backfill is needed. The SDK + dashboard
-- picker set it at create-time; free-tier accounts (aiAgent:false) never
-- reach the agent path.
ALTER TABLE "agent_sessions"
  ADD COLUMN "model" text NOT NULL DEFAULT 'claude-opus-4-7'
    CHECK ("model" IN ('claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'));
