-- v2-#4: Q.1.e cost-tracking — extend usage_records to capture
-- ClaudeAgentDecomposer per-turn input/output tokens + cost cents.
--
-- Per founder Q.1.e verdict 2026-05-17: cost-tracked at v1.0 but
-- UNBILLED until the bundled-LLM tier launches (strategic directive
-- 2026-05-17T19:15Z). The metadata payload exists so the cost-tracked
-- → cost-billed transition is a config flip on the meter side, not a
-- schema migration.
--
-- Two changes:
--
--   1. ALTER TYPE usage_record_type — add 'agent_decomposer' value.
--      One row per decompose() call (NOT one per output token);
--      tokens live in the metadata payload below.
--
--   2. ALTER TABLE usage_records — add metadata JSONB column.
--      Shape for `record_type = 'agent_decomposer'`:
--
--        {
--          "decomposer_kind": "claude" | "deterministic",
--          "model": "claude-opus-4-7",                  -- claude only
--          "anthropic_input_tokens": <int>,             -- claude only
--          "anthropic_output_tokens": <int>,            -- claude only
--          "tokens_consumed": <int>,                    -- both (UI + budget)
--          "cost_usd_cents": <int>,                     -- claude only
--          "decompose_result_kind": "plan" | "clarify" | "refuse"
--        }
--
--      Existing record types (session_minute, navigate, etc.) keep
--      writing NULL metadata for now — no backfill, no on-write
--      coercion. The aggregate reporting code that drives the usage
--      page does NOT consume metadata yet; it only sums quantity per
--      record_type.

ALTER TYPE "usage_record_type" ADD VALUE IF NOT EXISTS 'agent_decomposer';

ALTER TABLE "usage_records" ADD COLUMN "metadata" jsonb DEFAULT NULL;
