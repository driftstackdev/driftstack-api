-- Persist the latest ownership-validated harness errorEvent on its agent
-- session. The harness sends this after terminal sessionStatus, so a durable
-- nullable JSONB field preserves the structured customer/SDK diagnostic across
-- API restarts without changing historical rows.
ALTER TABLE "agent_sessions" ADD COLUMN "last_error_event" jsonb;
