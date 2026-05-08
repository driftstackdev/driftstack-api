-- V-356 — extend webhook_event_type enum with the synthetic
-- test.ping value used by POST /v1/webhooks/:id/test.
-- IF NOT EXISTS for safe re-application.
ALTER TYPE "webhook_event_type" ADD VALUE IF NOT EXISTS 'test.ping';
