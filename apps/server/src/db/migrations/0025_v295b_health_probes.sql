-- V-295b — system health probe history + auto-incident attribution.
--
-- Two structural changes:
--
--  1. `system_health_probes` table — one row per probe attempt.
--     Poller runs every 60s, writes a row, evaluates last-3-rows-per-target
--     for the consecutive-fail / consecutive-pass thresholds.
--
--  2. Allow incidents + incident_updates admin-attribution columns to be
--     NULL. When the V-295b poller auto-creates an incident on
--     3-consecutive-fail, there is no admin actor — those columns get NULL
--     and `auto_probe_target` is set instead. Admin-posted incidents
--     continue to populate the admin columns + leave auto_probe_target NULL.
--     The route handlers enforce non-null admin attribution; only the
--     poller path bypasses it.

ALTER TABLE "incidents"
  ALTER COLUMN "created_by_admin_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents"
  ALTER COLUMN "created_by_admin_key_id" DROP NOT NULL;--> statement-breakpoint

ALTER TABLE "incidents"
  ADD COLUMN IF NOT EXISTS "auto_probe_target" text;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "incidents_auto_probe_open_idx"
  ON "incidents" ("auto_probe_target", "status");--> statement-breakpoint

ALTER TABLE "incident_updates"
  ALTER COLUMN "posted_by_admin_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "incident_updates"
  ALTER COLUMN "posted_by_admin_key_id" DROP NOT NULL;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "system_health_probes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "target" text NOT NULL,
  "probed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "ok" boolean NOT NULL,
  "latency_ms" integer,
  "http_status" integer,
  "error_message" text
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "system_health_probes_target_probed_at_idx"
  ON "system_health_probes" ("target", "probed_at");
