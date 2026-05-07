-- V-295a — public-status incidents tables + enums.
--
-- Two-table shape:
--   - `incidents` holds the current state (severity, status, resolved_at).
--   - `incident_updates` holds the chronological timeline; one row per
--     admin-posted update.
--
-- Status page consumes `incidents` filtered by `public=true`. Admin
-- surface reads + writes both sides via /v1/admin/incidents/*.
--
-- Foreign keys to accounts + api_keys use ON DELETE RESTRICT so an
-- admin account can't be deleted while incidents reference it (audit
-- integrity).

CREATE TYPE "public"."incident_severity" AS ENUM ('minor', 'major', 'outage');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM ('investigating', 'identified', 'monitoring', 'resolved');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "incidents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title" text NOT NULL,
  "description" text NOT NULL,
  "severity" "incident_severity" NOT NULL,
  "status" "incident_status" NOT NULL DEFAULT 'investigating',
  "affected_components" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "public" boolean NOT NULL DEFAULT true,
  "started_at" timestamp with time zone NOT NULL,
  "resolved_at" timestamp with time zone,
  "created_by_admin_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "created_by_admin_key_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE RESTRICT,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "incidents_started_at_idx" ON "incidents" ("started_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "incidents_public_status_idx" ON "incidents" ("public", "status");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "incident_updates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "incident_id" uuid NOT NULL REFERENCES "incidents"("id") ON DELETE CASCADE,
  "message" text NOT NULL,
  "status" "incident_status" NOT NULL,
  "posted_by_admin_id" uuid NOT NULL REFERENCES "accounts"("id") ON DELETE RESTRICT,
  "posted_by_admin_key_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE RESTRICT,
  "posted_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "incident_updates_incident_id_idx" ON "incident_updates" ("incident_id", "posted_at");--> statement-breakpoint

-- V-281 admin_audit_action enum extension for the new admin actions:
--   incident.created  — admin posted a new incident
--   incident.updated  — admin posted a timeline update on existing
--   incident.resolved — admin marked incident resolved

ALTER TYPE "public"."admin_audit_action" ADD VALUE IF NOT EXISTS 'incident.created';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE IF NOT EXISTS 'incident.updated';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE IF NOT EXISTS 'incident.resolved';
