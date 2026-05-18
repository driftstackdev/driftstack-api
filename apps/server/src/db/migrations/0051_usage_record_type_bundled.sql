-- Arc 1 sub-slice 6.4 (v2-#6 bundled-LLM cost recording).
--
-- Adds `agent_decomposer_bundled` to the usage_record_type pgEnum.
-- Sub-slice 6.4 writes one row of this type per bundled-LLM-served
-- agent-session turn with a flat $0.10 posted cost (Q5=A: actual
-- upstream Anthropic cost hidden). Soft-cap enforcement against the
-- monthly cap (sub-slice 6.5) sums `cost_usd_cents` over rows with
-- this record_type for the current calendar month.
--
-- Same INTERNAL_RECORD_TYPES filter as `agent_decomposer` keeps the
-- bundled rows off the customer-facing /v1/usage summary (server-
-- internal cost telemetry only); the bundled-LLM status endpoint
-- (sub-slice 6.7) is the customer-visible surface for these numbers.

ALTER TYPE "usage_record_type" ADD VALUE IF NOT EXISTS 'agent_decomposer_bundled';
