-- 2026-09-18 — one diagnostics row per AI message request.
--
-- Nobody could see how the AI automation behaves in production. The only reason
-- it was known that production had served 27 AI turns with a quarter of the
-- requests ending in HTTP 409 is that someone grepped proxy access logs. "Where
-- do real tasks die?" had no answer outside a test harness. This table is that
-- answer, written by services/agent-turn-telemetry.ts at the message route's
-- seam and read, as aggregates only, by GET /v1/admin/agent-turns/summary.
--
-- ⛔ CONTENT-FREE BY CONSTRUCTION, AND THE DATABASE ENFORCES IT. There is no
-- account id, no session id, no foreign key: a row cannot be joined back to a
-- customer. Every text column is CHECK-constrained to a closed list (`model` to
-- a shape that cannot hold prose) — the same unions the writer declares in
-- source, pinned against this file by
-- `agent-turn-telemetry-unions-match-the-migration` — so an edit that tries to
-- store a task, a URL, a selector, page text or an answer "for debugging" fails
-- the INSERT rather than leaking. Everything else is a number, a boolean or a
-- timestamp. Adding an outcome or a death reason therefore needs a migration
-- that widens the constraint; that friction is the point.
--
-- A failed insert never reaches the customer: the writer is fire-and-forget and
-- counts its own failures in driftstack_agent_turn_telemetry_write_total.
--
-- Retention: 90 days, pruned daily by the `agent_turn_telemetry.prune` job.
--
-- EXPAND ONLY. One new table and one index; nothing existing is touched.
-- Reversible by dropping the table.

CREATE TABLE IF NOT EXISTS "agent_turn_telemetry" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "occurred_at" timestamptz NOT NULL DEFAULT now(),
  "outcome" text NOT NULL,
  "death_reason" text NOT NULL,
  "died_step_index" integer,
  "died_step_kind" text,
  "http_status" integer NOT NULL,
  "transport" text NOT NULL,
  "model" text NOT NULL,
  "steps_planned" integer NOT NULL,
  "steps_run" integer NOT NULL,
  "steps_succeeded" integer NOT NULL,
  "replans" integer NOT NULL,
  "model_calls" integer NOT NULL,
  "recovered_after_replan" boolean NOT NULL,
  "duration_ms" integer NOT NULL,
  "time_to_first_progress_ms" integer,
  "planning_ms" integer NOT NULL,
  "starting_browser_ms" integer NOT NULL,
  "executing_ms" integer NOT NULL,
  "reading_page_ms" integer NOT NULL,
  "answering_ms" integer NOT NULL,
  "input_tokens" integer NOT NULL,
  "output_tokens" integer NOT NULL,
  "cache_read_tokens" integer NOT NULL,
  "cache_write_tokens" integer NOT NULL,
  "estimated_cost_millicents" bigint NOT NULL,
  "customer_stopped" boolean NOT NULL,
  "viewer_disconnected" boolean NOT NULL,
  CONSTRAINT "agent_turn_telemetry_outcome" CHECK (
    "outcome" IN (
      'completed',
      'failed',
      'halted_for_confirmation',
      'clarified',
      'refused',
      'stopped',
      'busy_409',
      'conflict_409',
      'rate_limited',
      'rejected',
      'error'
    )
  ),
  CONSTRAINT "agent_turn_telemetry_death_reason" CHECK (
    "death_reason" IN (
      'none',
      'halted_for_confirmation',
      'element_never_appeared_in_retry_budget',
      'element_click_intercepted',
      'element_not_interactable',
      'wait_condition_not_met',
      'capture_failed',
      'page_load_failed',
      'invalid_parameter',
      'result_too_large',
      'readback_gate_blocked',
      'answer_path_failed_after_being_reached',
      'turn_errored',
      'harness_error_unclassified',
      'session_error',
      'policy_refused',
      'model_refused',
      'model_unavailable',
      'customer_closed_session',
      'control_taken_mid_turn',
      'budget_exhausted',
      'transcript_limit',
      'session_not_active',
      'control_unavailable',
      'turn_in_progress',
      'idempotency_in_progress',
      'idempotency_mismatch',
      'account_turn_limit',
      'rate_limited',
      'request_rejected'
    )
  ),
  CONSTRAINT "agent_turn_telemetry_died_step_kind" CHECK (
    "died_step_kind" IS NULL
    OR "died_step_kind" IN (
      'navigate',
      'interact',
      'wait',
      'capture',
      'scroll',
      'behavioral_pause'
    )
  ),
  CONSTRAINT "agent_turn_telemetry_transport" CHECK ("transport" IN ('stream', 'json')),
  -- A SHAPE rather than a list, unlike its neighbours: the writer stores a model
  -- catalogue id, `other` or `none`, and listing the catalogue here would make
  -- "add a model" require a migration to a monitoring table. The shape still
  -- cannot hold a URL (no `:` or `/`), a sentence (no space) or anything long.
  CONSTRAINT "agent_turn_telemetry_model" CHECK ("model" ~ '^[a-z0-9.-]{1,40}$'),
  CONSTRAINT "agent_turn_telemetry_http_status" CHECK ("http_status" BETWEEN 100 AND 599),
  CONSTRAINT "agent_turn_telemetry_counts_nonnegative" CHECK (
    "steps_planned" >= 0
    AND "steps_run" >= 0
    AND "steps_succeeded" >= 0
    AND "replans" >= 0
    AND "model_calls" >= 0
    AND "duration_ms" >= 0
    AND "input_tokens" >= 0
    AND "output_tokens" >= 0
    AND "cache_read_tokens" >= 0
    AND "cache_write_tokens" >= 0
    AND "estimated_cost_millicents" >= 0
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_turn_telemetry_occurred_at_idx"
  ON "agent_turn_telemetry" ("occurred_at");
