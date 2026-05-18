-- Arc 5 EGRESS eg.7 — extend webhook_event_type pgEnum with the
-- `session.egress_capability_changed` value.
--
-- Fires when the harness emits an egress.capability_report event for
-- a SOCKS5 session and the control plane ingests it (eg.2 wires the
-- listener; this event fans out to customer webhook endpoints).
-- Subscribable — customers hook proxy-health visibility into their
-- own observability surface.
--
-- IF NOT EXISTS for safe re-application (matches the v2-#356 test.ping
-- migration 0032 pattern).

ALTER TYPE "webhook_event_type" ADD VALUE IF NOT EXISTS 'session.egress_capability_changed';
