-- V-545.B Phase 2 throttle table.
--
-- Per the V-545.B doc: per-update notification emails are throttled to
-- "max 1 per subscriber per incident per hour". Without this table the
-- bootstrap.lifecycle.onPublicUpdated wire would fan out on every
-- addUpdate call — that floods subscribers on long-running incidents.
--
-- One row per (subscriber, incident) marks the most-recent send. The
-- IncidentNotificationsService consults this before dispatching:
--   - row absent OR last_sent_at < now() - 1h → send + upsert row
--   - row present AND last_sent_at >= now() - 1h → skip
--
-- The status-incident-created and status-incident-resolved templates
-- are NOT throttled (one each per incident lifetime), so they don't
-- touch this table.

CREATE TABLE "incident_update_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscriber_id" uuid NOT NULL REFERENCES "status_subscribers"("id") ON DELETE CASCADE,
  "incident_id" uuid NOT NULL REFERENCES "incidents"("id") ON DELETE CASCADE,
  "last_sent_at" timestamptz NOT NULL DEFAULT now(),

  -- One row per (subscriber, incident); upsert on conflict.
  UNIQUE ("subscriber_id", "incident_id")
);

-- Read pattern: "is there a recent send for this (subscriber, incident)
-- in the last 1h?". The UNIQUE constraint already provides the index.
