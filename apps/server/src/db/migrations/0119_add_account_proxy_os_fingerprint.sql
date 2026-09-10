-- 2026-09-10 (N-2) — persist the passive TCP/IP OS fingerprint the control
-- plane observes for a proxy, so a live agent session can project the exit's OS
-- onto its capability_report and the cockpit can show it.
--
-- The customer-visible feature: the proxy connection test already OBSERVES the
-- OS of the proxy's own TCP stack (a passive SYN fingerprint read through the
-- proxy), but that measurement was computed and DISCARDED — nothing persisted it
-- per proxy, so a running session had no OS to show. These two columns record
-- the last observed fingerprint on the proxy row, mirroring how quic_measured
-- (0116) records the last measured QUIC verdict. The serve path reads it once
-- and adds only the {os, confidence} subset to the session capability_report;
-- the internal diagnostics (reason/observed_ip/observed_via) stay server-side.
--
-- EXPAND ONLY. Both columns are nullable with no default and no back-fill:
--
--   * account_proxies.os_fingerprint — the full structured measurement
--     {os, confidence, reason, observed_ip, observed_via}, or NULL. NULL means
--     never measured, which is NOT a measured "no OS": an absent fingerprint is
--     NOT OBSERVED and must render as "measuring…", never a placeholder OS. The
--     /:id/test route writes it best-effort ONLY when a SYN was observed; a miss
--     persists nothing (the column is left as-is, never nulled).
--
--   * account_proxies.os_fingerprint_at — when os_fingerprint was recorded, or
--     NULL when never measured.
--
-- Reversible by dropping what it adds; it changes nothing that already exists.

ALTER TABLE "account_proxies" ADD COLUMN "os_fingerprint" jsonb;

ALTER TABLE "account_proxies" ADD COLUMN "os_fingerprint_at" timestamptz;
