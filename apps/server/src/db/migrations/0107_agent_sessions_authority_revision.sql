-- Internal monotonic control-authority epoch for AI/manual/pair turns. A turn
-- captures this value at admission and all later publication/close writes use
-- it as a compare-and-set fence. This closes value-equivalent A→B→A races:
-- the visible authority tuple may return to its original value, but its epoch
-- never does.
ALTER TABLE "agent_sessions"
  ADD COLUMN "authority_revision" bigint NOT NULL DEFAULT 0;

ALTER TABLE "agent_sessions"
  ADD CONSTRAINT "agent_sessions_authority_revision_nonnegative"
  CHECK ("authority_revision" >= 0);

-- Centralize the bump in Postgres so every current and future writer is
-- covered: route setters, close/reaper bulk updates, and direct maintenance
-- SQL. Writes unrelated to authority cannot advance (or forge) the epoch.
CREATE FUNCTION "agent_sessions_bump_authority_revision"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status"
     OR OLD."mode" IS DISTINCT FROM NEW."mode"
     OR OLD."pair_mode_state" IS DISTINCT FROM NEW."pair_mode_state" THEN
    NEW."authority_revision" := OLD."authority_revision" + 1;
  ELSE
    NEW."authority_revision" := OLD."authority_revision";
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "agent_sessions_authority_revision_trigger"
BEFORE UPDATE ON "agent_sessions"
FOR EACH ROW
EXECUTE FUNCTION "agent_sessions_bump_authority_revision"();
