-- 2026-06-16 — agent_sessions.driftstack_session_id strict FK. Was a loose
-- `text` column accepting arbitrary strings; now `uuid` with a FK to
-- sessions(id) ON DELETE SET NULL. Prod-verified DATA-SAFE: 0 non-null values
-- across all rows, 0 orphans, so the USING ::uuid conversion can't fail on
-- existing data. ON DELETE SET NULL (not cascade) — an agent session outlives
-- its driver-session pointer; deleting the driver session just detaches it.
-- The route layer normalizes the public ses_<uuid> form → raw uuid and
-- validates the session belongs to the caller before storing (closes the
-- latent cross-account pointer gap). Idempotent.
DO $$ BEGIN
  IF (
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'agent_sessions' AND column_name = 'driftstack_session_id'
  ) <> 'uuid' THEN
    ALTER TABLE "agent_sessions"
      ALTER COLUMN "driftstack_session_id" TYPE uuid USING "driftstack_session_id"::uuid;
  END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "agent_sessions"
    ADD CONSTRAINT "agent_sessions_driftstack_session_id_sessions_id_fk"
    FOREIGN KEY ("driftstack_session_id") REFERENCES "sessions"("id")
    ON DELETE SET NULL ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
