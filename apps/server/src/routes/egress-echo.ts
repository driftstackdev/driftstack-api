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
// round-trip completing is the proof. Even a CF HARD-DROP (TCP reset / no
// HTTP response, when CF silently drops a flagged exit IP) is a PASS: the
// CONNECT/tunnel already proved egress reachability, so the probe treats a
// post-tunnel drop as tunnel-proven rather than blocking a working proxy.
// So this limit is intentionally left as-is for scraper resistance; it
// cannot throttle a real launch.
//
// Geo source: Cloudflare's `cf-ipcountry` edge header (the API is
// CF-fronted; trustProxy makes req.ip the real client). 'XX' (unknown)
// and 'T1' (Tor) sentinel values surface as null — never invented.

import type { FastifyInstance } from 'fastify';
import type { RateLimitStore } from '../services/rate-limit.js';
import { ipRateLimit } from '../middleware/ip-rate-limit.js';
import { resolveExitTimezone } from '../lib/exit-timezone.js';

export const EGRESS_ECHO_IP_LIMIT = { capacity: 12, refillPerSecond: 12 / 60 };

/** #128 — best-effort read of a Cloudflare visitor-location header (added by the
 *  "Add visitor location headers" managed transform). A non-empty trimmed string,
 *  else null. Absent when the transform is off or the edge couldn't resolve the
 *  exit IP — surfaced as null, never invented. */
function cfLocationHeader(raw: string | string[] | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v.length > 0 ? v : null;
}

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
    // #128 new-tab IP panel: best-effort exit geo from Cloudflare's location
    // headers. The server pre-launch probe reads these back THROUGH the proxy
    // (req.ip = proxy EXIT IP) to populate the box-local new-tab panel's
    // exit_identity. Absent (transform off / edge unresolved) ⇒ null. Additive
    // to the existing {ip,country} shape — device-side probe consumers ignore
    // the new fields.
    return {
      ip: req.ip,
      country,
      region: cfLocationHeader(req.headers['cf-region']),
      city: cfLocationHeader(req.headers['cf-ipcity']),
      // ⛔ NOT the raw header. `cf-timezone` arrives only with the "Add visitor
      // location headers" Managed Transform, which is off here — measured
      // 2026-09-02, this endpoint returned region/city/timezone ALL null while
      // country resolved fine, because country rides `cf-ipcountry` (every
      // plan) and the rest ride the transform. The harness falls back to the
      // archetype when this is null, and the launch archetype is
      // Europe/Istanbul, so every session worldwide rendered Turkey time
      // regardless of where it egressed. Resolve to the country's zone when the
      // edge cannot answer; still null when neither can, so "unknown" stays
      // visible rather than becoming a guess.
      timezone: resolveExitTimezone(cfLocationHeader(req.headers['cf-timezone']), country),
    };
  });
}
