// GET /v1/egress/echo — exit-IP echo for device-side proxy probes.
//
// The GUI's proxy capability probe CONNECTs through a customer's SOCKS5
// proxy to this endpoint and reads back the IP (and country) the world
// sees — exit-geo for the proxy-health board, without leaking customer
// exit IPs to a third-party echo service (design:
// docs/internal/2026-06-12-proxy-probe-backend-design.md; F1 decided
// per the doc's recommendation under the founder's blanket greenlight).
//
// UNAUTHENTICATED by design (F1: exit IPs never tied to accounts —
// maximum privacy) + IP-rate-limited (probe cadence is launch + 6h +
// manual; the limit is generous for real probes, hostile to scrapers).
//
// Note on the server-side pre-launch proxy probe: it ALSO targets this
// endpoint (through the customer's proxy → req.ip here is the proxy EXIT
// IP), and shared/burst exit IPs can exhaust the per-IP bucket → 429. That
// no longer false-blocks launches: the probe validates proxy CONNECTIVITY,
// not this endpoint's status, so ANY HTTP response back (incl. a 429 from
// this limiter or a 403/503 from the CF edge) is treated as PASS — the
// round-trip completing is the proof. So this limit is intentionally left
// as-is for scraper resistance; it cannot throttle a real launch.
//
// Geo source: Cloudflare's `cf-ipcountry` edge header (the API is
// CF-fronted; trustProxy makes req.ip the real client). 'XX' (unknown)
// and 'T1' (Tor) sentinel values surface as null — never invented.

import type { FastifyInstance } from 'fastify';
import type { RateLimitStore } from '../services/rate-limit.js';
import { ipRateLimit } from '../middleware/ip-rate-limit.js';

export const EGRESS_ECHO_IP_LIMIT = { capacity: 12, refillPerSecond: 12 / 60 };

export function registerEgressEchoRoutes(
  app: FastifyInstance,
  deps: { rateLimitStore: RateLimitStore },
): void {
  const echoGate = ipRateLimit(deps.rateLimitStore, {
    bucketPrefix: 'egress_echo',
    ...EGRESS_ECHO_IP_LIMIT,
  });

  app.get('/v1/egress/echo', { preHandler: [echoGate] }, (req) => {
    const rawCountry = req.headers['cf-ipcountry'];
    const country =
      typeof rawCountry === 'string' && /^[A-Z]{2}$/.test(rawCountry) && rawCountry !== 'XX'
        ? rawCountry
        : null;
    return {
      ip: req.ip,
      country,
    };
  });
}
