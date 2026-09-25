-- 0145 — the UDP readings stored on SOCKS5 proxy rows are cleared.
--
-- Proxy-accuracy audit S1. A fleet-vantage Test stored a SOCKS5 row's
-- `udp_probe` from the node's bare `udp_associate`, which is the grant of the
-- node's OWN local gost listener: gost says yes to UDP ASSOCIATE before it ever
-- contacts the customer's proxy. Proxies that refuse UDP, and proxies that drop
-- every datagram, were stored as "UDP works"; a probe tool that never ran was
-- stored as "no UDP". No node sends `udp_detail` on the SOCKS5 path and
-- `udp_echo_ok` was read nowhere, so every SOCKS5 `udp_probe` on record came
-- from that grant. The route now stores a SOCKS5 UDP reading only from a
-- datagram round trip, and these rows read "not measured" until one is taken.
--
-- DATA ONLY: no column, constraint or index changes. Other schemes keep their
-- readings, and the QUIC columns are untouched on every row. Idempotent: a
-- second run matches no row. The lock timeout makes a busy table fail the batch
-- fast and whole, which is safe to retry.
--
-- Not reversible, by intent: the values removed were not measurements of the
-- customer's proxy.

SET LOCAL lock_timeout = '5s';

UPDATE "account_proxies" SET "udp_probe" = NULL, "udp_probe_at" = NULL WHERE "scheme" = 'socks5' AND ("udp_probe" IS NOT NULL OR "udp_probe_at" IS NOT NULL);
