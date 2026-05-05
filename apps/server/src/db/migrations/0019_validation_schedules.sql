-- V-218 — continuous validation harness scheduling.
--
-- Stores per-archetype recapture schedules. The harness worker
-- periodically (bootstrap-managed setInterval) calls processTick()
-- which finds rows with next_run_at <= now() AND enabled=true,
-- dispatches them to RecaptureService.triggerRecapture(), then
-- updates last_run_at + next_run_at.
--
-- Cross-repo dep: when Agent 1's V-203 Phase 2A vendor probe
-- vendoring lands, RecaptureService implementations can wire the
-- vendor-probe execution as the actual validation surface. Until
-- then, the mock RecaptureService from packages/recapture-automation
-- is the dispatch target — schedule + dispatch + ledger are real;
-- the validation execution is mocked.

CREATE TABLE IF NOT EXISTS "validation_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "archetype_id" text NOT NULL,
  "cadence_seconds" integer NOT NULL,
  "enabled" boolean NOT NULL DEFAULT true,
  "last_run_at" timestamp with time zone,
  "next_run_at" timestamp with time zone NOT NULL,
  "last_run_id" text,
  "reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "validation_schedules_archetype_unique"
  ON "validation_schedules" ("archetype_id");

CREATE INDEX IF NOT EXISTS "validation_schedules_due_idx"
  ON "validation_schedules" ("enabled", "next_run_at");
