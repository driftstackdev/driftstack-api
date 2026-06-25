-- 2026-06-25 — agent_sessions.profile_id: which profile a session is running.
--
-- A profile-backed agent session ships the profile's DEK + sealed-store at
-- dispatch, but the server never recorded WHICH profile a live session was
-- using. That left the out-of-session profile trim (POST /v1/profiles/:id/trim)
-- blind: trim re-seals R2's last-saved blob on an arbitrary node while a live
-- session for the SAME profile still holds the full state and saves it back over
-- the trimmed blob at teardown — a lost update / two-writer race on one R2
-- object. The reclaimed space silently reappears (or the saved state is
-- clobbered).
--
-- profile_id is that pointer: the bare profile uuid written at create-time when
-- the create body carried a profile_id. It lets the trim route refuse (or defer)
-- a trim against a profile that is bound to a status='active' session. NULL on
-- every no-profile (ephemeral) session and on every existing row (no backfill —
-- the trim guard only ever matches a profile_id the route itself wrote, and a
-- pre-column session has already saved-back by the time anyone trims).
--
-- ON DELETE SET NULL: a deleted profile (soft-delete keeps the row; a hard purge
-- removes it) must not cascade an agent-session row away — the session history
-- outlives the profile, exactly like driftstack_session_id (migration 0080).
--
-- Partial index ON (profile_id) WHERE status = 'active' backs the trim guard's
-- hot read: "is there a still-active session for THIS profile?". It stays
-- O(active-for-profile) as closed sessions accumulate and only indexes the rows
-- the guard ever scans. Drizzle's index() can't express the partial WHERE, so
-- it's raw SQL here (same pattern as 0086 agent_sessions_node_id_active_idx).
-- Additive + idempotent.
ALTER TABLE "agent_sessions"
  ADD COLUMN IF NOT EXISTS "profile_id" uuid REFERENCES "profiles"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_sessions_profile_id_active_idx"
  ON "agent_sessions" ("profile_id") WHERE "status" = 'active';
