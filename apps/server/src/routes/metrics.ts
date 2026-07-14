// Arc 4 Wave 2.B sub-slice 8.18 (v2-#8) — GET /metrics Prometheus scrape.
//
// Scraped by VictoriaMetrics / Prometheus / Grafana Agent. The content
// type is `text/plain; version=0.0.4` per the exposition-format spec;
// scrapers reject anything else.
//
// Auth: bearer-token gated by METRICS_SCRAPE_TOKEN env var. The route
// is exposed publicly (so external scrapers can reach it without
// needing an internal-only path), but the token prevents unauthenticated
// readers from harvesting internal counters. The deploy bridge writes
// the token to /opt/driftstack/api/.env; the value is rotated on the
// same cadence as other internal credentials.
//
// If METRICS_SCRAPE_TOKEN is unset, the route returns 503 — surfaces a
// missing-config bug early rather than silently exposing internals.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { FeatureUnavailableError, UnauthorizedError } from '../lib/errors.js';
import type { MetricsRegistry } from '../services/metrics-registry.js';

export interface MetricsRoutesDeps {
  readonly registry: MetricsRegistry;
  readonly scrapeToken: string | null;
}

export function registerMetricsRoutes(app: FastifyInstance, deps: MetricsRoutesDeps): void {
  app.get('/metrics', async (req, reply) => {
    // Internal counters must never persist in browser/proxy caches, including
    // authenticated success responses (the app-wide /v1 hook does not cover
    // this infrastructure path).
    reply.header('cache-control', 'no-store');
    if (deps.scrapeToken === null || deps.scrapeToken.length === 0) {
      throw new FeatureUnavailableError('Metrics scraping is not configured.');
    }
    const authz = req.headers.authorization;
    const expected = `Bearer ${deps.scrapeToken}`;
    // Constant-time compare so the scrape token can't be recovered via
    // response-timing (matches lib/internal-fleet-auth + the timing-safe
    // cross-source invariant). timingSafeEqual throws on a length
    // mismatch, so length-guard first → uniform "unauthorized" outcome.
    const authzBuf = Buffer.from(typeof authz === 'string' ? authz : '', 'utf8');
    const expectedBuf = Buffer.from(expected, 'utf8');
    if (authzBuf.length !== expectedBuf.length || !timingSafeEqual(authzBuf, expectedBuf)) {
      reply.header('www-authenticate', 'Bearer realm="metrics"');
      throw new UnauthorizedError('Metrics scrape token missing or invalid.');
    }
    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return deps.registry.render();
  });
}
