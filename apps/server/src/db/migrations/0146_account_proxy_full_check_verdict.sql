-- 0146 — store the verdict of the last FULL check a phone measured, with its date.
--
-- Proxy-accuracy audit G2 (d), second pass. A desktop that never ran the check
-- (a second Mac, a reinstall) has to learn that the check Driftstack ran from the
-- phone's own network found a SOCKS5 proxy unusable, so it stops showing the
-- readings taken before the failure. The list carried only `exit_superseded_at`
-- (0122), and that stamp has TWO writers: the fleet-vantage Test, and the
-- background freshness job, which stamps it from the control plane after three
-- missed reachability probes. The control plane is a different machine with a
-- different address, so its streak cannot tell a dead proxy from one that only
-- admits listed addresses; adopting the stamp as "fails from Driftstack" put that
-- verdict on every Mac, retired every reading, and came back after every fix.
--
--   full_check_ok / full_check_at — the verdict of the last `?check=full` Test a
--     fleet Mac measured (`measured_by: phone`): true = the proxy was usable,
--     false = the check reached a verdict and it was not, and when. Written ONLY
--     by that Test, only onto the identity it measured, and later wins. A quick
--     check, a fallback the control plane measured, a check that could not run,
--     a live session and the background job never write it. An edit that
--     repoints the row or changes its credential clears it.
--
-- EXPAND ONLY. Both nullable, no default, no back-fill: NULL = no full check has
-- reached a verdict since the row last changed identity, and no stored stamp can
-- be attributed to its writer after the fact. Reversible by dropping what it
-- adds. The lock timeout makes a busy table fail the batch fast and whole, which
-- is safe to retry.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "account_proxies" ADD COLUMN "full_check_ok" boolean;

ALTER TABLE "account_proxies" ADD COLUMN "full_check_at" timestamptz;
