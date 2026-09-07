-- 2026-09-07 (T-26) — let a customer pin a session to its exit IP, and remember
-- the first exit IP a session was observed leaving through.
--
-- The customer-visible feature: the simulator can now show the live exit IP +
-- WebRTC IP a session leaves through, and a customer who checks
-- "stop the session if the exit IP changes" gets exactly that — a proxy that
-- silently rotates its exit under a running session ends the session rather than
-- carrying on from a new apparent location. The control plane enforces this from
-- the per-session capabilityReport the harness already emits; no harness change.
--
-- EXPAND ONLY. Neither column back-fills or rewrites existing rows:
--
--   * agent_sessions.stop_on_exit_ip_change — the per-session policy the create
--     body sets. NOT NULL DEFAULT false so every historical row and every
--     session that does not ask for it reads exactly `false` (the response field
--     is always a real boolean, never null). Postgres 11+ applies the default as
--     metadata, so the ADD is fast and rewrites nothing.
--
--   * agent_sessions.first_exit_ip — the FIRST exit IP a stop-on-change session
--     was observed leaving through, remembered on the ROW (not the in-memory
--     capability store, which a control-plane restart loses) so the "did it
--     change" comparison survives a restart. NULL until the first observation,
--     and on every row of a session that never enabled the policy. Deliberately
--     free text, not an inet: it is a value the box reports and the schema has
--     already `.ip()`-validated before it reaches here, and a stray value simply
--     never matches the next observation, which is a safe no-op.
--
-- Reversible by dropping what it adds; it changes nothing that already exists.

ALTER TABLE "agent_sessions" ADD COLUMN "stop_on_exit_ip_change" boolean NOT NULL DEFAULT false;

ALTER TABLE "agent_sessions" ADD COLUMN "first_exit_ip" text;
