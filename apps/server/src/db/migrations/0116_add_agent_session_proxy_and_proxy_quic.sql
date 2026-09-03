-- 2026-09-03 (T-6) — record which proxy a session used, and the QUIC verdict a
-- real session measured through it.
--
-- The customer-visible bug: the proxy connection test says whether the proxy
-- speaks UDP and HTTP/2, but the QUIC (HTTP/3) result is only ever an INFERRED
-- guess drawn from "the proxy advertises UDP association". A proxy that really
-- carries HTTP/3 is still shown with a pale, uncertain QUIC mark, never a
-- confirmed one — so the test looks unreliable for exactly the proxies that
-- work best.
--
-- The only place the system ever OBSERVES real QUIC is a live browsing
-- session's capability report (the harness negotiates h2-and-h3 and loads the
-- HTTP/3 interpose). Today that observation cannot be attributed to a proxy,
-- because a session never records which proxy it ran through: `proxy_id` is a
-- create-only request field carried in memory through dispatch and then
-- dropped. This migration adds the missing link and the two columns that hold
-- the measured verdict, so the test/chip can show a REAL "measured in a
-- session" QUIC result instead of a guess.
--
-- EXPAND ONLY. Every column is nullable with no default and no back-fill:
--
--   * agent_sessions.proxy_id — the proxy a session was dispatched through.
--     Deliberately NO foreign key. The proxy may be an operator default or a
--     device proxy that has no account_proxies row at all, and a create can
--     name a proxy that is later deleted; a stray uuid simply matches no row
--     when the back-fill runs its owner-scoped update, which is the correct
--     no-op. NULL on every historical row and on any session that named no
--     proxy.
--
--   * account_proxies.quic_measured / quic_measured_at — the last QUIC verdict
--     a session measured through this proxy, and when. NULL means never
--     measured, which is distinct from a measured "no HTTP/3": the client keeps
--     the QUIC mark INFERRED (never green) until a real 'h3' arrives here.
--     `quic_measured` is free text at the database layer; the application only
--     ever writes 'h3' or 'h2-only'.
--
-- Reversible by dropping what it adds; it changes nothing that already exists.

ALTER TABLE "agent_sessions" ADD COLUMN "proxy_id" uuid;

ALTER TABLE "account_proxies" ADD COLUMN "quic_measured" text;
ALTER TABLE "account_proxies" ADD COLUMN "quic_measured_at" timestamptz;
