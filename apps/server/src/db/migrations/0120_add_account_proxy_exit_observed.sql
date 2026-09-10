-- 2026-09-10 (VPN parity) — persist the EXIT IDENTITY a live session observed
-- through a proxy, so an OpenVPN/WireGuard proxy can have a location and a
-- timezone at all.
--
-- The customer-visible feature: for a SOCKS5 proxy the desktop client probes the
-- exit from the customer's Mac (exit IP -> country/timezone), caches it, shows the
-- location on the profile card and hands the timezone to the simulator at launch.
-- For a VPN the Mac cannot probe through the tunnel — only the fleet box can, and
-- it already does: at session start it reads its exit through its egress and
-- reports exit_ip / exit_country / exit_timezone on the capability report. That
-- observation was consumed for the exit-change stop and then DISCARDED — nothing
-- persisted it per proxy, so a VPN proxy never had a location and every VPN
-- session's status-bar clock started on host time. These two columns record the
-- last observed exit on the proxy row, mirroring quic_measured (0116) and
-- os_fingerprint (0119). The relay writes it best-effort (latest wins); the
-- /proxies list surfaces it so the client can show location and start the next
-- launch with the right timezone.
--
-- EXPAND ONLY. Both columns are nullable with no default and no back-fill:
--
--   * account_proxies.exit_observed — {ip, country, timezone, observed_via}, or
--     NULL. NULL means never observed, which is NOT a measured "unknown exit": it
--     must render as "measuring…", never a placeholder location.
--
--   * account_proxies.exit_observed_at — when exit_observed was recorded, or NULL.
--
-- Reversible by dropping what it adds; it changes nothing that already exists.

ALTER TABLE "account_proxies" ADD COLUMN "exit_observed" jsonb;

ALTER TABLE "account_proxies" ADD COLUMN "exit_observed_at" timestamptz;
