-- 2026-09-17 — store what a proxy Test MEASURED about QUIC and UDP on the row.
--
-- account_proxies keeps the readings that are taken on one machine and read on
-- every other one: os_fingerprint (0119), exit_observed (0120), quic_measured
-- (0116). Two readings a Test takes had nowhere to live. A fleet-vantage
-- POST /v1/account/me/proxies/:id/test measures whether QUIC relays through the
-- proxy and whether it carries UDP, answers the caller, and leaves the row
-- untouched — so the reading existed only in the local cache of whichever
-- desktop pressed Test. Checked against production on the day this was written:
-- 6 of 12 proxies held no QUIC reading of any kind, and 4 of those were alive.
--
-- The cost is not the missing chip, it is that NOTHING CAN TELL "measured: no"
-- FROM "never measured". A client that wants to fill in missing readings on its
-- own cannot do so safely: with no stored negative it would re-probe a proxy that
-- genuinely does not relay QUIC on every pass, forever. Storing the reading WITH
-- its date — true AND false — is what makes "missing" mean missing.
--
--   quic_probe / quic_probe_at — did QUIC relay through this proxy when a Test
--     last measured it, and when.
--   udp_probe  / udp_probe_at  — did the proxy carry UDP when a Test last
--     measured it, and when.
--
-- ⛔ DELIBERATELY NOT `quic_measured`. That column means "a LIVE SESSION
-- negotiated HTTP/3 through this proxy" ('h3' | 'h2-only') and its only writer
-- is the capabilityReport relay. A Test's relay check and a session's negotiated
-- protocol are different measurements that can honestly disagree, and the
-- desktop client already models them as two things (quicMeasured vs quicProbe).
-- Overloading one column would let a Test's "relays" read as a session's "h3".
--
-- ⛔ NULL = NEVER MEASURED, and only a measurement may move it. A leg the node
-- skipped, a frame that reached no verdict, a VPN row's asserted literal — none
-- of them writes here. A miss is never coerced into false.
--
-- EXPAND ONLY. All four nullable, no default, no back-fill: every existing row
-- has truthfully never had a Test reading stored. Reversible by dropping what it
-- adds; it changes nothing that already exists.

ALTER TABLE "account_proxies" ADD COLUMN "quic_probe" boolean;

ALTER TABLE "account_proxies" ADD COLUMN "quic_probe_at" timestamptz;

ALTER TABLE "account_proxies" ADD COLUMN "udp_probe" boolean;

ALTER TABLE "account_proxies" ADD COLUMN "udp_probe_at" timestamptz;
