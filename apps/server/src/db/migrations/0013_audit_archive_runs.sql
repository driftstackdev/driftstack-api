-- V-163: audit_archive_runs ledger per ADR-006 (audit-log retention
-- + R2 export). Records every monthly archive sweep across the four
-- audit-shaped tables (admin_audit_log / processed_stripe_events /
-- legal_acceptances / webhook_deliveries). Forensic recovery: if a
-- DELETE-from-Postgres fails after R2 upload, the ledger row plus
-- the R2 object together reconstruct the archived window.

CREATE TABLE "audit_archive_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"table_name" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"rows_archived" integer NOT NULL,
	"r2_object_key" text NOT NULL,
	"sha256_checksum" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"deleted_from_postgres" boolean DEFAULT false NOT NULL
);--> statement-breakpoint
CREATE INDEX "audit_archive_runs_table_window_idx" ON "audit_archive_runs" USING btree ("table_name","window_start");--> statement-breakpoint
CREATE INDEX "audit_archive_runs_started_idx" ON "audit_archive_runs" USING btree ("started_at");
