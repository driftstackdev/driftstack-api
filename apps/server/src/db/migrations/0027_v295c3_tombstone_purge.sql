-- V-295c3-tombstone — admin endpoints + 90d email-purge cron support.
--
-- Two structural changes:
--
--  1. Make status_subscribers.email NULLable so the 90d post-unsubscribe
--     purge can NULL the email column without violating UNIQUE (NULL
--     does not collide with NULL in PostgreSQL UNIQUE constraints, so
--     multiple purged rows coexist).
--
--  2. Extend the admin_audit_action enum with the two new admin actions:
--       status_subscriber.force_unsubscribed — admin force-unsubscribed a row
--       status_subscriber.purged             — automated 90d purge fired
--     The purge is automated but logged because it touches PII removal;
--     auditors should be able to reconstruct WHEN the email was zeroed.

ALTER TABLE "status_subscribers"
  ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint

ALTER TYPE "public"."admin_audit_action" ADD VALUE IF NOT EXISTS 'status_subscriber.force_unsubscribed';--> statement-breakpoint
ALTER TYPE "public"."admin_audit_action" ADD VALUE IF NOT EXISTS 'status_subscriber.purged';
